from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes
from parallax.outcome import RunFailure, Verification
from parallax.screening import ScreeningRun, read_screening_jsonl

ROOT = Path(__file__).parent
EVIDENCE = ROOT / "evidence"
REPORT = ROOT / "round2-report.json"
RATES = {
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-4-6": (2.0, 10.0),
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
    prompt_tokens = sum(run.prompt_tokens for run in runs)
    completion_tokens = sum(run.completion_tokens for run in runs)
    input_rate, output_rate = RATES[model]
    return {
        "completion_tokens": completion_tokens,
        "cost_usd": round(
            (prompt_tokens * input_rate + completion_tokens * output_rate) / 1_000_000,
            6,
        ),
        "prompt_tokens": prompt_tokens,
    }


def _meter_construction(name: str) -> dict[str, int | float]:
    rows = tuple(
        json.loads(line) for line in (EVIDENCE / name).read_text().splitlines() if line
    )
    prompt_tokens = sum(row["prompt_tokens"] for row in rows)
    completion_tokens = sum(row["completion_tokens"] for row in rows)
    input_rate, output_rate = RATES["claude-haiku-4-5"]
    return {
        "completion_tokens": completion_tokens,
        "cost_usd": round(
            (prompt_tokens * input_rate + completion_tokens * output_rate) / 1_000_000,
            6,
        ),
        "prompt_tokens": prompt_tokens,
    }


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
        if pass_rate is None:
            operating_point = "unknown"
        elif pass_rate == 0:
            operating_point = "floor"
        elif pass_rate == 1:
            operating_point = "ceiling"
        else:
            operating_point = "boundary"
        results.append(
            {
                "operating_point": operating_point,
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
