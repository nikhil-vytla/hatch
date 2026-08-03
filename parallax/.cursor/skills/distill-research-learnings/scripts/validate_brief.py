#!/usr/bin/env python3
"""Check a research brief or product doc against the distill-research-learnings rules.

Usage:
    python3 validate_brief.py BRIEF.md
    python3 validate_brief.py --mode doc README.md

Brief mode checks required sections, evidence with runnable commands, banned
delivery-sequencing phrases, empty headings, code map size, and length bounds.
Doc mode checks only banned phrases and empty headings, because product docs
own their structure.

Exit code 0 when every check passes, 1 otherwise. Standard library only.
"""

import argparse
import re
import sys
from dataclasses import dataclass, field

MAX_BRIEF_LINES = 200
MAX_RESULT_LINES = 12
CODE_MAP_MIN = 3
CODE_MAP_MAX = 7

BANNED_PHRASES = [
    (re.compile(r"\bthis\s+PR\b", re.IGNORECASE), '"this PR" ties the text to one delivery'),
    (re.compile(r"\bPR\s*#?\d+\b"), 'PR-number sequencing such as "PR3"'),
    (
        re.compile(r"\b(?:later|next|future|follow-?up|subsequent)\s+PRs?\b", re.IGNORECASE),
        "future-PR sequencing",
    ),
]

HEADING = re.compile(r"^(#{1,6})\s+(.*\S)")
BULLET = re.compile(r"^\s*[-*]\s+\S")
FENCE = re.compile(r"^\s*(```+|~~~+)")


@dataclass
class Section:
    title: str
    level: int
    line: int
    nonblank: int = 0
    bullets: int = 0
    has_fence: bool = False


@dataclass
class Document:
    total_lines: int
    sections: list = field(default_factory=list)
    prose: list = field(default_factory=list)  # (line_number, text) outside fences


def parse(text):
    doc = Document(total_lines=0)
    fence_marker = None
    current = None
    lines = text.splitlines()
    doc.total_lines = len(lines)
    for number, line in enumerate(lines, 1):
        if fence_marker is not None:
            if current is not None:
                current.nonblank += 1
            if line.strip().startswith(fence_marker):
                fence_marker = None
            continue
        fence = FENCE.match(line)
        if fence:
            fence_marker = fence.group(1)[:3]
            if current is not None:
                current.has_fence = True
                current.nonblank += 1
            continue
        heading = HEADING.match(line)
        if heading:
            current = Section(
                title=heading.group(2).strip(),
                level=len(heading.group(1)),
                line=number,
            )
            doc.sections.append(current)
            doc.prose.append((number, line))
            continue
        doc.prose.append((number, line))
        if current is not None and line.strip():
            current.nonblank += 1
            if BULLET.match(line):
                current.bullets += 1
    return doc


def find_section(doc, *needles):
    for section in doc.sections:
        title = section.title.lower()
        if any(needle in title for needle in needles):
            return section
    return None


def check_banned_phrases(doc):
    findings = []
    for number, line in doc.prose:
        for pattern, reason in BANNED_PHRASES:
            match = pattern.search(line)
            if match:
                findings.append((number, f"banned phrase {match.group(0)!r}: {reason}"))
    return findings


def check_empty_sections(doc):
    findings = []
    for index, section in enumerate(doc.sections):
        following = doc.sections[index + 1] if index + 1 < len(doc.sections) else None
        has_subsections = following is not None and following.level > section.level
        if section.nonblank == 0 and not has_subsections:
            findings.append((section.line, f"empty section {section.title!r}: delete it or add content"))
    return findings


def check_brief(doc):
    findings = []
    if doc.total_lines > MAX_BRIEF_LINES:
        findings.append((None, f"brief is {doc.total_lines} lines; keep it under {MAX_BRIEF_LINES}"))
    for needles, label in [
        (("question",), "Question"),
        (("result",), "Result"),
        (("next experiment",), "Next experiment"),
    ]:
        if find_section(doc, *needles) is None:
            findings.append((None, f"missing required section: {label}"))
    evidence = find_section(doc, "evidence", "reproduction")
    if evidence is None:
        findings.append((None, "missing required section: Evidence and reproduction"))
    elif not evidence.has_fence:
        findings.append(
            (evidence.line, "evidence section has no fenced command block; include exact reproduction commands")
        )
    result = find_section(doc, "result")
    if result is not None and result.nonblank > MAX_RESULT_LINES:
        findings.append(
            (result.line, f"Result section has {result.nonblank} content lines; keep it at {MAX_RESULT_LINES} or fewer")
        )
    code_map = find_section(doc, "code map")
    if code_map is not None and not CODE_MAP_MIN <= code_map.bullets <= CODE_MAP_MAX:
        findings.append(
            (
                code_map.line,
                f"code map has {code_map.bullets} entries; use {CODE_MAP_MIN} to {CODE_MAP_MAX}",
            )
        )
    return findings


def validate(text, mode):
    doc = parse(text)
    findings = check_banned_phrases(doc) + check_empty_sections(doc)
    if mode == "brief":
        findings += check_brief(doc)
    return sorted(findings, key=lambda item: (item[0] is None, item[0] or 0))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="Markdown file to check")
    parser.add_argument("--mode", choices=["brief", "doc"], default="brief")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as handle:
        text = handle.read()
    findings = validate(text, args.mode)
    for line, message in findings:
        location = f"{args.path}:{line}" if line is not None else args.path
        print(f"{location}: {message}")
    if findings:
        print(f"FAIL ({len(findings)} finding{'s' if len(findings) != 1 else ''})")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
