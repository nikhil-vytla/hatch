"""Launch the preregistered checkpoint-evolution screening run.

Dry-run (no key, no spend, scripted gateway replies from the fixture):

    uv run python research/checkpoint-evolution-slice/run_screening.py
    uv run python research/checkpoint-evolution-slice/run_screening.py --sandbox

Live (paid; requires an exported HUD_API_KEY and explicit approval):

    uv run python research/checkpoint-evolution-slice/run_screening.py \
        --live --approve-spend

Read the result with the one analysis path:

    uv run python -m parallax.findings \
        research/checkpoint-evolution-slice/evidence/screening.jsonl
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from parallax.checkpoint_screening import CE_TRIALS, run_ce_screening
from parallax.findings import from_journal, render

REPO = Path(__file__).resolve().parents[2]
SEED_PATH = REPO / "tests" / "fixtures" / "checkpoint_family.json"
EVIDENCE = Path(__file__).resolve().parent / "evidence"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--approve-spend", action="store_true")
    parser.add_argument(
        "--sandbox",
        action="store_true",
        help="route dry-run verification through the pinned Docker sandbox",
    )
    parser.add_argument("--trials", type=int, default=CE_TRIALS)
    arguments = parser.parse_args(argv)
    if arguments.live:
        mode, name = "live", "screening.jsonl"
    elif arguments.sandbox:
        mode, name = "dry-run", "dry-run-sandbox.jsonl"
    else:
        mode, name = "dry-run", "dry-run.jsonl"
    output = EVIDENCE / name
    if output.exists():
        raise SystemExit(f"evidence already exists: {output}")
    run_ce_screening(
        mode=mode,
        seed_path=SEED_PATH,
        output_path=output,
        trials=arguments.trials,
        dry_run_execution="sandbox" if arguments.sandbox else "trusted-fixture",
        approve_spend=arguments.approve_spend,
    )
    print(render(from_journal(output)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
