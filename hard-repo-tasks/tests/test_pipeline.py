from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from parallax.adapters import export_hud, export_verifiers, render_verifiers_taskset
from parallax.compiler import compile_recipe
from parallax.grading import grade_candidate
from parallax.models import Check, Recipe, SourceSpec, TextEdit
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
            Check(
                name="regression",
                argv=("python", "-c", 'import policy; assert policy.resolve("sys") == "sys"'),
                weight=0.2,
                category="regression",
            ),
            Check(
                name="contract",
                argv=(
                    "python",
                    "-c",
                    'import policy; assert policy.resolve("adaptive") == "sys"',
                ),
                weight=0.8,
                category="counterfactual",
            ),
        ),
        allowed_paths=("policy.py",),
        behavior_tags=("scope-control",),
    )


def _candidate(source: Path, recipe: Recipe, root: Path, complete: bool) -> Path:
    shutil.copytree(source, root, ignore=shutil.ignore_patterns(".git"))
    apply_edits(root, recipe.implementation_edits[:1])
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "starter")
    if complete:
        apply_edits(root, (recipe.implementation_edits[1],))
    return root


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


def test_grading_gates_contract_and_forbidden_paths(tmp_path: Path) -> None:
    source, revision = _source(tmp_path)
    recipe = _recipe(revision)

    no_op = _candidate(source, recipe, tmp_path / "no-op", complete=True)
    assert grade_candidate(recipe, no_op).reward == 1.0

    tampered = _candidate(source, recipe, tmp_path / "tampered", complete=True)
    (tampered / "unrelated.txt").write_text("reward hack")
    grade = grade_candidate(recipe, tampered)
    assert grade.reward == 0.0
    assert grade.integrity_gate == 0.0

    incomplete = tmp_path / "incomplete"
    shutil.copytree(source, incomplete, ignore=shutil.ignore_patterns(".git"))
    apply_edits(incomplete, recipe.implementation_edits[:1])
    _git(incomplete, "init", "-q")
    _git(incomplete, "config", "user.email", "test@example.com")
    _git(incomplete, "config", "user.name", "Test")
    _git(incomplete, "add", ".")
    _git(incomplete, "commit", "-qm", "starter")
    assert grade_candidate(recipe, incomplete).reward == 0.0


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


def test_edit_requires_exact_pinned_context(tmp_path: Path) -> None:
    target = tmp_path / "file.py"
    target.write_text("same\nsame\n")
    with pytest.raises(EditError, match="expected 1 occurrence"):
        apply_edits(
            tmp_path,
            (TextEdit("ambiguous", "file.py", "same", "different"),),
        )
