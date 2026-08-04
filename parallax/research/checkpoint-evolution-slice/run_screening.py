"""Launch the preregistered checkpoint-evolution screening run.

Dry-run (no key, no spend, scripted gateway replies from the fixture):

    uv run python research/checkpoint-evolution-slice/run_screening.py
    uv run python research/checkpoint-evolution-slice/run_screening.py --sandbox

Live (paid; requires an exported HUD_API_KEY and explicit approval):

    uv run python research/checkpoint-evolution-slice/run_screening.py \
        --live --approve-spend
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from parallax.checkpoint_evolution import StageVerification
from parallax.checkpoint_runner import CeRunRecord, read_ce_jsonl
from parallax.checkpoint_screening import CE_TRIAL_SEEDS, run_ce_screening

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
    parser.add_argument(
        "--seeds",
        type=int,
        default=len(CE_TRIAL_SEEDS),
        help="number of preregistered trial seeds to schedule",
    )
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
    runs = run_ce_screening(
        mode=mode,
        seed_path=SEED_PATH,
        output_path=output,
        trial_seeds=CE_TRIAL_SEEDS[: arguments.seeds],
        dry_run_execution="sandbox" if arguments.sandbox else "trusted-fixture",
        approve_spend=arguments.approve_spend,
    )
    records = read_ce_jsonl(output)
    stage_receipts = [
        receipt
        for record in records
        if isinstance(record, CeRunRecord)
        for receipt in record.receipts
    ]
    verified = sum(
        isinstance(receipt.outcome, StageVerification) for receipt in stage_receipts
    )
    cost = sum(
        receipt.usage.estimated_cost_usd
        for receipt in stage_receipts
        if receipt.usage is not None
    )
    print(
        f"mode={mode} runs={len(runs)} stage_receipts={len(stage_receipts)} "
        f"verified={verified} estimated_cost_usd={cost:.6f} evidence={output}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
