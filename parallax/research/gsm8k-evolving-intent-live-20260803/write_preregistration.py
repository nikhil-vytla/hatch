"""Emit the preregistration for the main run, before its first paid call.

Writes `preregistration.json` in canonical form. Its digest is passed to
`live_run.py --preregistration`, which hashes it into `model_config_digest`,
which is hashed into `design_digest`, which every family and run row must
carry. Evidence produced under a different preregistration cannot validate.
"""

from __future__ import annotations

import json
from pathlib import Path

from live_run import (
    CONSTRUCTION_MODEL,
    CONSTRUCTION_SEED,
    CONSTRUCTION_TEMPERATURE,
    DATASET,
    DATASET_SHA256,
    DATASET_URL,
    EXPECTED_REPORTED_MODEL,
    MAXIMUM_ARGUMENTS,
    MODEL,
    PER_TURN_OUTPUT_TOKENS,
    PILOT_SOURCE_IDS,
    SELECTION_SEED,
    SYSTEM_PROMPT,
    TEMPERATURE,
    load_official_gsm8k,
    select_candidates,
)

from parallax.canonical import canonical_digest
from parallax.provider import HUD_GATEWAY_ENDPOINT

ROOT = Path(__file__).parent
OUTPUT = ROOT / "preregistration.json"
CANDIDATES = 150
TRIALS = 3


def main() -> None:
    problems, skipped = load_official_gsm8k(DATASET)
    candidates = select_candidates(problems, CANDIDATES)
    trial_seeds = [int(f"2026080{index + 1}") for index in range(TRIALS)]

    design = {
        "title": ("GSM8K Evolving Intent, first real-provider three-arm run"),
        "source_pool": {
            "dataset": "openai/grade-school-math test split",
            "url": DATASET_URL,
            "sha256": DATASET_SHA256,
            "rows": 1319,
            "admissible_rows": len(problems),
            "excluded_rows_non_canonical_answer": len(skipped),
            "exclusion_rule": (
                "A row is admissible when its sealed '#### <value>' answer is "
                "already a canonical integer. 14 rows use a thousands "
                "separator. Grading semantics are left strictly canonical "
                "rather than loosened, so those rows are out of population. "
                "The rule is applied before construction and is identical for "
                "every arm."
            ),
        },
        "selection": {
            "seed": SELECTION_SEED,
            "procedure": (
                "Sort the admissible pool by source id, drop the four "
                "calibration-pilot sources, shuffle once with the seed, take "
                "the first N, and re-sort by source id."
            ),
            "held_out_pilot_sources": sorted(PILOT_SOURCE_IDS),
            "candidate_count": CANDIDATES,
            "candidate_source_ids": [str(item.record_id) for item in candidates],
        },
        "admission": {
            "construction_must_succeed": True,
            "maximum_extracted_arguments": MAXIMUM_ARGUMENTS,
            "note": (
                "Admission is decided per source before any arm is executed, "
                "so it cannot differ across arms. The argument bound caps "
                "episode length at 2*N+1 turns. Admitted count and every "
                "rejection reason are reported."
            ),
        },
        "arms": {
            "static": "One turn rendering the fully revealed extracted intent.",
            "matched": (
                "Turn-count- and budget-matched progressive reveal of the "
                "source intent; no revision, no function switch."
            ),
            "evolved": (
                "Opens under a predecessor function with counterfactual "
                "argument values, then reveals, corrects, and switches back, "
                "terminally restoring the exact source intent."
            ),
            "matched_and_evolved_share_turn_count_and_per_turn_budget": True,
        },
        "model": {
            "agent_model": MODEL,
            "expected_reported_model": EXPECTED_REPORTED_MODEL,
            "construction_model": CONSTRUCTION_MODEL,
            "endpoint": HUD_GATEWAY_ENDPOINT,
            "agent_temperature": TEMPERATURE,
            "construction_temperature": CONSTRUCTION_TEMPERATURE,
            "max_output_tokens_per_turn": PER_TURN_OUTPUT_TOKENS,
            "static_receives_the_summed_budget_in_one_turn": True,
        },
        "trials": {
            "count": TRIALS,
            "seeds": trial_seeds,
            "construction_seed": CONSTRUCTION_SEED,
            "seed_causality": (
                "Trial seeds are sent to the gateway in the OpenAI-style "
                "'seed' field and are NOT honoured by it. Measured before "
                "this design was frozen: two calls with seed=12345 at "
                "temperature 1.0 returned different completions "
                "(evidence/gateway-probe.json). Trials are therefore "
                "independent samples at temperature 1.0, not seed-reproducible "
                "replicates. The construction seed IS causal: it drives the "
                "local event scheduler in evolving_intent._schedule_events."
            ),
        },
        "submission_contract": {
            "system_prompt_digest": canonical_digest(SYSTEM_PROMPT),
            "system_prompt": SYSTEM_PROMPT,
            "note": (
                "Sent as one system message, byte-identical for every arm. "
                "Without it a real model never emits the FINAL_ANSWER marker "
                "the native grader requires and every episode grades invalid."
            ),
        },
        "analysis": {
            "unit_of_clustering": "source task",
            "per_arm_accuracy": (
                "Mean over sources of the source's mean pass indicator, over "
                "verification outcomes."
            ),
            "contrasts": [
                "evolved minus matched",
                "evolved minus static",
                "matched minus static",
            ],
            "primary_contrast": "evolved minus matched",
            "interval": (
                "95% percentile bootstrap over source clusters, 20000 "
                "resamples, seed 20260803, reported alongside a "
                "normal-approximation interval from the between-source "
                "standard error."
            ),
            "run_failure_handling": (
                "Complete-case for the point estimate and interval; "
                "worst-case and best-case identification bounds over failed "
                "pairs reported alongside as a factual sensitivity range."
            ),
            "no_decision_rule": (
                "This study reports estimates and intervals as facts. It "
                "declares no threshold and returns no advance, reject, or "
                "power verdict. runner.ManifestRecord still requires a "
                "'threshold' field to construct; it is set to the fixed "
                "placeholder 0.0, is never read back, and carries no meaning "
                "here."
            ),
        },
        "cost": {
            "pilot_measured_usd_per_source_construction": 0.0031,
            "pilot_measured_usd_per_source_trial_all_three_arms": 0.0219,
            "estimated_total_usd": round(
                CANDIDATES * 0.0031 + CANDIDATES * TRIALS * 0.0219, 2
            ),
            "basis": (
                "Measured on a 4-source, 1-trial calibration pilot that cost "
                "$0.100 in metered tokens."
            ),
        },
        "stopping_rules": {
            "consecutive_gateway_failures": 3,
            "per_call_retries": 5,
            "note": (
                "More than three consecutive gateway failures raises a "
                "BaseException so it cannot be swallowed by run_script's "
                "except Exception and recorded as fabricated run failures."
            ),
        },
    }

    text = json.dumps(design, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    OUTPUT.write_text(text)
    print(f"wrote {OUTPUT}")
    print(f"digest {canonical_digest(json.loads(text))}")


if __name__ == "__main__":
    main()
