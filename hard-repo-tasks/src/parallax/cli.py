from __future__ import annotations

import argparse
import json
from pathlib import Path

from parallax.adapters import export_hud, export_verifiers, render_verifiers_taskset
from parallax.compiler import compile_recipe
from parallax.grading import grade_candidate
from parallax.models import Recipe, TaskManifest


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="parallax",
        description="Compile pinned repositories into counterfactual agent tasks.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("recipe", type=Path)
    compile_parser.add_argument("source", type=Path)
    compile_parser.add_argument("--out", type=Path, required=True)

    grade_parser = subparsers.add_parser("grade")
    grade_parser.add_argument("recipe", type=Path)
    grade_parser.add_argument("candidate", type=Path)
    grade_parser.add_argument("--out", type=Path)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("platform", choices=("hud", "verifiers"))
    export_parser.add_argument("artifacts", type=Path)
    export_parser.add_argument("manifests", nargs="+", type=Path)
    export_parser.add_argument("--out", type=Path, required=True)

    args = parser.parse_args()
    if args.command == "compile":
        recipe = Recipe.load(args.recipe)
        manifest = compile_recipe(recipe, args.source, args.out)
        print(json.dumps(manifest.to_dict(), indent=2))
        return
    if args.command == "grade":
        grade = grade_candidate(Recipe.load(args.recipe), args.candidate)
        if args.out:
            grade.dump(args.out)
        print(json.dumps(grade.to_dict(), indent=2, sort_keys=True))
        return

    manifests = [TaskManifest.load(path) for path in args.manifests]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.platform == "hud":
        export_hud(manifests, args.artifacts, args.out)
    else:
        export_verifiers(manifests, args.artifacts, args.out)
        (args.out.parent / "taskset.py").write_text(render_verifiers_taskset())


if __name__ == "__main__":
    main()
