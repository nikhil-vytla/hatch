"""Launch the preregistered checkpoint-evolution screening run.

Dry-run (no key, no spend, scripted gateway replies from the fixture):

    uv run python research/checkpoint-evolution-slice/run_screening.py
    uv run python research/checkpoint-evolution-slice/run_screening.py --sandbox

Live (paid; requires an exported HUD_API_KEY and explicit approval):

    uv run python research/checkpoint-evolution-slice/run_screening.py \
        --live --approve-spend

`--headroom-variant` swaps in the budget-headroom disambiguation family
(`ce-tally-1-headroom`: caps 4096/8192/12288 instead of flat 4096, max
output tokens 4096 instead of 2048, everything else identical) per
PREREGISTRATION-HEADROOM.md. Note the original family no longer passes
the live path's budget-headroom refusal; it is kept for the record.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from parallax.checkpoint_evolution import StageVerification
from parallax.checkpoint_runner import CeRunRecord, read_ce_jsonl
from parallax.checkpoint_screening import (
    CE_MAX_OUTPUT_TOKENS,
    CE_TRIAL_SEEDS,
    run_ce_screening,
)

REPO = Path(__file__).resolve().parents[2]
SEED_PATH = REPO / "tests" / "fixtures" / "checkpoint_family.json"
HERE = Path(__file__).resolve().parent
HEADROOM_SEED_PATH = HERE / "fixtures" / "checkpoint_family_headroom.json"
HEADROOM_MAX_OUTPUT_TOKENS = 4096
EVIDENCE = HERE / "evidence"


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
    parser.add_argument(
        "--headroom-variant",
        action="store_true",
        help="run the budget-headroom disambiguation family instead",
    )
    arguments = parser.parse_args(argv)
    if arguments.live:
        mode, name = "live", "screening.jsonl"
    elif arguments.sandbox:
        mode, name = "dry-run", "dry-run-sandbox.jsonl"
    else:
        mode, name = "dry-run", "dry-run.jsonl"
    if arguments.headroom_variant:
        seed_path = HEADROOM_SEED_PATH
        max_output_tokens = HEADROOM_MAX_OUTPUT_TOKENS
        name = name.replace(".jsonl", "-headroom.jsonl")
    else:
        seed_path = SEED_PATH
        max_output_tokens = CE_MAX_OUTPUT_TOKENS
    output = EVIDENCE / name
    if output.exists():
        raise SystemExit(f"evidence already exists: {output}")
    runs = run_ce_screening(
        mode=mode,
        seed_path=seed_path,
        output_path=output,
        trial_seeds=CE_TRIAL_SEEDS[: arguments.seeds],
        dry_run_execution="sandbox" if arguments.sandbox else "trusted-fixture",
        approve_spend=arguments.approve_spend,
        max_output_tokens=max_output_tokens,
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
