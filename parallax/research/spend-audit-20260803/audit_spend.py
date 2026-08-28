"""Recompute every paid Parallax run's spend from committed evidence tokens.

Four separate hardcoded pricing tables meant several evidence files recorded
`estimated_cost_usd` at the retired Opus 4.1 rate card ($15/$75 per million)
while the work was done by Opus 4.8 ($5/$25) or, worse, by Haiku ($1/$5).
Summing those receipts overstates spend by up to fifteen times, so this audit
ignores every recorded dollar figure and re-meters from the retained token
counts through `parallax.metering`, the one canonical rate table.

Two other ways of double-counting are handled explicitly:

- A crashed run's episodes are replayed from cache by the resume, so the same
  payment appears in several evidence files. Each replay relation below is
  asserted, not assumed: shared units must carry identical token counts, and
  the audit fails if a supposed replay actually re-paid.
- A unit that failed before inference records zero tokens and cost nothing.
  A unit that failed *after* inference under a pre-fix failure path recorded
  zero tokens but did cost money; those are declared as unmetered gaps with an
  explicit basis and bound rather than folded silently into a total.

Run: `uv run python research/spend-audit-20260803/audit_spend.py`
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from parallax.canonical import atomic_write, canonical_bytes
from parallax.metering import (
    PRICING_AS_OF,
    PRICING_SOURCE,
    MeteredUsage,
    meter,
    pricing_for,
    total,
)
from parallax.screening import ScreeningRun, read_screening_jsonl

RESEARCH = Path(__file__).resolve().parent.parent
OUTPUT = Path(__file__).resolve().parent / "spend-ledger.json"

RETIRED_OPUS_PRICING = (15.0, 75.0)  # Opus 4.1, the stale constant's rate card

UnitKey = tuple[str, int, str]
Payments = dict[UnitKey, MeteredUsage]


@dataclass(frozen=True)
class ScreeningFile:
    """One screening/experiment evidence file and how it relates to others."""

    path: str
    label: str
    replay_of: tuple[str, ...] = ()
    superseded_units: tuple[UnitKey, ...] = ()


@dataclass(frozen=True)
class ConstructionFile:
    path: str
    label: str


@dataclass(frozen=True)
class UnmeteredGap:
    label: str
    episodes: int
    basis: str
    low_usd: float
    high_usd: float


@dataclass(frozen=True)
class Run:
    folder: str
    title: str
    screening: tuple[ScreeningFile, ...] = ()
    constructions: tuple[ConstructionFile, ...] = ()
    checkpoint: tuple[str, ...] = ()
    gaps: tuple[UnmeteredGap, ...] = ()
    notes: tuple[str, ...] = field(default_factory=tuple)


ASTROPY = "swebench:astropy__astropy-14508"
XARRAY = "swebench:pydata__xarray-4695"

RUNS = (
    Run(
        folder="swebench-screening-run-20260802",
        title="SWE-bench screening round 1",
        screening=(
            ScreeningFile(
                "evidence/screening-wheel-harness-failure.jsonl",
                "first harness attempt (wheel missing a fixture)",
            ),
            ScreeningFile(
                "evidence/screening.jsonl",
                "evaluator-only regrade of the same paid episodes",
                replay_of=("evidence/screening-wheel-harness-failure.jsonl",),
            ),
            ScreeningFile("evidence/screening-preflight-failure.jsonl", "preflight"),
            ScreeningFile(
                "evidence/screening-mcp-preflight-failure.jsonl", "preflight"
            ),
            ScreeningFile(
                "evidence/screening-ownership-preflight-failure.jsonl", "preflight"
            ),
        ),
        constructions=(
            ConstructionFile("evidence/construction.jsonl", "construction"),
        ),
        gaps=(
            UnmeteredGap(
                label="three construction responses that failed before usage capture",
                episodes=3,
                basis=(
                    "same conservative method the run used: charge every prompt "
                    "UTF-8 byte as a token plus the full 1024-token output cap, "
                    "but at Haiku 4.5 rates, which is the model that was called"
                ),
                low_usd=0.0,
                high_usd=3 * (2473 * 1.0 + 1024 * 5.0) / 1_000_000,
            ),
        ),
        notes=(
            "The regrade replayed cached episodes, so the two 10-unit files are "
            "one payment, not two.",
            "Preflight failures aborted before any inference and cost nothing.",
        ),
    ),
    Run(
        folder="swebench-screening-round2-20260803",
        title="SWE-bench screening round 2",
        screening=(
            ScreeningFile(
                "evidence/screening-byte-scan-failure.jsonl",
                "first six-instance screen, stopped by the compile-time leak scan",
            ),
            ScreeningFile(
                "evidence/screening.jsonl",
                "resumed six-instance screen",
                replay_of=("evidence/screening-byte-scan-failure.jsonl",),
            ),
            ScreeningFile("evidence/tier-down-screening.jsonl", "Sonnet tier-down"),
            ScreeningFile(
                "evidence/remaining-medium-docker-failure.jsonl",
                "remaining-medium screen, stopped by a full host disk",
            ),
            ScreeningFile(
                "evidence/remaining-medium-docker-failure-2.jsonl",
                "second disk failure over the same cache",
                replay_of=("evidence/remaining-medium-docker-failure.jsonl",),
            ),
            ScreeningFile(
                "evidence/remaining-medium-screening.jsonl",
                "remaining-medium screen, trials 0 and 1",
                replay_of=("evidence/remaining-medium-docker-failure-2.jsonl",),
            ),
            ScreeningFile(
                "evidence/remaining-medium-third-trial.jsonl",
                "remaining-medium third trial (fresh episodes)",
            ),
        ),
        constructions=(
            ConstructionFile("evidence/construction.jsonl", "initial construction"),
            ConstructionFile(
                "evidence/remaining-medium-construction.jsonl",
                "remaining-medium construction",
            ),
        ),
        notes=(
            "The leak scan and the Docker failures both aborted before inference: "
            "their zero-token rows are genuinely zero-cost, and the units they "
            "never reached were paid for once, later.",
            "The third-trial file reuses trial index 0 in its own design, so its "
            "units are fresh episodes rather than replays.",
        ),
    ),
    Run(
        folder="swebench-single-vs-evolved-20260803",
        title="Single-vs-evolved contrast (18 units)",
        screening=(
            ScreeningFile(
                "evidence/experiment-delivery-wire-failure.jsonl",
                "run 1, lost to the delivery-receipt wire defect",
            ),
            ScreeningFile(
                "evidence/experiment-frame-limit-failure.jsonl",
                "run 2, lost to the 64KiB stream frame limit",
            ),
            ScreeningFile(
                "evidence/experiment-connection-failures.jsonl",
                "run 3, gateway connection failures",
                replay_of=("evidence/experiment-frame-limit-failure.jsonl",),
                superseded_units=((ASTROPY, 0, "evolved"),),
            ),
            ScreeningFile(
                "evidence/experiment.jsonl",
                "run 4, final recovery",
                replay_of=("evidence/experiment-connection-failures.jsonl",),
                superseded_units=tuple(
                    (XARRAY, trial, arm)
                    for trial in (0, 1, 2)
                    for arm in ("static", "evolved")
                    if (trial, arm) != (1, "evolved")
                ),
            ),
        ),
        gaps=(
            UnmeteredGap(
                label="run 1's destroyed episodes, which the pre-fix failure path "
                "recorded as zero",
                episodes=4,
                basis=(
                    "the same three-to-four astropy units cost this much when they "
                    "were re-run and metered (static trial-0 $0.128415, evolved "
                    "trial-0 $0.087925, static trial-1 $0.095215, evolved trial-1 "
                    "$0.080445); no episode in this experiment cost more than "
                    "$0.13, which bounds four of them"
                ),
                low_usd=0.311555,
                high_usd=0.52,
            ),
        ),
        notes=(
            "Runs 2 and 3 each had episodes destroyed before the harness could "
            "grade them; those payments are real and are counted where they were "
            "made, while the replacement episode is counted again in the later run.",
        ),
    ),
    Run(
        folder="checkpoint-evolution-slice",
        title="Checkpoint-evolution screening",
        checkpoint=("evidence/screening.jsonl",),
        notes=(
            "`dry-run.jsonl` and `dry-run-sandbox.jsonl` never contacted a "
            "provider and cost nothing.",
        ),
    ),
)


def _unit_key(run: ScreeningRun) -> UnitKey:
    return (str(run.unit.source_id), int(run.unit.trial_index), str(run.unit.arm))


def _screening_payments(path: Path) -> tuple[Payments, float]:
    """Re-meter one screening file, returning payments and its receipt sum."""
    payments: Payments = {}
    receipts = 0.0
    for record in read_screening_jsonl(path):
        if not isinstance(record, ScreeningRun):
            continue
        receipts += record.estimated_cost_usd
        if record.prompt_tokens + record.completion_tokens == 0:
            continue
        payments[_unit_key(record)] = meter(
            record.reported_model,
            prompt_tokens=record.prompt_tokens,
            completion_tokens=record.completion_tokens,
        )
    return payments, receipts


def _construction_payments(path: Path) -> tuple[MeteredUsage, float]:
    usages: list[MeteredUsage] = []
    receipts = 0.0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        receipt = json.loads(line)
        requested = receipt["requested_model"]
        reported = receipt["reported_model"]
        if not reported.startswith(requested):
            raise ValueError(
                f"{path.name}: provider reported {reported!r} for a "
                f"{requested!r} request, so the rate card may not apply"
            )
        receipts += receipt["estimated_cost_usd"]
        usages.append(
            meter(
                requested,
                prompt_tokens=receipt["prompt_tokens"],
                completion_tokens=receipt["completion_tokens"],
            )
        )
    return total(usages), receipts


def _checkpoint_payments(path: Path) -> tuple[MeteredUsage, float]:
    usages: list[MeteredUsage] = []
    receipts = 0.0
    for line in path.read_text().splitlines():
        record = json.loads(line)
        if record.get("kind") != "ce_run":
            continue
        for stage in record["receipts"]:
            usage = stage["usage"]
            receipts += usage["estimated_cost_usd"]
            usages.append(
                meter(
                    record["agent_model"],
                    prompt_tokens=usage["prompt_tokens"],
                    completion_tokens=usage["completion_tokens"],
                )
            )
    return total(usages), receipts


def _assert_replay(
    label: str,
    later: Payments,
    earlier: Payments,
    superseded: Iterable[UnitKey],
) -> None:
    """A replay must carry its cached episode's exact tokens, or it re-paid."""
    allowed = set(superseded)
    for key, usage in earlier.items():
        if key in allowed:
            continue
        replayed = later.get(key)
        if replayed is None:
            raise ValueError(f"{label}: unit {key!r} vanished from the later file")
        if (replayed.prompt_tokens, replayed.completion_tokens) != (
            usage.prompt_tokens,
            usage.completion_tokens,
        ):
            raise ValueError(
                f"{label}: unit {key!r} was re-paid, not replayed "
                f"({usage} then {replayed}); it is not a replay relation"
            )


def _charged_here(
    key: UnitKey,
    spec: ScreeningFile,
    by_path: dict[str, Payments],
) -> bool:
    """A payment belongs to the file where it was made, not where it replayed."""
    if key in spec.superseded_units:
        return True
    return not any(key in by_path[source] for source in spec.replay_of)


def _retired_rate_factor(model: str) -> float:
    """How much a retired-Opus receipt overstates this model's true cost."""
    pricing = pricing_for(model)
    return (
        RETIRED_OPUS_PRICING[1] / pricing.output_usd_per_million
        if pricing.output_usd_per_million
        else float("nan")
    )


def audit() -> dict[str, object]:
    runs: dict[str, object] = {}
    grand_metered = 0.0
    grand_low = 0.0
    grand_high = 0.0
    for run in RUNS:
        folder = RESEARCH / run.folder
        files: dict[str, object] = {}
        by_path: dict[str, Payments] = {}
        metered = MeteredUsage()
        receipt_sum = 0.0
        for spec in run.screening:
            payments, receipts = _screening_payments(folder / spec.path)
            by_path[spec.path] = payments
            receipt_sum += receipts
            for source in spec.replay_of:
                _assert_replay(
                    f"{run.folder}/{spec.path}",
                    payments,
                    by_path[source],
                    spec.superseded_units,
                )
            charged = {
                key: usage
                for key, usage in payments.items()
                if _charged_here(key, spec, by_path)
            }
            unique = total(charged.values())
            metered = metered + unique
            files[spec.path] = {
                "label": spec.label,
                "units_with_usage": len(payments),
                "units_charged_here": len(charged),
                "receipt_sum_usd": receipts,
                "token_derived_usd": unique.cost_usd,
                "prompt_tokens": unique.prompt_tokens,
                "completion_tokens": unique.completion_tokens,
            }
        for construction in run.constructions:
            usage, receipts = _construction_payments(folder / construction.path)
            receipt_sum += receipts
            metered = metered + usage
            files[construction.path] = {
                "label": construction.label,
                "receipt_sum_usd": receipts,
                "token_derived_usd": usage.cost_usd,
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
            }
        for path in run.checkpoint:
            usage, receipts = _checkpoint_payments(folder / path)
            receipt_sum += receipts
            metered = metered + usage
            files[path] = {
                "label": "checkpoint stage calls",
                "receipt_sum_usd": receipts,
                "token_derived_usd": usage.cost_usd,
                "prompt_tokens": usage.prompt_tokens,
                "completion_tokens": usage.completion_tokens,
            }
        gaps = [
            {
                "label": gap.label,
                "episodes": gap.episodes,
                "basis": gap.basis,
                "low_usd": gap.low_usd,
                "high_usd": gap.high_usd,
            }
            for gap in run.gaps
        ]
        low = metered.cost_usd + sum(gap.low_usd for gap in run.gaps)
        high = metered.cost_usd + sum(gap.high_usd for gap in run.gaps)
        grand_metered += metered.cost_usd
        grand_low += low
        grand_high += high
        runs[run.folder] = {
            "title": run.title,
            "token_derived_metered_usd": metered.cost_usd,
            "prompt_tokens": metered.prompt_tokens,
            "completion_tokens": metered.completion_tokens,
            "receipt_sum_as_written_usd": receipt_sum,
            "receipts_overstate_by": (
                receipt_sum / metered.cost_usd if metered.cost_usd else None
            ),
            "unmetered_gaps": gaps,
            "all_in_low_usd": low,
            "all_in_high_usd": high,
            "files": files,
            "notes": list(run.notes),
        }
    return {
        "schema_version": 1,
        "pricing_as_of": PRICING_AS_OF.isoformat(),
        "pricing_source": PRICING_SOURCE,
        "method": (
            "every figure is re-metered from the token counts retained in "
            "committed evidence, at the canonical rates in parallax.metering; "
            "recorded estimated_cost_usd values are reported only for contrast"
        ),
        "retired_opus_rate_card_usd_per_million": {
            "input": RETIRED_OPUS_PRICING[0],
            "output": RETIRED_OPUS_PRICING[1],
        },
        "retired_receipt_overstatement_factor": {
            model: _retired_rate_factor(model)
            for model in ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5")
        },
        "runs": runs,
        "totals": {
            "token_derived_metered_usd": grand_metered,
            "all_in_low_usd": grand_low,
            "all_in_high_usd": grand_high,
        },
    }


def main() -> None:
    ledger = audit()
    atomic_write(OUTPUT, canonical_bytes(ledger) + b"\n")
    print(json.dumps(ledger, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
