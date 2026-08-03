from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Annotated, Literal, Self, TypeAlias, assert_never

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from .evolving_intent import Arm
from .gsm8k import Verdict, Verification
from .runner import FailureKind, Outcome, RunFailure, atomic_write, canonical_digest
from .swebench import SweBenchProblem
from .types import (
    DesignDigest,
    ModelConfigDigest,
    SourceDigest,
    SourceId,
    StrictModel,
    TrialIndex,
    TrialSeed,
)

Usd = Annotated[float, Field(ge=0, allow_inf_nan=False)]
SCREENING_SPEND_CAP_USD = 5.0


class SpendApprovalRequired(RuntimeError):
    pass


class ScreeningExecutionError(RuntimeError):
    def __init__(self, failure_kind: FailureKind, message: str) -> None:
        super().__init__(message)
        self.failure_kind = failure_kind


class ScreeningCost(StrictModel):
    lower_per_episode_usd: Usd = 0.10
    upper_per_episode_usd: Usd = 0.50

    @model_validator(mode="after")
    def ordered_range(self) -> Self:
        if self.lower_per_episode_usd > self.upper_per_episode_usd:
            raise ValueError("screening cost range is reversed")
        return self


class ScreeningSource(StrictModel):
    source_id: SourceId
    source_digest: SourceDigest
    verifier_digest: str


class ScreeningUnit(StrictModel):
    source_id: SourceId
    source_digest: SourceDigest
    verifier_digest: str
    trial_index: TrialIndex
    trial_seed: TrialSeed
    arm: Arm


class ScreeningPlan(StrictModel):
    kind: Literal["screening_manifest"] = "screening_manifest"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    model: str
    model_config_digest: ModelConfigDigest
    sources: Annotated[tuple[ScreeningSource, ...], Field(min_length=1)]
    units: Annotated[tuple[ScreeningUnit, ...], Field(min_length=1)]
    cost: ScreeningCost

    @model_validator(mode="after")
    def valid_design(self) -> Self:
        keys = tuple(
            (unit.source_id, unit.trial_index, unit.arm) for unit in self.units
        )
        if len(set(keys)) != len(keys):
            raise ValueError("screening units must be unique")
        source_ids = {source.source_id for source in self.sources}
        if {unit.source_id for unit in self.units} != source_ids:
            raise ValueError("screening units and sources differ")
        body = self.model_dump(
            mode="json",
            exclude={"design_digest", "kind"},
        )
        if canonical_digest(body) != self.design_digest:
            raise ValueError("screening design digest mismatch")
        return self

    @property
    def estimated_cost_lower_usd(self) -> float:
        return len(self.units) * self.cost.lower_per_episode_usd

    @property
    def estimated_cost_upper_usd(self) -> float:
        return len(self.units) * self.cost.upper_per_episode_usd


class ScreeningRun(StrictModel):
    kind: Literal["screening_run"] = "screening_run"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    model_config_digest: ModelConfigDigest
    unit: ScreeningUnit
    outcome: Outcome
    prompt_tokens: Annotated[int, Field(ge=0)]
    completion_tokens: Annotated[int, Field(ge=0)]
    estimated_cost_usd: Usd


class ScreeningExecution(StrictModel):
    outcome: Outcome
    prompt_tokens: Annotated[int, Field(ge=0)]
    completion_tokens: Annotated[int, Field(ge=0)]
    estimated_cost_usd: Usd


ScreeningRecord: TypeAlias = Annotated[
    ScreeningPlan | ScreeningRun,
    Field(discriminator="kind"),
]
ScreeningExecutor: TypeAlias = Callable[[ScreeningUnit], ScreeningExecution]
_SCREENING_RECORD = TypeAdapter(ScreeningRecord)


class ScreeningSourceResult(StrictModel):
    source_id: SourceId
    verified_trials: Annotated[int, Field(ge=0)]
    run_failures: Annotated[int, Field(ge=0)]
    pass_rate: Annotated[float, Field(ge=0, le=1)] | None
    operating_point: Literal["floor", "boundary", "ceiling", "unknown"]


class ScreeningSummary(StrictModel):
    design_digest: DesignDigest
    sources: tuple[ScreeningSourceResult, ...]
    boundary_sources: tuple[SourceId, ...]
    action: Literal["proceed", "change_model_or_instances"]


def _canonical_line(record: ScreeningRecord) -> bytes:
    return (
        json.dumps(
            record.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
        + b"\n"
    )


def build_screening_plan(
    problems: Iterable[SweBenchProblem],
    *,
    model: str,
    trial_seeds: tuple[int, ...],
    arms: tuple[Arm, ...] = ("static",),
    cost: ScreeningCost | None = None,
) -> ScreeningPlan:
    ordered = tuple(sorted(problems, key=lambda item: item.record_id))
    selected_cost = cost or ScreeningCost()
    if not ordered or not trial_seeds or not arms:
        raise ValueError("screening sources, trials, and arms must be non-empty")
    if len({problem.record_id for problem in ordered}) != len(ordered):
        raise ValueError("screening source ids must be unique")
    model_digest = ModelConfigDigest(
        canonical_digest(
            {
                "arms": arms,
                "model": model,
                "screening_policy": "boundary-v1",
            }
        )
    )
    sources = tuple(
        ScreeningSource(
            source_id=problem.record_id,
            source_digest=SourceDigest(problem.public_digest),
            verifier_digest=problem.verifier.digest,
        )
        for problem in ordered
    )
    units = tuple(
        ScreeningUnit(
            source_id=source.source_id,
            source_digest=source.source_digest,
            verifier_digest=source.verifier_digest,
            trial_index=TrialIndex(index),
            trial_seed=TrialSeed(seed),
            arm=arm,
        )
        for source in sources
        for index, seed in enumerate(trial_seeds)
        for arm in arms
    )
    body = {
        "schema_version": 1,
        "model": model,
        "model_config_digest": model_digest,
        "sources": [source.model_dump(mode="json") for source in sources],
        "units": [unit.model_dump(mode="json") for unit in units],
        "cost": selected_cost.model_dump(mode="json"),
    }
    return ScreeningPlan(
        design_digest=DesignDigest(canonical_digest(body)),
        model=model,
        model_config_digest=model_digest,
        sources=sources,
        units=units,
        cost=selected_cost,
    )


def write_screening_plan(plan: ScreeningPlan, path: Path) -> None:
    atomic_write(path, _canonical_line(plan))


def read_screening_jsonl(path: Path) -> tuple[ScreeningRecord, ...]:
    records: list[ScreeningRecord] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                records.append(_SCREENING_RECORD.validate_json(line))
            except ValidationError as error:
                detail = error.errors(include_url=False)[0]["msg"]
                raise ValueError(f"line {line_number}: {detail}") from error
    return tuple(records)


def run_screening(
    plan: ScreeningPlan,
    executor: ScreeningExecutor,
    *,
    output_path: Path,
    approve_spend: bool = False,
    spend_cap_usd: float = SCREENING_SPEND_CAP_USD,
) -> tuple[ScreeningRun, ...]:
    if not math.isfinite(spend_cap_usd) or spend_cap_usd <= 0:
        raise ValueError("screening spend cap must be finite and positive")
    upper = plan.estimated_cost_upper_usd
    if upper > spend_cap_usd:
        raise SpendApprovalRequired(
            f"screening upper estimate ${upper:.2f} exceeds ${spend_cap_usd:.2f} cap"
        )
    if not approve_spend:
        raise SpendApprovalRequired(
            f"screening requires approval for estimated "
            f"${plan.estimated_cost_lower_usd:.2f}-${upper:.2f}"
        )
    runs: list[ScreeningRun] = []
    if output_path.exists():
        records = read_screening_jsonl(output_path)
        if not records or records[0] != plan:
            raise ValueError("existing screening manifest differs from plan")
        runs = [record for record in records[1:] if isinstance(record, ScreeningRun)]
        if len(runs) != len(records) - 1:
            raise ValueError("screening evidence contains a second manifest")
    else:
        atomic_write(output_path, _canonical_line(plan))
    completed = {
        (run.unit.source_id, run.unit.trial_index, run.unit.arm) for run in runs
    }
    if len(completed) != len(runs):
        raise ValueError("screening evidence contains duplicate completed units")
    expected_units = set(plan.units)
    if any(run.unit not in expected_units for run in runs):
        raise ValueError("screening evidence contains an unscheduled unit")
    if any(
        run.design_digest != plan.design_digest
        or run.model_config_digest != plan.model_config_digest
        for run in runs
    ):
        raise ValueError("screening evidence identity differs from plan")
    cumulative_cost = sum(run.estimated_cost_usd for run in runs)
    for unit in plan.units:
        key = (unit.source_id, unit.trial_index, unit.arm)
        if key in completed:
            continue
        if cumulative_cost + plan.cost.upper_per_episode_usd > spend_cap_usd:
            raise SpendApprovalRequired(
                f"next unit could exceed ${spend_cap_usd:.2f} cap"
            )
        try:
            execution = executor(unit)
        except ScreeningExecutionError as error:
            execution = ScreeningExecution(
                outcome=RunFailure(
                    failure_kind=error.failure_kind,
                    error_type=type(error).__name__,
                    message=str(error),
                ),
                prompt_tokens=0,
                completion_tokens=0,
                estimated_cost_usd=plan.cost.upper_per_episode_usd,
            )
        except Exception as error:
            execution = ScreeningExecution(
                outcome=RunFailure(
                    failure_kind="agent",
                    error_type=type(error).__name__,
                    message=str(error),
                ),
                prompt_tokens=0,
                completion_tokens=0,
                estimated_cost_usd=plan.cost.upper_per_episode_usd,
            )
        runs.append(
            ScreeningRun(
                design_digest=plan.design_digest,
                model_config_digest=plan.model_config_digest,
                unit=unit,
                outcome=execution.outcome,
                prompt_tokens=execution.prompt_tokens,
                completion_tokens=execution.completion_tokens,
                estimated_cost_usd=execution.estimated_cost_usd,
            )
        )
        cumulative_cost += execution.estimated_cost_usd
        data = _canonical_line(plan) + b"".join(_canonical_line(run) for run in runs)
        atomic_write(output_path, data)
    return tuple(runs)


def summarize_screening(
    plan: ScreeningPlan,
    runs: tuple[ScreeningRun, ...],
) -> ScreeningSummary:
    expected = {(unit.source_id, unit.trial_index, unit.arm) for unit in plan.units}
    actual: dict[tuple[SourceId, TrialIndex, Arm], ScreeningRun] = {}
    for run in runs:
        if (
            run.design_digest != plan.design_digest
            or run.model_config_digest != plan.model_config_digest
        ):
            raise ValueError("screening run identity drift")
        key = (run.unit.source_id, run.unit.trial_index, run.unit.arm)
        if key in actual:
            raise ValueError(f"duplicate screening run: {key!r}")
        actual[key] = run
    if set(actual) != expected:
        raise ValueError("screening runs differ from preregistered units")
    outcomes: dict[SourceId, list[Outcome]] = defaultdict(list)
    for run in actual.values():
        outcomes[run.unit.source_id].append(run.outcome)
    source_results: list[ScreeningSourceResult] = []
    for source_id, values in sorted(outcomes.items()):
        verdicts: Counter[Verdict] = Counter()
        failures = 0
        for outcome in values:
            if isinstance(outcome, Verification):
                verdicts[outcome.verdict] += 1
            elif isinstance(outcome, RunFailure):
                failures += 1
            else:
                assert_never(outcome)
        verified = sum(verdicts.values())
        pass_rate = verdicts[Verdict.PASS] / verified if verified else None
        operating_point: Literal["floor", "boundary", "ceiling", "unknown"]
        if pass_rate is None:
            operating_point = "unknown"
        elif pass_rate <= 0.1:
            operating_point = "floor"
        elif pass_rate >= 0.9:
            operating_point = "ceiling"
        else:
            operating_point = "boundary"
        source_results.append(
            ScreeningSourceResult(
                source_id=source_id,
                verified_trials=verified,
                run_failures=failures,
                pass_rate=pass_rate,
                operating_point=operating_point,
            )
        )
    boundary = tuple(
        result.source_id
        for result in source_results
        if result.operating_point == "boundary"
    )
    return ScreeningSummary(
        design_digest=plan.design_digest,
        sources=tuple(source_results),
        boundary_sources=boundary,
        action="proceed" if boundary else "change_model_or_instances",
    )
