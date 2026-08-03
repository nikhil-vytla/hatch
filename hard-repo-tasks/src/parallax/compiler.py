from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from parallax.checks import run_check
from parallax.ids import digest_value, task_id_for
from parallax.models import CheckCategory, Recipe, TaskManifest
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

        gold_results = [run_check(gold, check) for check in recipe.checks]
        starter_results = [run_check(starter, check) for check in recipe.checks]
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
            if result["category"] == CheckCategory.REGRESSION.value and not result["passed"]
        ]
        if regression_failures:
            raise CompilationError(
                f"starter breaks baseline regression checks: {regression_failures}"
            )

        implementation_paths = tuple(edit.path for edit in recipe.implementation_edits)
        starter_patch = make_patch(base, starter, implementation_paths)
        gold_paths = tuple(
            dict.fromkeys(
                edit.path for edit in (*recipe.implementation_edits, *recipe.probe_edits)
            )
        )
        gold_patch = make_patch(base, gold, gold_paths)
        starter_patch_sha256 = sha256_text(starter_patch)
        gold_patch_sha256 = sha256_text(gold_patch)
        public_digest = digest_value(
            {
                "recipe_name": recipe.name,
                "source": {
                    "locator": recipe.source.locator,
                    "revision": recipe.source.revision,
                    "license": recipe.source.license,
                },
                "prompt": recipe.prompt,
                "starter_patch_sha256": starter_patch_sha256,
                "generator_version": recipe.generator_version,
                "behavior_tags": recipe.behavior_tags,
                "allowed_paths": recipe.allowed_paths,
                "ignored_paths": recipe.ignored_paths,
            }
        )
        sealed_digest = digest_value(
            {
                "recipe": recipe.to_dict(),
                "gold_patch_sha256": gold_patch_sha256,
            }
        )
        task_id = task_id_for(public_digest, sealed_digest)
        manifest = TaskManifest(
            task_id=task_id,
            public_digest=public_digest,
            sealed_digest=sealed_digest,
            recipe_name=recipe.name,
            source=recipe.source,
            prompt=recipe.prompt,
            starter_patch_sha256=starter_patch_sha256,
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
