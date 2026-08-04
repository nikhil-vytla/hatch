from __future__ import annotations

import json
import os
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes
from parallax.hud_screening import HudExecutor, TokenPricing
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
    fetch_swebench_verified,
)

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
WORK = EVIDENCE / "tier-down-live-work"
SCREENING = EVIDENCE / "tier-down-screening.jsonl"
SUMMARY = EVIDENCE / "tier-down-screening-summary.json"
MODEL = "claude-sonnet-4-6"
PRIOR_COST_USD = 2.926905
ROUND_CAP_USD = 5.0
TRIAL_SEEDS = (2026080311, 2026080312, 2026080313)
SONNET_PRICING = TokenPricing(
    input_usd_per_million=2.0,
    output_usd_per_million=10.0,
)
INSTANCE_DIGESTS = {
    "django__django-10914": (
        "f821080544e1fe3d31e483adbfdf2cc25850f42add4068de5b1dda8935f4d2cb"
    ),
    "django__django-13089": (
        "3a8463419d06d9527d4a079e85c1e29af93cabfdd1c822298cd9639bf9f8b2e7"
    ),
    "pydata__xarray-6721": (
        "82a4385a61a1b80eacb889fa79fe7c2f8c1d45a46c9a6c7748040e181a050ba0"
    ),
}


def _construction_rows() -> dict[str, SweConstruction]:
    paths = (
        ROOT.parent
        / "swebench-screening-run-20260802"
        / "evidence"
        / "construction.jsonl",
        EVIDENCE / "construction.jsonl",
    )
    constructions: dict[str, SweConstruction] = {}
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            source_id = row["source_id"]
            if source_id in constructions:
                continue
            constructions[source_id] = SweConstruction.model_validate_json(
                json.dumps(row["construction"])
            )
    return constructions


def main() -> None:
    if not os.environ.get("HUD_API_KEY"):
        raise RuntimeError("HUD_API_KEY is required")
    runtimes = {
        instance_id: VerifierRuntime(image_digest=ImageDigest(digest))
        for instance_id, digest in INSTANCE_DIGESTS.items()
    }
    problems = fetch_swebench_verified(tuple(INSTANCE_DIGESTS), runtimes=runtimes)
    plan = build_screening_plan(
        problems,
        model=MODEL,
        expected_response_model=MODEL,
        trial_seeds=TRIAL_SEEDS,
        cost=ScreeningCost(
            lower_per_episode_usd=0.02,
            upper_per_episode_usd=0.20,
        ),
    )
    if not SCREENING.exists():
        initialize_screening_manifest(plan, SCREENING)
    constructions = _construction_rows()
    families = {
        str(problem.record_id): build_swe_script_family(
            problem,
            constructions[str(problem.record_id)],
            total_agent_steps=12,
            max_output_tokens=4096,
        )
        for problem in problems
    }
    if SCREENING.exists():
        records = read_screening_jsonl(SCREENING)
        stored_plan = records[0]
        if stored_plan != plan or not isinstance(stored_plan, ScreeningPlan):
            raise ValueError("completed tier-down manifest drift")
        runs = tuple(
            record for record in records[1:] if isinstance(record, ScreeningRun)
        )
    else:
        executor = HudExecutor(
            families,
            model=MODEL,
            work_directory=WORK,
            pricing=SONNET_PRICING,
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
