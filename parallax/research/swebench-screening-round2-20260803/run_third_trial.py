from __future__ import annotations

import json
import os
from pathlib import Path

from pyarrow.parquet import read_table
from run_remaining_medium import INSTANCE_DIGESTS, PINNED_PARQUET

from parallax.canonical import atomic_write, canonical_bytes
from parallax.hud_screening import HudExecutor
from parallax.screening import (
    ScreeningCost,
    ScreeningPlan,
    ScreeningRun,
    build_screening_plan,
    initialize_screening_manifest,
    read_screening_jsonl,
    run_screening,
    summarize_screening,
)
from parallax.swebench import (
    ImageDigest,
    SweConstruction,
    VerifierRuntime,
    build_swe_script_family,
    load_swebench_rows,
)

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
WORK = EVIDENCE / "third-trial-live-work"
SCREENING = EVIDENCE / "remaining-medium-third-trial.jsonl"
SUMMARY = EVIDENCE / "remaining-medium-third-trial-summary.json"
MODEL = "claude-opus-4-8"
PRIOR_COST_USD = 2.350562
ROUND_CAP_USD = 5.0


def main() -> None:
    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is required")
    runtimes = {
        instance_id: VerifierRuntime(image_digest=ImageDigest(digest))
        for instance_id, digest in INSTANCE_DIGESTS.items()
    }
    selected = {
        row["instance_id"]: row
        for row in read_table(PINNED_PARQUET).to_pylist()
        if row["instance_id"] in INSTANCE_DIGESTS
    }
    problems = load_swebench_rows(
        tuple(selected[instance_id] for instance_id in INSTANCE_DIGESTS),
        tuple(INSTANCE_DIGESTS),
        runtimes=runtimes,
    )
    plan = build_screening_plan(
        problems,
        model=MODEL,
        expected_response_model=MODEL,
        trial_seeds=(2026080323,),
        cost=ScreeningCost(
            lower_per_episode_usd=0.02,
            upper_per_episode_usd=0.12,
        ),
    )
    if not SCREENING.exists():
        initialize_screening_manifest(plan, SCREENING)
    constructions = {
        row["source_id"]: SweConstruction.model_validate_json(
            json.dumps(row["construction"])
        )
        for row in map(
            json.loads,
            (EVIDENCE / "remaining-medium-construction.jsonl").read_text().splitlines(),
        )
    }
    families = {
        str(problem.record_id): build_swe_script_family(
            problem,
            constructions[str(problem.record_id)],
            seed=20260803,
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        for problem in problems
    }
    if SCREENING.exists():
        records = read_screening_jsonl(SCREENING)
        stored_plan = records[0]
        if stored_plan != plan or not isinstance(stored_plan, ScreeningPlan):
            raise ValueError("completed third-trial manifest drift")
        runs = tuple(
            record for record in records[1:] if isinstance(record, ScreeningRun)
        )
    else:
        executor = HudExecutor(
            families,
            model=MODEL,
            work_directory=WORK,
        )
        runs = run_screening(
            plan,
            executor,
            output_path=SCREENING,
            approve_spend=True,
            spend_cap_usd=ROUND_CAP_USD - PRIOR_COST_USD,
        )
    summary = summarize_screening(plan, runs)
    atomic_write(SUMMARY, canonical_bytes(summary) + b"\n")
    extension_cost = sum(run.estimated_cost_usd for run in runs)
    print(
        json.dumps(
            {
                "aggregate_cost_usd": PRIOR_COST_USD + extension_cost,
                "extension_cost_usd": extension_cost,
                "summary": summary.model_dump(mode="json"),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
