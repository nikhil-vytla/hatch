from __future__ import annotations

import json
from pathlib import Path
from typing import assert_never

from parallax.canonical import atomic_write, canonical_bytes
from parallax.metering import total
from parallax.outcome import RunFailure, Verification
from parallax.paired import paired_bounds
from parallax.screening import ScreeningPlan, ScreeningRun, read_screening_jsonl

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
EXPERIMENT = EVIDENCE / "experiment.jsonl"
LINKAGE = EVIDENCE / "preregistration-linkage.json"
REPORT = EVIDENCE / "experiment-report.json"
EXPECTED_PHASE_BUDGETS = {"static": (12,), "evolved": (6, 6)}


def _score(run: ScreeningRun) -> int | None:
    outcome = run.outcome
    if isinstance(outcome, Verification):
        return int(outcome.verdict.value == "pass")
    if isinstance(outcome, RunFailure):
        return None
    assert_never(outcome)


def _outcome_label(run: ScreeningRun) -> str:
    outcome = run.outcome
    if isinstance(outcome, Verification):
        return outcome.verdict.value
    if isinstance(outcome, RunFailure):
        return f"run_failure:{outcome.failure_kind}"
    assert_never(outcome)


def _delivery_check(run: ScreeningRun) -> dict[str, object]:
    arm = str(run.unit.arm)
    expected_budgets = EXPECTED_PHASE_BUDGETS[arm]
    receipt = run.delivery
    if receipt is None:
        return {"delivered": False, "reason": "missing delivery receipt"}
    budgets = tuple(phase.step_budget for phase in receipt.phases)
    ok = (
        receipt.complete
        and receipt.turn_count == len(expected_budgets)
        and budgets == expected_budgets
        and receipt.total_step_budget == sum(expected_budgets)
    )
    return {
        "delivered": bool(ok),
        "turn_count": receipt.turn_count,
        "total_step_budget": receipt.total_step_budget,
        "phases": [
            {
                "turn_index": phase.turn_index,
                "step_budget": phase.step_budget,
                "steps_consumed": phase.steps_consumed,
                "advance_trigger": phase.advance_trigger,
            }
            for phase in receipt.phases
        ],
    }


def main() -> None:
    records = read_screening_jsonl(EXPERIMENT)
    plan = records[0]
    if not isinstance(plan, ScreeningPlan):
        raise ValueError("experiment evidence does not start with a manifest")
    runs = [record for record in records[1:] if isinstance(record, ScreeningRun)]
    if len(runs) != len(records) - 1:
        raise ValueError("experiment evidence contains a second manifest")
    linkage = json.loads(LINKAGE.read_text(encoding="utf-8"))
    if linkage["screening_design_digest"] != str(plan.design_digest):
        raise ValueError("preregistration linkage digest drift")
    indexed: dict[tuple[str, int, str], ScreeningRun] = {}
    for run in runs:
        if (
            run.design_digest != plan.design_digest
            or run.model_config_digest != plan.model_config_digest
        ):
            raise ValueError("experiment run identity drift")
        key = (str(run.unit.source_id), int(run.unit.trial_index), str(run.unit.arm))
        if key in indexed:
            raise ValueError(f"duplicate experiment run: {key!r}")
        indexed[key] = run
    expected = {
        (str(unit.source_id), int(unit.trial_index), str(unit.arm))
        for unit in plan.units
    }
    if set(indexed) != expected:
        raise ValueError("experiment runs differ from preregistered units")

    sources = sorted({source for source, _, _ in indexed})
    trials = sorted({trial for _, trial, _ in indexed})

    conditions: dict[str, dict[str, object]] = {}
    delivery: dict[str, dict[str, object]] = {}
    for source in sources:
        per_arm: dict[str, object] = {}
        for arm in ("static", "evolved"):
            arm_runs = [indexed[(source, trial, arm)] for trial in trials]
            scores = [_score(run) for run in arm_runs]
            verified = [value for value in scores if value is not None]
            per_arm[arm] = {
                "outcomes": [_outcome_label(run) for run in arm_runs],
                "passes": sum(verified),
                "verified_trials": len(verified),
                "run_failures": len(scores) - len(verified),
                "pass_rate": (sum(verified) / len(verified) if verified else None),
            }
        conditions[source] = per_arm
        delivery[source] = {
            f"trial-{trial}:{arm}": _delivery_check(indexed[(source, trial, arm)])
            for trial in trials
            for arm in ("static", "evolved")
        }

    all_delivered = all(
        check["delivered"]
        for per_source in delivery.values()
        for check in per_source.values()
    )
    evolved_delivered = all(
        check["delivered"]
        for per_source in delivery.values()
        for key, check in per_source.items()
        if key.endswith(":evolved")
    )

    bounds = paired_bounds(
        {
            source: [
                (
                    _score(indexed[(source, trial, "static")]),
                    _score(indexed[(source, trial, "evolved")]),
                )
                for trial in trials
            ]
            for source in sources
        },
        estimand="single_minus_evolved_pass_rate",
    )

    def arm_spend(arm: str) -> float:
        return total(run.usage for run in runs if str(run.unit.arm) == arm).cost_usd

    metered = total(run.usage for run in runs)
    spend = {
        "total_usd": metered.cost_usd,
        "static_usd": arm_spend("static"),
        "evolved_usd": arm_spend("evolved"),
        "prompt_tokens": metered.prompt_tokens,
        "completion_tokens": metered.completion_tokens,
    }
    receipts = {
        "official_harness_receipts": sum(
            1 for run in runs if run.verifier_report_digest is not None
        ),
        "harness_revisions": sorted(
            {run.harness_revision for run in runs if run.harness_revision}
        ),
        "reported_models": sorted({str(run.reported_model) for run in runs}),
    }

    report = {
        "schema_version": 1,
        "design_digest": str(plan.design_digest),
        "preregistered_design_digest": linkage["preregistered_design_digest"],
        "conditions": conditions,
        "delivery": {
            "all_units_delivered": all_delivered,
            "all_evolved_units_delivered": evolved_delivered,
            "per_unit": delivery,
        },
        "paired_analysis": {
            "estimand": bounds.estimand,
            "paired_complete": bounds.paired_complete,
            "point_delta_complete_pairs": bounds.point_delta_complete_pairs,
            "identification_bounds": {
                "lower": bounds.identification_lower,
                "upper": bounds.identification_upper,
            },
            "interval": {
                "confidence": 0.95,
                "method": "source_clustered_hoeffding",
                "epsilon": bounds.epsilon,
                "lower": bounds.interval_lower,
                "upper": bounds.interval_upper,
                "minimum_detectable_effect": bounds.minimum_detectable_effect,
            },
            "language": "bounds_only",
        },
        "spend": spend,
        "receipts": receipts,
    }
    atomic_write(REPORT, canonical_bytes(report) + b"\n")
    print(json.dumps(report, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
