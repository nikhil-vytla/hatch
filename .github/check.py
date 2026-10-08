"""Checks the experiment folders. Run `python3 .github/check.py [BASE]`.

- Every top-level folder has a README.md that starts with a `# Title`.
- Every experiment has a `_summary.md` (run the summarize skill). Folders whose
  README says they moved to their own repository are exempt.
- No tracked file looks like it holds a secret.
- No tracked file contains a denylisted word. The list is kept outside this public
  repository: the HATCH_DENYLIST environment variable (a CI secret), else
  ~/.config/hatch/denylist, one word per line. Failures never print the word.
- Files changed since BASE (a git ref, e.g. the PR's base) are at most 2 MB.
  Older files are left alone.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 2 * 1024 * 1024
GRADUATED = "has moved to its own repository"
SECRET = re.compile(
    r"sk-ant-[\w-]{20,}|sk-proj-[\w-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_\w{30,}"
    r"|github_pat_\w{30,}|xox[bp]-[\w-]{20,}|hf_\w{30,}|AIza[\w-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY"
)


def git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def denylist() -> list[str]:
    text = os.environ.get("HATCH_DENYLIST", "")
    local = Path.home() / ".config" / "hatch" / "denylist"
    if not text and local.exists():
        text = local.read_text()
    return [w.strip().lower() for w in text.splitlines() if w.strip()]


def main() -> int:
    problems = []

    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".")):
        readme = folder / "README.md"
        if not readme.exists():
            problems.append(f"{folder.name}/: no README.md")
            continue
        text = readme.read_text()
        if not text.lstrip().startswith("# "):
            problems.append(f"{folder.name}/README.md: start it with a '# Title'")
        if GRADUATED not in text and not (folder / "_summary.md").exists():
            problems.append(f"{folder.name}/: no _summary.md (run the summarize skill)")

    banned = denylist()
    for path in git("ls-files"):
        file = ROOT / path
        if not file.is_file():
            continue
        try:
            body = file.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        if SECRET.search(body):
            problems.append(f"{path}: looks like it holds a secret")
        lowered = body.lower()
        if any(re.search(rf"\b{re.escape(w)}\b", lowered) for w in banned):
            problems.append(f"{path}: contains a denylisted word")

    if len(sys.argv) > 1:
        for path in git("diff", "--name-only", "--diff-filter=AM", f"{sys.argv[1]}...HEAD"):
            file = ROOT / path
            if file.is_file() and file.stat().st_size > MAX_BYTES:
                problems.append(f"{path}: over 2 MB")

    print("\n".join(problems) if problems else "ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
