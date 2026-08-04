from __future__ import annotations

import os
from pathlib import Path

from parallax.outcome import RunFailure
from parallax.screening import (
    ScreeningPlan,
    ScreeningRun,
    _append_fsync,
    _canonical_line,
    read_screening_jsonl,
)

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
SCREENING = EVIDENCE / "screening.jsonl"
SUMMARY = EVIDENCE / "screening-summary.json"
ARCHIVED_SCREENING = EVIDENCE / "screening-byte-scan-failure.jsonl"
ARCHIVED_SUMMARY = EVIDENCE / "screening-byte-scan-failure-summary.json"
PARTIAL = EVIDENCE / "screening.jsonl.partial"


def main() -> None:
    if ARCHIVED_SCREENING.exists() or ARCHIVED_SUMMARY.exists() or PARTIAL.exists():
        raise FileExistsError("round-two byte-scan recovery already started")
    records = read_screening_jsonl(SCREENING)
    plan = records[0]
    if not isinstance(plan, ScreeningPlan):
        raise ValueError("screening evidence does not begin with a manifest")
    runs = tuple(record for record in records[1:] if isinstance(record, ScreeningRun))
    retry = tuple(
        run
        for run in runs
        if isinstance(run.outcome, RunFailure)
        and run.outcome.message.startswith(
            "agent artifact contains sealed verifier fragment"
        )
    )
    if len(runs) != 18 or len(retry) != 6:
        raise ValueError("unexpected round-two recovery surface")
    retained = tuple(run for run in runs if run not in retry)
    os.replace(SCREENING, ARCHIVED_SCREENING)
    os.replace(SUMMARY, ARCHIVED_SUMMARY)
    _append_fsync(PARTIAL, _canonical_line(plan), exclusive=True)
    for run in retained:
        _append_fsync(PARTIAL, _canonical_line(run))
    print(f"RETAINED_UNITS={len(retained)} RETRY_UNITS={len(retry)}")


if __name__ == "__main__":
    main()
