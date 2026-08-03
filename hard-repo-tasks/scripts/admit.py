"""Compile recipes twice and challenge their graders with cheap baselines."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from parallax.compiler import compile_recipe
from parallax.grading import TreeSnapshot, grade_candidate
from parallax.models import Recipe
from parallax.patching import apply_edits


def run(argv: list[str], cwd: Path) -> None:
    subprocess.run(argv, cwd=cwd, check=True, capture_output=True)


def make_starter(source: Path, recipe: Recipe, destination: Path) -> None:
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".git"))
    omissions = set(recipe.starter_omissions)
    apply_edits(
        destination,
        tuple(edit for edit in recipe.implementation_edits if edit.id not in omissions),
    )
    run(["git", "init", "-q"], destination)
    run(["git", "config", "user.email", "admission@parallax.invalid"], destination)
    run(["git", "config", "user.name", "Parallax admission"], destination)
    run(["git", "add", "."], destination)
    run(["git", "commit", "-qm", "synthetic starter"], destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("recipe_dir", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    recipes = [Recipe.load(path) for path in sorted(args.recipe_dir.glob("*.json"))]
    report: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="parallax-admit-") as temp:
        temp_root = Path(temp)
        first_root = temp_root / "first"
        second_root = temp_root / "second"
        for index, recipe in enumerate(recipes):
            first = compile_recipe(recipe, args.source, first_root)
            second = compile_recipe(recipe, args.source, second_root)
            starter = temp_root / f"starter-{index}"
            make_starter(args.source, recipe, starter)
            baseline = TreeSnapshot.capture(starter, recipe.ignored_paths)
            starter_grade = grade_candidate(recipe, starter, baseline)

            oracle = temp_root / f"oracle-{index}"
            shutil.copytree(starter, oracle)
            omitted = set(recipe.starter_omissions)
            apply_edits(
                oracle,
                tuple(edit for edit in recipe.implementation_edits if edit.id in omitted),
            )
            oracle_grade = grade_candidate(recipe, oracle, baseline)

            restored = temp_root / f"restored-{index}"
            shutil.copytree(starter, restored)
            patch = first_root / first.task_id / "public" / "starter.patch"
            run(["git", "apply", "--reverse", str(patch)], restored)
            restored_grade = grade_candidate(recipe, restored, baseline)

            tampered = temp_root / f"tampered-{index}"
            shutil.copytree(oracle, tampered)
            (tampered / "parallax_reward_override.txt").write_text("1.0")
            tampered_grade = grade_candidate(recipe, tampered, baseline)

            report.append(
                {
                    "task_id": first.task_id,
                    "recipe": recipe.name,
                    "deterministic": (
                        first.task_id == second.task_id
                        and first.starter_patch_sha256 == second.starter_patch_sha256
                    ),
                    "no_op_reward": starter_grade.reward,
                    "upstream_restore_reward": restored_grade.reward,
                    "oracle_reward": oracle_grade.reward,
                    "forbidden_path_reward": tampered_grade.reward,
                    "oracle_changed_paths": list(oracle_grade.changed_paths),
                    "oracle_components": [
                        {
                            "name": component.name,
                            "category": component.category,
                            "value": component.value,
                            "weight": component.weight,
                        }
                        for component in oracle_grade.components
                    ],
                }
            )

    summary = {
        "tasks": len(report),
        "all_deterministic": all(bool(row["deterministic"]) for row in report),
        "all_no_op_rejected": all(row["no_op_reward"] == 0 for row in report),
        "all_upstream_restores_rejected": all(
            row["upstream_restore_reward"] == 0 for row in report
        ),
        "all_oracles_pass": all(row["oracle_reward"] == 1 for row in report),
        "all_forbidden_paths_rejected": all(
            row["forbidden_path_reward"] == 0 for row in report
        ),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"summary": summary, "tasks": report}, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    if not all(summary.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
