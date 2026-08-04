#!/usr/bin/env python3
"""Check an admission-review verdict record against the review-task-admission rules.

Usage:
    python3 validate_verdict.py VERDICT.md

Checks only the mechanical shape of the record, never the judgment:
an identity digest, a decision line, at least one observation tied to a
rendered arm or turn, no quoted patch hunks (sealed-material hygiene),
and a length bound (verdicts are short).

Exit code 0 when every check passes, 1 otherwise. Standard library only.
"""

import argparse
import re
import sys

MAX_VERDICT_LINES = 60

SPEC_DIGEST = re.compile(r"^spec digest:\s*[0-9a-f]{64}\s*$", re.IGNORECASE)
VERDICT_LINE = re.compile(
    r"^verdict:\s*(admit|admit-with-notes|reject)\s*$", re.IGNORECASE
)
ARM_OR_TURN = re.compile(r"\b(static|matched|evolved|turn\s*\d+|artifact)\b", re.IGNORECASE)
BULLET = re.compile(r"^\s*[-*]\s+\S")
PATCH_HUNK = re.compile(r"^(\+\+\+ |--- |@@ )")


def validate(text):
    findings = []
    lines = text.splitlines()
    if len(lines) > MAX_VERDICT_LINES:
        findings.append(
            (None, f"verdict is {len(lines)} lines; keep it under {MAX_VERDICT_LINES}")
        )
    if not any(SPEC_DIGEST.match(line) for line in lines):
        findings.append(
            (None, 'missing identity: add a "Spec digest: <64-hex>" line')
        )
    verdicts = [line for line in lines if VERDICT_LINE.match(line)]
    if len(verdicts) != 1:
        findings.append(
            (
                None,
                'need exactly one "Verdict: admit | admit-with-notes | reject" line'
                f" (found {len(verdicts)})",
            )
        )
    observations = [
        line for line in lines if BULLET.match(line) and ARM_OR_TURN.search(line)
    ]
    if not observations:
        findings.append(
            (
                None,
                "no observation names a rendered arm, turn, or artifact; "
                "tie at least one bullet to what was actually reviewed",
            )
        )
    for number, line in enumerate(lines, 1):
        if PATCH_HUNK.match(line):
            findings.append(
                (
                    number,
                    "looks like a quoted patch hunk; never paste sealed "
                    "material into a verdict",
                )
            )
    return sorted(findings, key=lambda item: (item[0] is None, item[0] or 0))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="Verdict markdown file to check")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as handle:
        text = handle.read()
    findings = validate(text)
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
