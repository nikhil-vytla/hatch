from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Annotated, Literal, Self, TypeAlias

from pydantic import BaseModel, Field, TypeAdapter, ValidationError, model_validator

from .evolving_intent import (
    Arm,
    Chat,
    GenerationAttempt,
    Intent,
    Message,
    PositiveBudget,
    Script,
    ScriptFamily,
    Turn,
)
from .gsm8k import Verification, grade
from .types import (
    ArmConfigDigest,
    ConstructionSeed,
    DesignDigest,
    ModelConfigDigest,
    SourceAnswer,
    SourceDigest,
    SourceId,
    StrictModel,
    TrialIndex,
    TrialSeed,
)

FailureKind: TypeAlias = Literal["agent", "budget", "verifier"]
ARMS: tuple[Arm, Arm, Arm] = ("static", "matched", "evolved")
Threshold = Annotated[float, Field(ge=-1, le=1, allow_inf_nan=False)]
_THRESHOLD = TypeAdapter(Threshold)


class BudgetError(RuntimeError):
    pass


class RunFailure(StrictModel):
    kind: Literal["run_failure"] = "run_failure"
    failure_kind: FailureKind
    error_type: str
    message: str


Outcome: TypeAlias = Annotated[
    Verification | RunFailure,
    Field(discriminator="kind"),
]


class RunIdentity(StrictModel):
    design_digest: DesignDigest
    source_id: SourceId
    source_digest: SourceDigest
    model_config_digest: ModelConfigDigest
    trial_index: TrialIndex
    trial_seed: TrialSeed
    arm: Arm
    arm_config_digest: ArmConfigDigest


class Usage(StrictModel):
    completed_turns: Annotated[int, Field(ge=0)]
    output_characters: Annotated[int, Field(ge=0)]
    declared_output_tokens: Annotated[int, Field(gt=0)]


class RunResult(StrictModel):
    identity: RunIdentity
    script: Script
    agent_model: str
    transcript: tuple[Message, ...]
    final_answer: str | None
    outcome: Outcome
    usage: Usage


class ManifestUnit(StrictModel):
    source_id: SourceId
    source_digest: SourceDigest
    trial_index: TrialIndex
    trial_seed: TrialSeed


class ArmConfig(StrictModel):
    source_id: SourceId
    arm: Arm
    digest: ArmConfigDigest


class ManifestRecord(StrictModel):
    kind: Literal["manifest"] = "manifest"
    schema_version: Literal[1] = 1
    threshold: Threshold
    design_digest: DesignDigest
    model_config_digest: ModelConfigDigest
    units: Annotated[tuple[ManifestUnit, ...], Field(min_length=1)]
    arm_config_digests: Annotated[tuple[ArmConfig, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def unique_design_units(self) -> Self:
        unit_keys = tuple((item.source_id, item.trial_index) for item in self.units)
        arm_keys = tuple((item.source_id, item.arm) for item in self.arm_config_digests)
        if len(set(unit_keys)) != len(unit_keys):
            raise ValueError("manifest units must be unique")
        if len(set(arm_keys)) != len(arm_keys):
            raise ValueError("manifest arm configurations must be unique")
        expected_arms = {(unit.source_id, arm) for unit in self.units for arm in ARMS}
        if set(arm_keys) != expected_arms:
            raise ValueError(
                "manifest arm configurations differ from scheduled sources"
            )
        body = {
            "schema_version": self.schema_version,
            "threshold": self.threshold,
            "model_config_digest": self.model_config_digest,
            "units": [item.model_dump(mode="json") for item in self.units],
            "arm_config_digests": [
                item.model_dump(mode="json") for item in self.arm_config_digests
            ],
        }
        if canonical_digest(body) != self.design_digest:
            raise ValueError("manifest design digest does not match its body")
        return self


class ScriptRecord(StrictModel):
    arm: Arm
    turns: tuple[Turn, ...]
    max_output_tokens: tuple[PositiveBudget, ...]

    @classmethod
    def from_script(cls, script: Script) -> Self:
        return cls(
            arm=script.arm,
            turns=script.turns,
            max_output_tokens=script.max_output_tokens,
        )


class FamilyRecord(StrictModel):
    kind: Literal["family"] = "family"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    source_id: SourceId
    source_digest: SourceDigest
    answer_authority: SourceAnswer
    source_intent: Intent
    construction_seed: ConstructionSeed
    construction_model: str
    fallback_model: str | None
    construction_attempts: tuple[GenerationAttempt, ...]
    scripts: dict[Arm, ScriptRecord]

    @model_validator(mode="after")
    def complete_arms(self) -> Self:
        if set(self.scripts) != set(ARMS):
            raise ValueError("family record must contain exactly three arms")
        return self


class RunRecord(StrictModel):
    kind: Literal["run"] = "run"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    source_id: SourceId
    source_digest: SourceDigest
    model_config_digest: ModelConfigDigest
    trial_index: TrialIndex
    trial_seed: TrialSeed
    arm: Arm
    arm_config_digest: ArmConfigDigest
    agent_model: str
    transcript: tuple[Message, ...]
    final_answer: str | None
    outcome: Outcome
    usage: Usage

    @classmethod
    def from_result(cls, result: RunResult) -> Self:
        return cls(
            **result.identity.model_dump(),
            agent_model=result.agent_model,
            transcript=result.transcript,
            final_answer=result.final_answer,
            outcome=result.outcome,
            usage=result.usage,
        )


EvidenceRecord: TypeAlias = Annotated[
    ManifestRecord | FamilyRecord | RunRecord,
    Field(discriminator="kind"),
]
_EVIDENCE = TypeAdapter(EvidenceRecord)


def _jsonable(value: object) -> object:
    return value.model_dump(mode="json") if isinstance(value, BaseModel) else value


def _canonical(value: object) -> bytes:
    return json.dumps(
        _jsonable(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode()


def canonical_digest(value: object) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as output:
            temporary = output.name
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def _source_digest(family: ScriptFamily) -> SourceDigest:
    digest = canonical_digest(family.static.problem)
    return SourceDigest(digest)


def _arm_digest(source_id: SourceId, script: Script) -> ArmConfigDigest:
    record = ScriptRecord.from_script(script)
    digest = canonical_digest({"source_id": source_id, "script": _jsonable(record)})
    return ArmConfigDigest(digest)


def _build_manifest(
    families: tuple[ScriptFamily, ...],
    trial_seeds: tuple[int, ...],
    threshold: float,
    agent_model: str,
    model_config: Mapping[str, object],
) -> ManifestRecord:
    valid_threshold = _THRESHOLD.validate_python(threshold)
    if not families or not trial_seeds:
        raise ValueError("families and trial_seeds must be non-empty")
    source_ids = [family.static.problem.record_id for family in families]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError("source ids must be unique")
    model_digest = ModelConfigDigest(
        canonical_digest({"agent_model": agent_model, "config": model_config})
    )
    units = tuple(
        ManifestUnit(
            source_id=source_id,
            source_digest=_source_digest(family),
            trial_index=TrialIndex(trial_index),
            trial_seed=TrialSeed(trial_seed),
        )
        for family, source_id in zip(families, source_ids, strict=True)
        for trial_index, trial_seed in enumerate(trial_seeds)
    )
    arm_digests = tuple(
        ArmConfig(
            source_id=source_id,
            arm=script.arm,
            digest=_arm_digest(source_id, script),
        )
        for family, source_id in zip(families, source_ids, strict=True)
        for script in family.scripts
    )
    body = {
        "schema_version": 1,
        "threshold": valid_threshold,
        "model_config_digest": model_digest,
        "units": [_jsonable(unit) for unit in units],
        "arm_config_digests": [_jsonable(item) for item in arm_digests],
    }
    return ManifestRecord(
        threshold=valid_threshold,
        design_digest=DesignDigest(canonical_digest(body)),
        model_config_digest=model_digest,
        units=units,
        arm_config_digests=arm_digests,
    )


def _family_record(
    family: ScriptFamily,
    design_digest: DesignDigest,
    source_digest: SourceDigest,
) -> FamilyRecord:
    return FamilyRecord(
        design_digest=design_digest,
        source_id=family.static.problem.record_id,
        source_digest=source_digest,
        answer_authority=family.static.problem.answer,
        source_intent=family.source_intent,
        construction_seed=family.construction_seed,
        construction_model=family.construction_model,
        fallback_model=family.fallback_model,
        construction_attempts=family.attempts,
        scripts={
            script.arm: ScriptRecord.from_script(script) for script in family.scripts
        },
    )


def run_script(
    script: Script,
    agent: Chat,
    identity: RunIdentity,
    *,
    agent_model: str,
) -> RunResult:
    transcript: list[Message] = []
    output_characters = 0
    final_answer: str | None = None
    outcome: Outcome
    for turn, budget in zip(script.turns, script.max_output_tokens, strict=True):
        transcript.append(Message(role="user", content=turn.text))
        try:
            response = agent(tuple(transcript), budget)
            if not isinstance(response, str):
                raise TypeError("agent returned non-text output")
        except BudgetError as error:
            outcome = RunFailure(
                failure_kind="budget",
                error_type=type(error).__name__,
                message=str(error),
            )
            break
        except Exception as error:
            outcome = RunFailure(
                failure_kind="agent",
                error_type=type(error).__name__,
                message=str(error),
            )
            break
        transcript.append(Message(role="assistant", content=response))
        final_answer = response
        output_characters += len(response)
    else:
        try:
            outcome = grade(script.problem, final_answer)
        except Exception as error:
            outcome = RunFailure(
                failure_kind="verifier",
                error_type=type(error).__name__,
                message=str(error),
            )
    return RunResult(
        identity=identity,
        script=script,
        agent_model=agent_model,
        transcript=tuple(transcript),
        final_answer=final_answer,
        outcome=outcome,
        usage=Usage(
            completed_turns=sum(message.role == "assistant" for message in transcript),
            output_characters=output_characters,
            declared_output_tokens=sum(script.max_output_tokens),
        ),
    )


def _factory_failure(
    script: Script,
    identity: RunIdentity,
    agent_model: str,
    error: Exception,
) -> RunResult:
    return RunResult(
        identity=identity,
        script=script,
        agent_model=agent_model,
        transcript=(),
        final_answer=None,
        outcome=RunFailure(
            failure_kind="agent",
            error_type=type(error).__name__,
            message=str(error),
        ),
        usage=Usage(
            completed_turns=0,
            output_characters=0,
            declared_output_tokens=sum(script.max_output_tokens),
        ),
    )


def run_experiment(
    families: Iterable[ScriptFamily],
    agent_factory: Callable[[SourceId, Arm, TrialSeed], Chat],
    *,
    trial_seeds: tuple[int, ...],
    agent_model: str,
    model_config: Mapping[str, object],
    threshold: float,
    output_path: Path,
) -> tuple[RunResult, ...]:
    ordered = tuple(sorted(families, key=lambda item: item.static.problem.record_id))
    manifest = _build_manifest(
        ordered,
        trial_seeds,
        threshold,
        agent_model,
        model_config,
    )
    family_by_source = {family.static.problem.record_id: family for family in ordered}
    arm_digests = {
        (item.source_id, item.arm): item.digest for item in manifest.arm_config_digests
    }
    records: list[EvidenceRecord] = [manifest]
    records.extend(
        _family_record(
            family,
            manifest.design_digest,
            _source_digest(family),
        )
        for family in ordered
    )
    results: list[RunResult] = []
    for unit in manifest.units:
        family = family_by_source[unit.source_id]
        for script in family.scripts:
            identity = RunIdentity(
                design_digest=manifest.design_digest,
                source_id=unit.source_id,
                source_digest=unit.source_digest,
                model_config_digest=manifest.model_config_digest,
                trial_index=unit.trial_index,
                trial_seed=unit.trial_seed,
                arm=script.arm,
                arm_config_digest=arm_digests[(unit.source_id, script.arm)],
            )
            try:
                agent = agent_factory(
                    unit.source_id,
                    script.arm,
                    unit.trial_seed,
                )
            except Exception as error:
                result = _factory_failure(script, identity, agent_model, error)
            else:
                result = run_script(
                    script,
                    agent,
                    identity,
                    agent_model=agent_model,
                )
            results.append(result)
            records.append(RunRecord.from_result(result))
    data = b"".join(_canonical(record) + b"\n" for record in records)
    atomic_write(output_path, data)
    return tuple(results)


def read_run_jsonl(path: Path) -> tuple[EvidenceRecord, ...]:
    records: list[EvidenceRecord] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                records.append(_EVIDENCE.validate_json(line))
            except ValidationError as error:
                detail = error.errors(include_url=False)[0]["msg"]
                raise ValueError(f"line {line_number}: {detail}") from error
    return tuple(records)
