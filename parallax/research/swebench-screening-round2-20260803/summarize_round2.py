from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes
from parallax.metering import MeteredUsage, meter, total
from parallax.outcome import RunFailure, Verification
from parallax.screening import (
    ScreeningRun,
    classify_operating_point,
    read_screening_jsonl,
)

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
REPORT = ROOT / "round2-report.json"


def _component(usage: MeteredUsage) -> dict[str, int | float]:
    return {
        "completion_tokens": usage.completion_tokens,
        "cost_usd": round(usage.cost_usd, 6),
        "prompt_tokens": usage.prompt_tokens,
    }


def _screening_runs(name: str) -> tuple[ScreeningRun, ...]:
    records = read_screening_jsonl(EVIDENCE / name)
    return tuple(record for record in records[1:] if isinstance(record, ScreeningRun))


def _meter_screening(name: str, model: str) -> dict[str, int | float]:
    runs = _screening_runs(name)
    for run in runs:
        if isinstance(run.outcome, RunFailure):
            raise ValueError(f"final evidence contains run failure: {name}")
        if run.reported_model != model:
            raise ValueError(f"provider model drift: {name}")
        if run.harness_revision != "f7bbbb2ccdf479001d6467c9e34af59e44a840f9":
            raise ValueError(f"official harness revision drift: {name}")
        if run.verifier_report_digest is None:
            raise ValueError(f"missing official verifier receipt: {name}")
    # Re-metered from recorded token counts at canonical rates rather than
    # summed from the receipts: the first round's receipts were written at
    # retired Opus rates (15/75 per million) and overstate that component by 3x.
    return _component(
        total(
            meter(
                model,
                prompt_tokens=run.prompt_tokens,
                completion_tokens=run.completion_tokens,
            )
            for run in runs
        )
    )


def _meter_construction(name: str) -> dict[str, int | float]:
    rows = tuple(
        json.loads(line) for line in (EVIDENCE / name).read_text().splitlines() if line
    )
    return _component(
        meter(
            "claude-haiku-4-5",
            prompt_tokens=sum(row["prompt_tokens"] for row in rows),
            completion_tokens=sum(row["completion_tokens"] for row in rows),
        )
    )


def _outcomes(
    paths: tuple[str, ...],
) -> dict[str, list[tuple[int, str]]]:
    grouped: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for path in paths:
        for run in _screening_runs(path):
            if isinstance(run.outcome, RunFailure):
                outcome = f"failure:{run.outcome.failure_kind}"
            elif isinstance(run.outcome, Verification):
                outcome = str(run.outcome.verdict)
            else:
                raise AssertionError("unknown screening outcome")
            grouped[str(run.unit.source_id)].append((run.unit.trial_seed, outcome))
    return grouped


def _classify(
    grouped: dict[str, list[tuple[int, str]]],
) -> tuple[dict[str, object], ...]:
    results = []
    for source_id, trials in sorted(grouped.items()):
        ordered = tuple(outcome for _, outcome in sorted(trials))
        passes = ordered.count("pass")
        verified = sum(not outcome.startswith("failure:") for outcome in ordered)
        pass_rate = passes / verified if verified else None
        results.append(
            {
                "operating_point": classify_operating_point(pass_rate),
                "outcomes": ordered,
                "pass_rate": pass_rate,
                "source_id": source_id,
            }
        )
    return tuple(results)


def main() -> None:
    components = {
        "initial_construction": _meter_construction("construction.jsonl"),
        "initial_opus_screen": _meter_screening(
            "screening.jsonl",
            "claude-opus-4-8",
        ),
        "remaining_construction": _meter_construction(
            "remaining-medium-construction.jsonl"
        ),
        "remaining_opus_first_two": _meter_screening(
            "remaining-medium-screening.jsonl",
            "claude-opus-4-8",
        ),
        "remaining_opus_third": _meter_screening(
            "remaining-medium-third-trial.jsonl",
            "claude-opus-4-8",
        ),
        "sonnet_tier_down": _meter_screening(
            "tier-down-screening.jsonl",
            "claude-sonnet-4-6",
        ),
    }
    initial = _classify(_outcomes(("screening.jsonl",)))
    remaining = _classify(
        _outcomes(
            (
                "remaining-medium-screening.jsonl",
                "remaining-medium-third-trial.jsonl",
            )
        )
    )
    tier_down = _classify(_outcomes(("tier-down-screening.jsonl",)))
    opus_boundaries = tuple(
        result["source_id"]
        for result in (*initial, *remaining)
        if result["operating_point"] == "boundary"
    )
    report = {
        "actual_metered_cost_usd": round(
            sum(float(component["cost_usd"]) for component in components.values()),
            6,
        ),
        "components": components,
        "goal_met": len(opus_boundaries) >= 3,
        "opus_4_8_results": (*initial, *remaining),
        "recommended_instances": opus_boundaries,
        "recommended_model": "claude-opus-4-8",
        "schema_version": 1,
        "sonnet_4_6_results": tier_down,
    }
    if not report["goal_met"]:
        raise ValueError("round two did not find three Opus boundaries")
    if report["actual_metered_cost_usd"] > 5.0:
        raise ValueError("round two exceeded its spend cap")
    atomic_write(REPORT, canonical_bytes(report) + b"\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
