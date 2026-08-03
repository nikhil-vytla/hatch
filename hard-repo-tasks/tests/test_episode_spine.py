from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

import pytest

from parallax.checks import run_check
from parallax.grading import GradeOutcome, TreeSnapshot, grade_candidate
from parallax.ids import digest_value
from parallax.models import Check, CheckCategory, Recipe, SourceSpec, TextEdit


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _candidate(tmp_path: Path) -> Path:
    root = tmp_path / "candidate"
    root.mkdir()
    (root / "policy.py").write_text("VALUE = 1\n")
    (root / "forbidden.txt").write_text("original\n")
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "starter")
    return root


def _recipe(*, probe_edits: tuple[TextEdit, ...] = ()) -> Recipe:
    code = "import policy; assert policy.VALUE == 1"
    marker = digest_value({"name": "contract", "semantics": code})
    return Recipe(
        name="episode-spine",
        source=SourceSpec("fixture", "revision", "MIT"),
        prompt="Implement the policy.",
        implementation_edits=(),
        starter_omissions=(),
        probe_edits=probe_edits,
        checks=(
            Check(
                name="contract",
                argv=("python", "-c", f"{code}\nprint({marker!r})"),
                weight=1.0,
                category=CheckCategory.COUNTERFACTUAL,
                success_marker=marker,
            ),
        ),
        allowed_paths=("policy.py",),
        ignored_paths=("**/__pycache__/**",),
    )


def test_import_time_exit_without_success_marker_scores_zero(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    baseline = TreeSnapshot.capture(candidate, _recipe().ignored_paths)
    (candidate / "policy.py").write_text("import os; os._exit(0)\n")

    assert grade_candidate(_recipe(), candidate, baseline).reward == 0.0


def test_committed_forbidden_mutation_scores_zero(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    baseline = TreeSnapshot.capture(candidate, _recipe().ignored_paths)
    (candidate / "forbidden.txt").write_text("tampered\n")
    _git(candidate, "add", "forbidden.txt")
    _git(candidate, "commit", "-qm", "hide forbidden mutation")

    assert grade_candidate(_recipe(), candidate, baseline).reward == 0.0


def test_forbidden_mutation_without_git_never_raises_or_abstains(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    baseline = TreeSnapshot.capture(candidate, _recipe().ignored_paths)
    (candidate / "forbidden.txt").write_text("tampered\n")
    shutil.rmtree(candidate / ".git")

    grade = grade_candidate(_recipe(), candidate, baseline)

    assert grade.reward == 0.0
    assert grade.outcome is not GradeOutcome.ABSTAIN


def test_probe_anchor_tamper_is_invalid_submission(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    baseline = TreeSnapshot.capture(candidate, _recipe().ignored_paths)
    candidate.joinpath("policy.py").write_text("VALUE = 2\n")
    recipe = _recipe(
        probe_edits=(
            TextEdit("probe", "policy.py", "VALUE = 1", "VALUE = 1\nPROBE = True"),
        )
    )

    grade = grade_candidate(recipe, candidate, baseline)

    assert grade.reward == 0.0
    assert grade.outcome is GradeOutcome.INVALID_SUBMISSION


def test_broken_evaluator_baseline_is_not_model_zero(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    candidate.joinpath("policy.py").write_text("VALUE = 2\n")
    recipe = _recipe(
        probe_edits=(
            TextEdit("probe", "policy.py", "VALUE = 1", "VALUE = 1\nPROBE = True"),
        )
    )
    baseline = TreeSnapshot.capture(candidate, recipe.ignored_paths)

    with pytest.raises(RuntimeError, match="evaluator baseline"):
        grade_candidate(recipe, candidate, baseline)


def test_missing_baseline_file_is_invalid_submission(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    recipe = _recipe()
    baseline = TreeSnapshot.capture(candidate, recipe.ignored_paths)
    (candidate / "policy.py").unlink()

    grade = grade_candidate(recipe, candidate, baseline)

    assert grade.outcome is GradeOutcome.INVALID_SUBMISSION
    assert grade.reward == 0.0


def test_escaping_symlink_is_invalid_submission(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    recipe = _recipe()
    baseline = TreeSnapshot.capture(candidate, recipe.ignored_paths)
    (candidate / "escape").symlink_to("/etc/passwd")

    grade = grade_candidate(recipe, candidate, baseline)

    assert grade.outcome is GradeOutcome.INVALID_SUBMISSION
    assert grade.reward == 0.0


@pytest.mark.parametrize("weight", [0.0, -1.0, math.nan, math.inf, -math.inf])
def test_check_rejects_non_positive_or_non_finite_weight(weight: float) -> None:
    with pytest.raises(ValueError, match="finite and positive"):
        Check(
            name="invalid",
            argv=("python", "-c", "pass"),
            weight=weight,
            category=CheckCategory.COUNTERFACTUAL,
            success_marker="a" * 64,
        )


def test_recipe_requires_counterfactual_primary() -> None:
    check = Check(
        name="regression",
        argv=("python", "-c", f"print({'b' * 64!r})"),
        weight=1.0,
        category=CheckCategory.REGRESSION,
        success_marker="b" * 64,
    )
    with pytest.raises(ValueError, match="counterfactual"):
        Recipe(
            name="missing-primary",
            source=SourceSpec("fixture", "revision"),
            prompt="Prompt",
            implementation_edits=(),
            starter_omissions=(),
            probe_edits=(),
            checks=(check,),
            allowed_paths=("policy.py",),
        )


def test_ignored_paths_are_explicit_policy_not_host_special_cases() -> None:
    recipe = _recipe()
    assert hasattr(recipe, "ignored_paths")
    assert all("Library/Caches" not in pattern for pattern in recipe.ignored_paths)


def test_check_requires_non_empty_success_marker() -> None:
    with pytest.raises(ValueError, match="success marker"):
        Check(
            name="missing-marker",
            argv=("python", "-c", "pass"),
            weight=1.0,
            category=CheckCategory.COUNTERFACTUAL,
            success_marker="",
        )


def test_check_environment_is_allowlisted_and_home_is_external(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    marker = "c" * 64
    code = (
        "import os\n"
        "from pathlib import Path\n"
        "assert 'OPENAI_API_KEY' not in os.environ\n"
        "assert Path(os.environ['HOME']) != Path.cwd()\n"
        f"print({marker!r})"
    )
    check = Check(
        name="clean-environment",
        argv=("python", "-c", code),
        weight=1.0,
        category=CheckCategory.COUNTERFACTUAL,
        success_marker=marker,
    )
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-leak")

    assert run_check(tmp_path, check)["passed"] is True


@pytest.mark.parametrize("value", [{1: "bad"}, object(), b"bytes", math.nan])
def test_canonical_serialization_rejects_unsupported_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        digest_value(value)  # type: ignore[arg-type]
