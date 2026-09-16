"""Check relative markdown links resolve, plus heading anchors and math syntax."""

from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

LINK = re.compile(r"(?<!!)\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*$", re.MULTILINE)
FENCE = re.compile(r"^```", re.MULTILINE)


def slug(text: str) -> str:
    text = re.sub(r"`|\*|_|\[|\]|\(|\)|\\", "", text)
    text = unicodedata.normalize("NFKD", text)
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def headings(path: Path) -> set[str]:
    if not path.is_file() or path.suffix != ".md":
        return set()
    return {slug(m.group(2)) for m in HEADING.finditer(path.read_text(encoding="utf-8"))}


def main(root_arg: str) -> int:
    root = Path(root_arg).resolve()
    problems: list[str] = []
    for md in sorted(root.rglob("*.md")):
        if any(part in {".venv", "node_modules", ".git"} for part in md.parts):
            continue
        text = md.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            target = match.group(1)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            anchor = ""
            if "#" in target:
                target, anchor = target.split("#", 1)
            base = md.parent if target else md
            resolved = (base / target).resolve() if target else md
            if not resolved.exists():
                problems.append(f"{md.relative_to(root)}: missing path {match.group(1)}")
                continue
            if anchor and resolved.suffix == ".md" and anchor not in headings(resolved):
                problems.append(f"{md.relative_to(root)}: missing anchor {match.group(1)}")

        # Math must stay in GitHub-renderable form. Inline code spans that quote
        # the old delimiters are talking about them, not using them.
        for num, line in enumerate(text.split("\n"), 1):
            outside = re.sub(r"`[^`]*`", "", line)
            if r"\(" in outside or r"\)" in outside:
                problems.append(f"{md.relative_to(root)}:{num}: latex \\( \\) delimiter")
        for num, line in enumerate(text.split("\n"), 1):
            outside = re.sub(r"`[^`]*`", "", line)
            if re.search(r"(?<!\w)\\\[|(?<!\w)\\\]", outside):
                problems.append(f"{md.relative_to(root)}:{num}: latex \\[ \\] delimiter")
        if FENCE.findall(text) and len(FENCE.findall(text)) % 2:
            problems.append(f"{md.relative_to(root)}: odd number of code fences")

    for line in problems:
        print(line)
    print(f"{len(problems)} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
