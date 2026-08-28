"""The one experiment loop: plan, admit, execute, resume, meter, journal.

Config in, evidence out. Everything that varied between the four dated research
drivers is a field on `ExperimentConfig`; everything that was identical in all
of them lives here once.

The journal is the part worth reading twice. Every completed unit is appended
and fsynced to a `.partial` file before the next one starts, and the file is
only linked into place when the plan is exhausted. That is what survived a
disk-full crash, a gateway outage, and three relaunches without double-paying
for a unit or writing a duplicate row, so it is preserved verbatim rather than
tidied.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Annotated, Literal, Self, TypeAlias

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .delivery import CompleteDeliveryReceiptV1
from .outcome import FailureKind, Outcome, RunFailure, Verification
from .perturbation import Condition, Variant, VariantSet, headroom_mismatch
from .task import Task
from .types import (
    ConditionDigest,
    DesignDigest,
    ModelConfigDigest,
    NonEmptyText,
    NonNegativeInt,
    PositiveInt,
    SourceDigest,
    SourceId,
    StrictModel,
    Temperature,
    TrialIndex,
    Usd,
)

DEFAULT_SPEND_CAP_USD = 5.0


class SpendApprovalRequired(RuntimeError):
    pass


class DesignError(ValueError):
    pass


class ExecutionError(RuntimeError):
    """An executor failure that already cost money.

    The metered usage travels on the exception so it survives into the failure
    row. Reporting a failed-but-paid episode as zero spend is how roughly four
    episodes of real inference went unaccounted for on the first flagship run.
    """

    def __init__(
        self,
        failure_kind: FailureKind,
        message: str,
        *,
        reported_model: str | None = None,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        estimated_cost_usd: float = 0.0,
    ) -> None:
        super().__init__(message)
        self.failure_kind = failure_kind
        self.reported_model = reported_model
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.estimated_cost_usd = estimated_cost_usd


class CostRange(StrictModel):
    lower_per_episode_usd: Usd = 0.10
    upper_per_episode_usd: Usd = 0.50

    @model_validator(mode="after")
    def ordered_range(self) -> Self:
        if self.lower_per_episode_usd > self.upper_per_episode_usd:
            raise ValueError("episode cost range is reversed")
        return self


class ExperimentConfig(StrictModel):
    """Everything that differed between the dated research drivers.

    `require_matched_headroom` is the one judgement call the type system
    deliberately does not make. Comparing conditions with unequal headroom is
    usually a mistake — it is exactly how the checkpoint screening measured a
    byte cap instead of a manipulation — but sometimes unequal allowance *is*
    the manipulation, so the experiment says which it meant and the plan records
    the answer either way.
    """

    model: NonEmptyText
    expected_response_model: NonEmptyText | None = None
    conditions: tuple[Condition, ...] = Field(min_length=1)
    trials: PositiveInt = 1
    temperature: Temperature = 1.0
    cost: CostRange = CostRange()
    spend_cap_usd: Usd = DEFAULT_SPEND_CAP_USD
    require_matched_headroom: bool = True
    policy: NonEmptyText = "parallax-experiment-v1"

    @model_validator(mode="after")
    def distinct_conditions(self) -> Self:
        if len(set(self.conditions)) != len(self.conditions):
            raise ValueError("an experiment cannot schedule a condition twice")
        if not math.isfinite(self.spend_cap_usd) or self.spend_cap_usd <= 0:
            raise ValueError("spend cap must be finite and positive")
        return self

    @property
    def response_model(self) -> str:
        return self.expected_response_model or self.model


class PlannedTask(StrictModel):
    task_id: SourceId
    public_digest: SourceDigest
    verifier_digest: NonEmptyText
    condition_digests: tuple[tuple[Condition, ConditionDigest], ...]


class Unit(StrictModel):
    task_id: SourceId
    public_digest: SourceDigest
    verifier_digest: NonEmptyText
    trial_index: TrialIndex
    condition: Condition


class Plan(StrictModel):
    kind: Literal["plan"] = "plan"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    model: NonEmptyText
    expected_response_model: NonEmptyText
    model_config_digest: ModelConfigDigest
    temperature: Temperature
    tasks: tuple[PlannedTask, ...] = Field(min_length=1)
    units: tuple[Unit, ...] = Field(min_length=1)
    cost: CostRange
    headroom: tuple[tuple[Condition, int], ...]
    headroom_matched: bool

    @model_validator(mode="after")
    def valid_design(self) -> Self:
        keys = tuple(
            (unit.task_id, unit.trial_index, unit.condition) for unit in self.units
        )
        if len(set(keys)) != len(keys):
            raise ValueError("experiment units must be unique")
        planned = {task.task_id for task in self.tasks}
        if {unit.task_id for unit in self.units} != planned:
            raise ValueError("experiment units and tasks differ")
        body = self.model_dump(mode="json", exclude={"design_digest", "kind"})
        if canonical_digest(body) != self.design_digest:
            raise ValueError("experiment design digest mismatch")
        return self

    @property
    def estimated_cost_lower_usd(self) -> float:
        return len(self.units) * self.cost.lower_per_episode_usd

    @property
    def estimated_cost_upper_usd(self) -> float:
        return len(self.units) * self.cost.upper_per_episode_usd


def _sealed(**fields: object) -> Plan:
    """Digest a plan from the plan itself.

    The digested body used to be a dict written out by hand next to the
    constructor call, so adding a field to the design left it out of the digest
    and preregistered nothing. Here there is one description of the plan.
    """

    draft = Plan.model_construct(design_digest=DesignDigest("0" * 64), **fields)
    body = draft.model_dump(mode="json", exclude={"design_digest", "kind"})
    sealed = {**body, "design_digest": canonical_digest(body)}
    return Plan.model_validate_json(canonical_bytes(sealed))


class Execution(StrictModel):
    """What an executor reports for one unit.

    `fresh` distinguishes an episode this process paid for from one replayed out
    of a cache. Without it, summing the cost column of a resumed journal
    double-counts every replayed unit, which took a 160-line forensic
    reconstruction to untangle after the fact.
    """

    outcome: Outcome
    reported_model: NonEmptyText
    prompt_tokens: NonNegativeInt
    completion_tokens: NonNegativeInt
    estimated_cost_usd: Usd
    fresh: bool = True
    verifier_report_digest: str | None = None
    harness_revision: str | None = None
    image_digest: str | None = None
    delivery: CompleteDeliveryReceiptV1 | None = None

    @model_validator(mode="after")
    def consistent_usage(self) -> Self:
        if (
            isinstance(self.outcome, Verification)
            and self.prompt_tokens + self.completion_tokens < 1
        ):
            raise ValueError("a verified unit must have consumed at least one token")
        return self


class Observation(StrictModel):
    kind: Literal["observation"] = "observation"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    model_config_digest: ModelConfigDigest
    reported_model: NonEmptyText
    unit: Unit
    outcome: Outcome
    prompt_tokens: NonNegativeInt
    completion_tokens: NonNegativeInt
    estimated_cost_usd: Usd
    fresh: bool = True
    verifier_report_digest: str | None = None
    harness_revision: str | None = None
    image_digest: str | None = None
    delivery: CompleteDeliveryReceiptV1 | None = None

    @property
    def key(self) -> tuple[SourceId, TrialIndex, Condition]:
        return (self.unit.task_id, self.unit.trial_index, self.unit.condition)


Record: TypeAlias = Annotated[Plan | Observation, Field(discriminator="kind")]
Executor: TypeAlias = Callable[[Unit], Execution]
Progress: TypeAlias = Callable[[str], None]
_RECORD = TypeAdapter(Record)


def _canonical_line(record: Record) -> bytes:
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


def plan_experiment(
    prepared: Iterable[tuple[Task, VariantSet]],
    config: ExperimentConfig,
) -> Plan:
    """Preregister one design: which tasks, which conditions, which trials.

    Raises before any money is spent if a scheduled condition was never
    constructed, or if the conditions are not headroom-matched and the config
    asked that they be.
    """

    ordered = sorted(prepared, key=lambda pair: pair[0].task_id)
    if not ordered:
        raise DesignError("an experiment needs at least one task")
    task_ids = [task.task_id for task, _ in ordered]
    if len(set(task_ids)) != len(task_ids):
        raise DesignError("task ids must be unique")
    selected: list[tuple[Task, tuple[Variant, ...]]] = []
    for task, variant_set in ordered:
        if variant_set.task_id != task.task_id:
            raise DesignError(
                f"variant set {variant_set.task_id} does not belong to {task.task_id}"
            )
        missing = set(config.conditions) - set(variant_set.conditions)
        if missing:
            raise DesignError(
                f"{task.task_id} was not constructed for conditions {sorted(missing)}"
            )
        selected.append(
            (task, tuple(variant_set.variant(name) for name in config.conditions))
        )
    mismatch = headroom_mismatch(
        tuple(variant for _, variants in selected for variant in variants)
    )
    if mismatch is not None and config.require_matched_headroom:
        raise DesignError(
            "scheduled conditions are not headroom-matched, so a contrast "
            f"between them would measure the allowance: {mismatch}"
        )
    headroom = tuple(
        (
            name,
            sum(
                variants[index].total_headroom
                for _, variants in selected
                for index in (config.conditions.index(name),)
            ),
        )
        for name in config.conditions
    )
    model_digest = ModelConfigDigest(
        canonical_digest(
            {
                "conditions": list(config.conditions),
                "model": config.model,
                "expected_response_model": config.response_model,
                "policy": config.policy,
                "temperature": config.temperature,
            }
        )
    )
    tasks = tuple(
        PlannedTask(
            task_id=task.task_id,
            public_digest=SourceDigest(task.public_digest),
            verifier_digest=task.verifier_digest,
            condition_digests=tuple(
                (variant.condition, variant.digest) for variant in variants
            ),
        )
        for task, variants in selected
    )
    units = tuple(
        Unit(
            task_id=planned.task_id,
            public_digest=planned.public_digest,
            verifier_digest=planned.verifier_digest,
            trial_index=TrialIndex(index),
            condition=condition,
        )
        for planned in tasks
        for index in range(config.trials)
        for condition in config.conditions
    )
    return _sealed(
        model=config.model,
        expected_response_model=config.response_model,
        model_config_digest=model_digest,
        temperature=config.temperature,
        tasks=tasks,
        units=units,
        cost=config.cost,
        headroom=headroom,
        headroom_matched=mismatch is None,
    )


def write_plan(plan: Plan, path: Path) -> None:
    atomic_write(path, _canonical_line(plan))


def read_journal(path: Path) -> tuple[Record, ...]:
    records: list[Record] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                records.append(_RECORD.validate_json(line))
            except ValidationError as error:
                detail = error.errors(include_url=False)[0]["msg"]
                raise ValueError(f"line {line_number}: {detail}") from error
    return tuple(records)


def journal_contents(path: Path) -> tuple[Plan, tuple[Observation, ...]]:
    """Split a journal into its one plan and its observations."""

    records = read_journal(path)
    if not records or not isinstance(records[0], Plan):
        raise ValueError(f"journal does not begin with a plan: {path}")
    observations = tuple(
        record for record in records[1:] if isinstance(record, Observation)
    )
    if len(observations) != len(records) - 1:
        raise ValueError(f"journal contains a second plan: {path}")
    return records[0], observations


def total_spend_usd(observations: Iterable[Observation]) -> float:
    """Sum only what was actually paid for.

    Replayed units carry the cost of the episode they replay so that a single
    file still shows what a design costs, which means naive summation
    double-counts across sessions. `fresh` is the discriminator.
    """

    return sum(
        observation.estimated_cost_usd
        for observation in observations
        if observation.fresh
    )


def _partial_path(journal_path: Path) -> Path:
    return journal_path.with_name(f"{journal_path.name}.partial")


def _append_fsync(path: Path, data: bytes, *, exclusive: bool = False) -> None:
    with path.open("xb" if exclusive else "ab") as destination:
        destination.write(data)
        destination.flush()
        os.fsync(destination.fileno())


def _finalize(partial_path: Path, journal_path: Path) -> None:
    os.link(partial_path, journal_path)
    os.unlink(partial_path)
    directory = os.open(journal_path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _resume(plan: Plan, partial_path: Path) -> list[Observation]:
    records = read_journal(partial_path)
    if not records or records[0] != plan:
        raise ValueError("the existing journal was written for a different plan")
    observations = [record for record in records[1:] if isinstance(record, Observation)]
    if len(observations) != len(records) - 1:
        raise ValueError("journal contains a second plan")
    if len({item.key for item in observations}) != len(observations):
        raise ValueError("journal contains duplicate completed units")
    scheduled = set(plan.units)
    if any(item.unit not in scheduled for item in observations):
        raise ValueError("journal contains an unscheduled unit")
    if any(
        item.design_digest != plan.design_digest
        or item.model_config_digest != plan.model_config_digest
        for item in observations
    ):
        raise ValueError("journal identity differs from the plan")
    return observations


def _failure_execution(plan: Plan, error: Exception) -> Execution:
    if isinstance(error, ExecutionError):
        return Execution(
            outcome=RunFailure(
                failure_kind=error.failure_kind,
                error_type=type(error).__name__,
                message=str(error),
            ),
            reported_model=error.reported_model or plan.expected_response_model,
            prompt_tokens=error.prompt_tokens,
            completion_tokens=error.completion_tokens,
            estimated_cost_usd=error.estimated_cost_usd,
        )
    return Execution(
        outcome=RunFailure(
            failure_kind="agent",
            error_type=type(error).__name__,
            message=str(error),
        ),
        reported_model=plan.expected_response_model,
        prompt_tokens=0,
        completion_tokens=0,
        estimated_cost_usd=0.0,
    )


def _observe(plan: Plan, unit: Unit, execution: Execution) -> Observation:
    outcome = execution.outcome
    if execution.reported_model != plan.expected_response_model:
        outcome = RunFailure(
            failure_kind="agent",
            error_type="ProviderModelMismatch",
            message=(
                f"expected {plan.expected_response_model}, "
                f"provider reported {execution.reported_model}"
            ),
        )
    return Observation(
        design_digest=plan.design_digest,
        model_config_digest=plan.model_config_digest,
        reported_model=execution.reported_model,
        unit=unit,
        outcome=outcome,
        prompt_tokens=execution.prompt_tokens,
        completion_tokens=execution.completion_tokens,
        estimated_cost_usd=execution.estimated_cost_usd,
        fresh=execution.fresh,
        verifier_report_digest=execution.verifier_report_digest,
        harness_revision=execution.harness_revision,
        image_digest=execution.image_digest,
        delivery=execution.delivery,
    )


def execute(
    plan: Plan,
    executor: Executor,
    *,
    journal_path: Path,
    approve_spend: bool = False,
    spend_cap_usd: float = DEFAULT_SPEND_CAP_USD,
    progress: Progress | None = None,
) -> tuple[Observation, ...]:
    """Run every scheduled unit, resuming and metering as it goes.

    A finalized journal for this exact plan short-circuits: it is validated and
    returned without spending anything, so relaunching a completed run is safe
    and every driver stops needing its own "already done?" branch.
    """

    report = progress if progress is not None else _default_progress
    if journal_path.exists():
        stored, observations = journal_contents(journal_path)
        if stored != plan:
            raise ValueError(
                f"completed journal is for a different plan: {journal_path}"
            )
        report(f"journal complete: {len(observations)} units, nothing to run")
        return observations
    if not math.isfinite(spend_cap_usd) or spend_cap_usd <= 0:
        raise ValueError("spend cap must be finite and positive")
    upper = plan.estimated_cost_upper_usd
    if upper > spend_cap_usd:
        raise SpendApprovalRequired(
            f"upper estimate ${upper:.2f} exceeds the ${spend_cap_usd:.2f} cap"
        )
    if not approve_spend:
        raise SpendApprovalRequired(
            f"this run requires approval for an estimated "
            f"${plan.estimated_cost_lower_usd:.2f}-${upper:.2f}"
        )
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    partial_path = _partial_path(journal_path)
    if partial_path.exists():
        observations = _resume(plan, partial_path)
    else:
        _append_fsync(partial_path, _canonical_line(plan), exclusive=True)
        observations = []
    completed = {item.key for item in observations}
    spent = sum(item.estimated_cost_usd for item in observations)
    if spent > spend_cap_usd:
        raise SpendApprovalRequired(
            f"observed cost ${spent:.2f} exceeds the ${spend_cap_usd:.2f} cap"
        )
    if observations:
        report(f"resuming: {len(observations)}/{len(plan.units)} units recorded")
    for unit in plan.units:
        key = (unit.task_id, unit.trial_index, unit.condition)
        if key in completed:
            continue
        if spent + plan.cost.upper_per_episode_usd > spend_cap_usd:
            raise SpendApprovalRequired(
                f"the next unit could exceed the ${spend_cap_usd:.2f} cap"
            )
        report(
            f"start task={unit.task_id} trial={unit.trial_index} "
            f"condition={unit.condition}"
        )
        try:
            execution = executor(unit)
        except Exception as error:
            execution = _failure_execution(plan, error)
        observation = _observe(plan, unit, execution)
        observations.append(observation)
        spent += observation.estimated_cost_usd
        _append_fsync(partial_path, _canonical_line(observation))
        report(
            f"done  task={unit.task_id} trial={unit.trial_index} "
            f"condition={unit.condition} outcome={observation.outcome.kind} "
            f"cost=${observation.estimated_cost_usd:.6f} spent=${spent:.2f}"
        )
        if spent > spend_cap_usd:
            raise SpendApprovalRequired(
                f"observed cost ${spent:.2f} exceeds the ${spend_cap_usd:.2f} cap"
            )
    _finalize(partial_path, journal_path)
    return tuple(observations)


def _default_progress(line: str) -> None:
    """Print progress by default.

    A paid run can take hours inside Docker with no other signal that it is
    alive, and the console log is what an operator watches. Silence by default
    is the wrong trade here; pass `progress=lambda _: None` to opt out.
    """

    print(f"[parallax] {line}", flush=True)
