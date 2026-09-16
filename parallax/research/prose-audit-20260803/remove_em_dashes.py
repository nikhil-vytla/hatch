"""Mechanical em-dash removal pass. Output is reviewed by hand afterward."""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Words that start an independent clause often enough that a period reads better
# than a comma at the splice point.
CLAUSE_STARTERS = {
    "it",
    "its",
    "there",
    "this",
    "that",
    "they",
    "we",
    "i",
    "you",
    "nothing",
    "no",
    "none",
    "each",
    "both",
    "every",
    "dropping",
    "reference",
    "upstream",
    "parallax",
    "here",
    "hand",
}

HEADING = re.compile(r"^(#{1,6} [^\n]*?) — ")
CODE_LEAD = re.compile(r"^(\s*[-*] `[^`]+`) — ")
BOLD_LEAD = re.compile(r"^(\s*[-*] \*\*[^*]+\*\*) — ")
INLINE = re.compile(r" — ")


def splice(match_tail: str) -> str:
    first = re.match(r"[`*_\"']*([A-Za-z]+)", match_tail)
    word = first.group(1).lower() if first else ""
    if word in CLAUSE_STARTERS:
        return ". "
    return ", "


def fix_line(line: str) -> str:
    line = HEADING.sub(r"\1: ", line)
    line = CODE_LEAD.sub(r"\1: ", line)
    line = BOLD_LEAD.sub(r"\1: ", line)
    out: list[str] = []
    rest = line
    while True:
        m = INLINE.search(rest)
        if m is None:
            out.append(rest)
            break
        out.append(rest[: m.start()])
        tail = rest[m.end() :]
        sep = splice(tail)
        if sep == ". ":
            tail = tail[:1].upper() + tail[1:]
        out.append(sep)
        rest = tail
    return "".join(out)


def main(paths: list[str]) -> int:
    touched = 0
    for raw in paths:
        path = Path(raw)
        text = path.read_text(encoding="utf-8")
        if "—" not in text:
            continue
        lines = text.split("\n")
        new = [fix_line(line) for line in lines]
        joined = "\n".join(new)
        # Continuation lines that open with an em dash after a wrapped clause.
        joined = re.sub(r"\n(\s*)— ", r"\n\1", joined)
        joined = joined.replace(" —\n", ",\n").replace("—", ", ")
        if joined != text:
            path.write_text(joined, encoding="utf-8")
            touched += 1
    print(f"rewrote {touched} files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
