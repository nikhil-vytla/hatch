"""Rebuilds the experiment index in README.md.

Each top-level folder with a README.md is an experiment. Its title is the
README's first heading, its date is the first commit that touched the folder,
and its summary is _summary.md if there is one, else the README's first
paragraph. A folder whose README says it "has moved to its own repository"
is listed as graduated. Run `python3 .github/index.py` to rewrite README.md,
or add `--check` to exit 1 when the index is stale.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
START, END = "<!-- index:start -->", "<!-- index:end -->"


def first_commit_date(folder: Path) -> str:
    out = subprocess.run(
        ["git", "log", "--reverse", "--format=%ad", "--date=short", "--", folder.name],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.split()
    return out[0] if out else "unknown"


def paragraphs(text: str) -> list[str]:
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text)]
    return [" ".join(b.split()) for b in blocks if b and not b.startswith(("#", "<!--", "```", "|", "-", "*", ">", "!["))]


def entry(folder: Path) -> dict:
    readme = (folder / "README.md").read_text()
    title = next((l[2:].strip() for l in readme.splitlines() if l.startswith("# ")), folder.name)
    summary_file = folder / "_summary.md"
    source = summary_file.read_text() if summary_file.exists() else readme
    summary = next(iter(paragraphs(source)), "")
    return {
        "name": folder.name,
        "title": title,
        "date": first_commit_date(folder),
        "summary": summary,
        "graduated": "has moved to its own repository" in readme,
    }


def render(entries: list[dict]) -> str:
    def line(e: dict) -> str:
        return f"### [{e['title']}]({e['name']}/) ({e['date']})\n\n{e['summary']}\n"

    active = [e for e in entries if not e["graduated"]]
    graduated = [e for e in entries if e["graduated"]]
    out = [f"{len(active)} experiments, newest first.\n"] + [line(e) for e in active]
    if graduated:
        out.append("## Graduated\n\nThese moved to their own repositories.\n")
        out += [f"- [{e['title']}]({e['name']}/) ({e['date']}): {e['summary']}" for e in graduated]
        out.append("")
    return "\n".join(out)


def main() -> int:
    folders = sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".") and (p / "README.md").exists())
    entries = sorted((entry(f) for f in folders), key=lambda e: e["date"], reverse=True)
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text()
    if START not in readme or END not in readme:
        print(f"README.md needs {START} and {END} markers", file=sys.stderr)
        return 2
    head, rest = readme.split(START, 1)
    _, tail = rest.split(END, 1)
    updated = f"{head}{START}\n{render(entries)}{END}{tail}"
    if "--check" in sys.argv:
        if updated != readme:
            print("README.md index is stale: run python3 .github/index.py", file=sys.stderr)
            return 1
        return 0
    if updated != readme:
        readme_path.write_text(updated)
        print(f"README.md: indexed {len(entries)} folders")
    return 0


if __name__ == "__main__":
    sys.exit(main())
