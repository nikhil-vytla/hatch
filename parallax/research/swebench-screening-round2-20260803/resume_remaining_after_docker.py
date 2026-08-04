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
SCREENING = EVIDENCE / "remaining-medium-screening.jsonl"
SUMMARY = EVIDENCE / "remaining-medium-screening-summary.json"
ARCHIVED_SCREENING = EVIDENCE / "remaining-medium-docker-failure.jsonl"
ARCHIVED_SUMMARY = EVIDENCE / "remaining-medium-docker-failure-summary.json"
PARTIAL = EVIDENCE / "remaining-medium-screening.jsonl.partial"


def main() -> None:
    if PARTIAL.exists():
        raise FileExistsError("remaining-medium Docker recovery already started")
    archived_screening = ARCHIVED_SCREENING
    archived_summary = ARCHIVED_SUMMARY
    attempt = 2
    while archived_screening.exists() or archived_summary.exists():
        archived_screening = EVIDENCE / (
            f"remaining-medium-docker-failure-{attempt}.jsonl"
        )
        archived_summary = EVIDENCE / (
            f"remaining-medium-docker-failure-{attempt}-summary.json"
        )
        attempt += 1
    records = read_screening_jsonl(SCREENING)
    plan = records[0]
    if not isinstance(plan, ScreeningPlan):
        raise ValueError("screening evidence does not begin with a manifest")
    runs = tuple(record for record in records[1:] if isinstance(record, ScreeningRun))
    retry = tuple(
        run
        for run in runs
        if isinstance(run.outcome, RunFailure)
        and run.outcome.message.startswith("HUD image build failed")
    )
    if len(runs) != 26 or len(retry) != 8:
        raise ValueError("unexpected remaining-medium recovery surface")
    retained = tuple(run for run in runs if run not in retry)
    os.replace(SCREENING, archived_screening)
    os.replace(SUMMARY, archived_summary)
    _append_fsync(PARTIAL, _canonical_line(plan), exclusive=True)
    for run in retained:
        _append_fsync(PARTIAL, _canonical_line(run))
    print(f"RETAINED_UNITS={len(retained)} RETRY_UNITS={len(retry)}")


if __name__ == "__main__":
    main()
