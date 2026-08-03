from __future__ import annotations

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


EXPECTED_HEADER = ("ts", "phase", "decision", "why", "evidence", "result")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
FORMULA_PREFIXES = ("=", "+", "-", "@")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: audit_tsv.py PATH")

    path = Path(sys.argv[1]).resolve()
    root = path.parent.parent
    with path.open(newline="") as handle:
        rows = list(csv.reader(handle, delimiter="\t"))

    header = tuple(rows[0]) if rows else ()
    data = rows[1:]
    shape_errors: list[dict[str, object]] = []
    timestamp_errors: list[int] = []
    formula_risks: list[dict[str, object]] = []
    unresolved_evidence: list[dict[str, object]] = []

    for line_no, row in enumerate(data, start=2):
        if len(row) != len(EXPECTED_HEADER):
            shape_errors.append({"line": line_no, "fields": len(row)})
            continue
        if not TIMESTAMP.fullmatch(row[0]):
            timestamp_errors.append(line_no)
        for column, value in zip(EXPECTED_HEADER, row, strict=True):
            if value.lstrip().startswith(FORMULA_PREFIXES):
                formula_risks.append({"line": line_no, "column": column})
        evidence = row[4]
        if not evidence.startswith(("http://", "https://")):
            target = root / evidence
            if not target.exists():
                unresolved_evidence.append(
                    {"line": line_no, "evidence": evidence}
                )

    decisions = Counter(row[2] for row in data if len(row) == len(EXPECTED_HEADER))
    duplicate_decisions = sorted(
        decision for decision, count in decisions.items() if count > 1
    )
    report = {
        "header_ok": header == EXPECTED_HEADER,
        "data_rows": len(data),
        "shape_errors": shape_errors,
        "timestamp_errors": timestamp_errors,
        "formula_risks": formula_risks,
        "unresolved_evidence": unresolved_evidence,
        "duplicate_decisions": duplicate_decisions,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return int(
        not report["header_ok"]
        or bool(shape_errors)
        or bool(timestamp_errors)
        or bool(formula_risks)
        or bool(unresolved_evidence)
    )


if __name__ == "__main__":
    raise SystemExit(main())
