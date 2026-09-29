"""Checks the changelog fragments in changes/. Run it with ./dev changes.

Every change to tally/ or tally_api/ adds a fragment:
changes/<slug>.<kind>.md, kind one of added, changed, fixed, removed, holding
one line: "- " and a sentence ending in a period. CHANGELOG.md is compiled
from the fragments at release.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.(added|changed|fixed|removed)\.md$")
KINDS = "added, changed, fixed or removed"


def changed_paths() -> list[str] | None:
    """Paths changed since the last commit, untracked ones included; None outside git."""
    r = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    return [line[3:].split(" -> ")[-1] for line in r.stdout.splitlines()]


def main() -> int:
    problems = []
    for path in sorted((ROOT / "changes").iterdir()):
        if path.name == "README.md":
            continue
        rel = path.relative_to(ROOT)
        if not NAME.match(path.name):
            problems.append(f"{rel}: name it changes/<slug>.<kind>.md, kind {KINDS}")
            continue
        lines = [line for line in path.read_text().splitlines() if line.strip()]
        if len(lines) != 1 or not lines[0].startswith("- ") or not lines[0].endswith("."):
            problems.append(f'{rel}: a fragment is one line: "- " and a sentence ending in a period')
    changed = changed_paths()
    if changed is None:
        print("changes: not a git checkout, so only the fragments' format was checked")
    else:
        code = [p for p in changed if p.startswith(("tally/", "tally_api/"))]
        fragments = [p for p in changed if p.startswith("changes/") and p != "changes/README.md"]
        if code and not fragments:
            problems.append(
                f"{code[0]} changed but no fragment was added: add changes/<slug>.<kind>.md, kind {KINDS}"
            )
    for p in problems:
        print(p)
    if problems:
        return 1
    print("changes: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
