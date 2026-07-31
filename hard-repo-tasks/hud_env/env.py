"""HUD v6 environment for live Parallax calibration."""

from __future__ import annotations

import asyncio
import base64
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from hud.environment import Environment
from hud.graders import EvaluationResult, SubScore

EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENT_ROOT / "src"))

from parallax.grading import grade_candidate  # noqa: E402
from parallax.models import Recipe  # noqa: E402

env = Environment(name="parallax_repo", version="0.1.0")
WORKSPACE = Path(tempfile.mkdtemp(prefix="hud-parallax-repo-"))
env.workspace(
    WORKSPACE,
    network=False,
    track_files=True,
    env={"HOME": str(WORKSPACE), "PARALLAX_WORKSPACE": str(WORKSPACE)},
)


def _run(argv: list[str], cwd: Path) -> None:
    subprocess.run(argv, cwd=cwd, check=True, capture_output=True)


def _prepare(
    source: str,
    revision: str,
    starter_patch_b64: str,
) -> None:
    for child in WORKSPACE.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    _run(["git", "clone", "--quiet", "--no-checkout", source, str(WORKSPACE)], WORKSPACE)
    _run(["git", "checkout", "--quiet", revision], WORKSPACE)
    patch = base64.b64decode(starter_patch_b64)
    patch_path = WORKSPACE / ".parallax-starter.patch"
    patch_path.write_bytes(patch)
    _run(["git", "apply", str(patch_path)], WORKSPACE)
    patch_path.unlink()
    (WORKSPACE / "AGENTS.md").write_text(
        "# Task workspace\n\n"
        "The repository root is the current working directory. Search only inside it. "
        "Never traverse `/`, parent directories, or the host filesystem.\n"
    )

    # Remove upstream history and remote metadata. The model receives a
    # one-commit starter repository, so git lookup cannot reveal the answer.
    shutil.rmtree(WORKSPACE / ".git")
    _run(["git", "init", "--quiet"], WORKSPACE)
    _run(["git", "config", "user.email", "task@parallax.invalid"], WORKSPACE)
    _run(["git", "config", "user.name", "Parallax task"], WORKSPACE)
    _run(["git", "add", "."], WORKSPACE)
    _run(["git", "commit", "--quiet", "-m", "synthetic starter"], WORKSPACE)


def _grade(recipe_name: str):
    candidates = [
        path
        for path in (EXPERIMENT_ROOT / "recipes" / "click").glob("*.json")
        if Recipe.load(path).name == recipe_name
    ]
    if len(candidates) != 1:
        raise ValueError(f"expected one trusted recipe named {recipe_name!r}")
    return grade_candidate(Recipe.load(candidates[0]), WORKSPACE)


@env.template(id="repair")
async def repair(
    task_id: str,
    source: str,
    revision: str,
    prompt: str,
    starter_patch_b64: str,
    recipe_name: str,
):
    await asyncio.to_thread(_prepare, source, revision, starter_patch_b64)
    _answer = yield (
        prompt
        + "\n\nThe repository root is your current working directory. "
        "Do not search outside it or traverse `/`."
    )
    grade = await asyncio.to_thread(_grade, recipe_name)
    children = [
        SubScore(
            name=component.name,
            value=component.value,
            weight=0.0,
            info={
                "category": component.category,
                "returncode": component.evidence.get("returncode"),
            },
        )
        for component in grade.components
    ]
    yield EvaluationResult(
        reward=grade.reward,
        content=f"gated reward={grade.reward:.3f}",
        info={
            "task_id": task_id,
            "integrity_gate": grade.integrity_gate,
            "changed_paths": list(grade.changed_paths),
            "violations": list(grade.violations),
        },
        subscores=[
            SubScore(
                name="gated_outcome",
                value=grade.reward,
                weight=1.0,
                children=children,
            )
        ],
    )
