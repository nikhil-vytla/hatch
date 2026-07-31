from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from parallax.models import Check, Recipe, TaskManifest
from parallax.patching import apply_edits, make_patch, sha256_text


class CompilationError(RuntimeError):
    """A recipe failed its executable admission checks."""


def compile_recipe(recipe: Recipe, source_root: Path, output_root: Path) -> TaskManifest:
    _assert_revision(source_root, recipe.source.revision)
    omitted = set(recipe.starter_omissions)
    edit_ids = {edit.id for edit in recipe.implementation_edits}
    if unknown := omitted - edit_ids:
        raise CompilationError(f"unknown starter omission ids: {sorted(unknown)}")

    with tempfile.TemporaryDirectory(prefix="parallax-compile-") as temp:
        temp_root = Path(temp)
        base = temp_root / "base"
        gold = temp_root / "gold"
        starter = temp_root / "starter"
        _copy_source(source_root, base)
        _copy_source(source_root, gold)
        _copy_source(source_root, starter)

        apply_edits(gold, recipe.implementation_edits)
        apply_edits(gold, recipe.probe_edits)
        starter_edits = tuple(
            edit for edit in recipe.implementation_edits if edit.id not in omitted
        )
        apply_edits(starter, starter_edits)

        gold_results = [_run_check(gold, check) for check in recipe.checks]
        starter_results = [_run_check(starter, check) for check in recipe.checks]
        if not all(result["passed"] for result in gold_results):
            failures = [result for result in gold_results if not result["passed"]]
            raise CompilationError(
                "gold world failed checks:\n" + json.dumps(failures, indent=2, sort_keys=True)
            )
        if all(result["passed"] for result in starter_results):
            raise CompilationError("starter world passes every check; task has no observable gap")
        regression_failures = [
            result["name"]
            for result in starter_results
            if result["category"] == "regression" and not result["passed"]
        ]
        if regression_failures:
            raise CompilationError(
                f"starter breaks baseline regression checks: {regression_failures}"
            )

        implementation_paths = tuple(edit.path for edit in recipe.implementation_edits)
        starter_patch = make_patch(base, starter, implementation_paths)
        gold_patch = make_patch(base, gold, implementation_paths)
        canonical = json.dumps(recipe.to_dict(), sort_keys=True, separators=(",", ":"))
        task_id = hashlib.sha256(canonical.encode()).hexdigest()[:16]
        manifest = TaskManifest(
            task_id=task_id,
            recipe_name=recipe.name,
            source=recipe.source,
            prompt=recipe.prompt,
            starter_patch_sha256=sha256_text(starter_patch),
            generator_version=recipe.generator_version,
            behavior_tags=recipe.behavior_tags,
            allowed_paths=recipe.allowed_paths,
        )

        public = output_root / task_id / "public"
        sealed = output_root / task_id / "sealed"
        public.mkdir(parents=True, exist_ok=True)
        sealed.mkdir(parents=True, exist_ok=True)
        manifest.dump(public / "manifest.json")
        (public / "starter.patch").write_text(starter_patch)
        (sealed / "gold.patch").write_text(gold_patch)
        (sealed / "recipe.json").write_text(
            json.dumps(recipe.to_dict(), indent=2, sort_keys=True) + "\n"
        )
        (sealed / "admission.json").write_text(
            json.dumps(
                {
                    "gold": gold_results,
                    "starter": starter_results,
                    "gold_tree_digest": _tree_digest(gold),
                    "starter_tree_digest": _tree_digest(starter),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        return manifest


def run_check(root: Path, check: Check) -> dict[str, object]:
    return _run_check(root, check)


def _run_check(root: Path, check: Check) -> dict[str, object]:
    env = os.environ.copy()
    env.update(check.env)
    try:
        completed = subprocess.run(
            check.argv,
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=check.timeout_seconds,
            check=False,
        )
        return {
            "name": check.name,
            "category": check.category,
            "passed": completed.returncode == 0,
            "returncode": completed.returncode,
            "stdout": completed.stdout[-4000:],
            "stderr": completed.stderr[-4000:],
        }
    except subprocess.TimeoutExpired as error:
        return {
            "name": check.name,
            "category": check.category,
            "passed": False,
            "returncode": None,
            "stdout": (error.stdout or "")[-4000:],
            "stderr": (error.stderr or "")[-4000:],
            "timeout": True,
        }


def _assert_revision(root: Path, expected: str) -> None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    actual = completed.stdout.strip()
    if actual != expected:
        raise CompilationError(f"source revision mismatch: expected {expected}, got {actual}")
    dirty = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if dirty:
        raise CompilationError("source repository must be clean")


def _copy_source(source: Path, destination: Path) -> None:
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", ".pytest_cache"),
    )


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()
