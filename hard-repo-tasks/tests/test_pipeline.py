from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from parallax.adapters import export_hud, export_verifiers, render_verifiers_taskset
from parallax.calibration import RolloutObservation, decide_curriculum
from parallax.compiler import compile_recipe
from parallax.grading import TreeSnapshot, grade_candidate
from parallax.ids import digest_value
from parallax.models import Check, CheckCategory, Recipe, SourceSpec, TextEdit
from parallax.patching import EditError, apply_edits


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _source(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "source"
    root.mkdir()
    (root / "policy.py").write_text(
        'KNOWN = {"sys"}\n\n\ndef resolve(value):\n    return value if value in KNOWN else None\n'
    )
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "fixture")
    return root, _git(root, "rev-parse", "HEAD")


def _check(name: str, code: str, weight: float, category: CheckCategory) -> Check:
    marker = digest_value({"name": name, "category": category.value, "semantics": code})
    return Check(
        name=name,
        argv=("python", "-c", f"{code}\nprint({marker!r})"),
        weight=weight,
        category=category,
        success_marker=marker,
    )


def _recipe(revision: str) -> Recipe:
    return Recipe(
        name="counterfactual-policy",
        source=SourceSpec("fixture", revision, "MIT"),
        prompt="Finish the adaptive policy.",
        implementation_edits=(
            TextEdit(
                id="declare",
                path="policy.py",
                before='KNOWN = {"sys"}',
                after='KNOWN = {"sys", "adaptive"}',
            ),
            TextEdit(
                id="implement",
                path="policy.py",
                before="    return value if value in KNOWN else None",
                after=(
                    '    if value == "adaptive":\n'
                    '        return "sys"\n'
                    "    return value if value in KNOWN else None"
                ),
            ),
        ),
        starter_omissions=("implement",),
        probe_edits=(),
        checks=(
            _check(
                "regression",
                'import policy; assert policy.resolve("sys") == "sys"',
                0.2,
                CheckCategory.REGRESSION,
            ),
            _check(
                "contract",
                'import policy; assert policy.resolve("adaptive") == "sys"',
                0.8,
                CheckCategory.COUNTERFACTUAL,
            ),
        ),
        allowed_paths=("policy.py",),
        ignored_paths=(
            ".cache/pip/**",
            "**/__pycache__/**",
            "**/.pytest_cache/**",
            ".coverage",
        ),
        behavior_tags=("scope-control",),
    )


def _candidate(
    source: Path,
    recipe: Recipe,
    root: Path,
    complete: bool,
) -> tuple[Path, TreeSnapshot]:
    shutil.copytree(source, root, ignore=shutil.ignore_patterns(".git"))
    apply_edits(root, recipe.implementation_edits[:1])
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "starter")
    baseline = TreeSnapshot.capture(root, recipe.ignored_paths)
    if complete:
        apply_edits(root, (recipe.implementation_edits[1],))
    return root, baseline


def test_compile_is_deterministic_and_separates_public_from_sealed(tmp_path: Path) -> None:
    source, revision = _source(tmp_path)
    recipe = _recipe(revision)
    first = compile_recipe(recipe, source, tmp_path / "first")
    second = compile_recipe(recipe, source, tmp_path / "second")

    assert first.task_id == second.task_id
    first_public = tmp_path / "first" / first.task_id / "public"
    second_public = tmp_path / "second" / second.task_id / "public"
    assert (first_public / "starter.patch").read_text() == (
        second_public / "starter.patch"
    ).read_text()
    assert "adaptive" in (first_public / "starter.patch").read_text()
    assert not (first_public / "recipe.json").exists()
    admission = json.loads(
        (tmp_path / "first" / first.task_id / "sealed" / "admission.json").read_text()
    )
    assert all(check["passed"] for check in admission["gold"])
    assert any(not check["passed"] for check in admission["starter"])

    prompt_recipe = replace(recipe, prompt="A different public prompt.")
    prompt_manifest = compile_recipe(prompt_recipe, source, tmp_path / "prompt")
    assert prompt_manifest.task_id != first.task_id

    changed_contract = _check(
        "contract",
        'import policy; assert policy.resolve("adaptive") in {"sys", "fd"}',
        0.8,
        CheckCategory.COUNTERFACTUAL,
    )
    sealed_recipe = replace(recipe, checks=(recipe.checks[0], changed_contract))
    sealed_manifest = compile_recipe(sealed_recipe, source, tmp_path / "sealed-change")
    assert sealed_manifest.task_id != first.task_id

    with pytest.raises(ValueError, match="task_id mismatch"):
        replace(first, task_id="0" * 64)
    with pytest.raises(ValueError, match="public_digest"):
        replace(first, public_digest="short")


def test_grading_gates_contract_and_forbidden_paths(tmp_path: Path) -> None:
    source, revision = _source(tmp_path)
    recipe = _recipe(revision)

    oracle_candidate, oracle_baseline = _candidate(
        source, recipe, tmp_path / "oracle", complete=True
    )
    assert grade_candidate(recipe, oracle_candidate, oracle_baseline).reward == 1.0
    failed_gate = _check(
        "adversarial",
        "raise AssertionError('hard gate')",
        1.0,
        CheckCategory.ADVERSARIAL,
    )
    gated_recipe = replace(recipe, checks=(*recipe.checks, failed_gate))
    assert grade_candidate(gated_recipe, oracle_candidate, oracle_baseline).reward == 0.0

    cache_only, cache_baseline = _candidate(
        source, recipe, tmp_path / "cache-only", complete=True
    )
    cache_path = cache_only / ".cache" / "pip" / "http-v2" / "artifact"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("ephemeral")
    assert grade_candidate(recipe, cache_only, cache_baseline).reward == 1.0

    tampered, tampered_baseline = _candidate(
        source, recipe, tmp_path / "tampered", complete=True
    )
    (tampered / "unrelated.txt").write_text("reward hack")
    grade = grade_candidate(recipe, tampered, tampered_baseline)
    assert grade.reward == 0.0
    assert grade.integrity_gate == 0.0

    incomplete, incomplete_baseline = _candidate(
        source, recipe, tmp_path / "incomplete", complete=False
    )
    assert grade_candidate(recipe, incomplete, incomplete_baseline).reward == 0.0


def test_exports_match_platform_public_contracts(tmp_path: Path) -> None:
    source, revision = _source(tmp_path)
    recipe = _recipe(revision)
    artifacts = tmp_path / "artifacts"
    manifest = compile_recipe(recipe, source, artifacts)

    hud_path = tmp_path / "hud.json"
    export_hud([manifest], artifacts, hud_path)
    hud_row = json.loads(hud_path.read_text())[0]
    assert hud_row["env"] == "parallax_repo"
    assert hud_row["id"] == "repair"
    assert "gold" not in json.dumps(hud_row)

    vf_path = tmp_path / "tasks.jsonl"
    export_verifiers([manifest], artifacts, vf_path)
    vf_row = json.loads(vf_path.read_text())
    assert vf_row["task_id"] == manifest.task_id
    compile(render_verifiers_taskset(), "taskset.py", "exec")


def test_generated_click_recipes_use_explicit_markers_and_ignore_policy() -> None:
    root = Path(__file__).resolve().parents[1]
    recipes = [
        Recipe.load(path) for path in sorted((root / "recipes" / "click").glob("*.json"))
    ]

    assert len(recipes) == 12
    for recipe in recipes:
        assert recipe.ignored_paths
        assert all(check.success_marker in check.argv[-1] for check in recipe.checks)


def test_edit_requires_exact_pinned_context(tmp_path: Path) -> None:
    target = tmp_path / "file.py"
    target.write_text("same\nsame\n")
    with pytest.raises(EditError, match="expected 1 occurrence"):
        apply_edits(
            tmp_path,
            (TextEdit("ambiguous", "file.py", "same", "different"),),
        )


def test_curriculum_rejects_semantically_saturated_family() -> None:
    observations = [
        RolloutObservation("a", "gpt", "strong", "completed", 1.0, 1.0),
        RolloutObservation("a", "gpt", "strong", "completed", 1.0, 1.0),
        RolloutObservation("a", "weak", "weak", "completed", 0.0, 1.0),
    ]
    decision = decide_curriculum(observations)
    assert decision.action == "harden"
    assert decision.strong_semantic_rate == 1.0
    assert "add cross-module state propagation" in decision.next_transforms


def test_knowledge_base_metadata_and_links() -> None:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "scripts/check_knowledge.py"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
