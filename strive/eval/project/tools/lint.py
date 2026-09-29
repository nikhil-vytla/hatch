"""tally's lint. Run it with ./dev lint.

TL001  a line longer than 120 characters
TL002  a module's __all__ must list every public top-level name, sorted
TL003  trailing whitespace
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGES = ("tally", "tally_api")


def public_names(tree: ast.Module) -> list[str]:
    names = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(node.name)
        elif isinstance(node, ast.Assign):
            names += [t.id for t in node.targets if isinstance(t, ast.Name) and t.id.isupper()]
    return [n for n in names if not n.startswith("_")]


def declared_all(tree: ast.Module) -> list[str] | None:
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(t, ast.Name) and t.id == "__all__" for t in targets) and node.value is not None:
            return [e.value for e in node.value.elts if isinstance(e, ast.Constant)]
    return None


def lint(path: Path) -> list[str]:
    rel = path.relative_to(ROOT)
    text = path.read_text()
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        if len(line) > 120:
            problems.append(f"{rel}:{n}: TL001 line is {len(line)} characters (at most 120)")
        if line != line.rstrip():
            problems.append(f"{rel}:{n}: TL003 trailing whitespace")
    if "_generated" in path.parts:
        return problems
    tree = ast.parse(text)
    listed = declared_all(tree)
    if listed is None:
        problems.append(f"{rel}:1: TL002 no __all__")
        return problems
    for name in public_names(tree):
        if name not in listed:
            problems.append(f"{rel}:1: TL002 {name} is public but not in __all__")
    if listed != sorted(listed):
        problems.append(f"{rel}:1: TL002 __all__ isn't sorted")
    return problems


def main() -> int:
    problems = []
    for pkg in PACKAGES:
        for path in sorted((ROOT / pkg).rglob("*.py")):
            problems += lint(path)
    for p in problems:
        print(p)
    if problems:
        print(f"{len(problems)} problem{'s' if len(problems) != 1 else ''}")
        return 1
    print("lint: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
