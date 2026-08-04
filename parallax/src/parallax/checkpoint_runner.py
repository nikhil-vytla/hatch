from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Annotated, Literal, Self, TypeAlias, assert_never

from pydantic import Field, TypeAdapter, ValidationError, model_validator

from .canonical import atomic_write, canonical_bytes, canonical_digest
from .checkpoint_evolution import (
    EMPTY_WORKSPACE,
    AdmissionReceipt,
    CheckpointFamily,
    PositiveInt,
    ReferenceBuild,
    StageVerification,
    VerifierError,
    Workspace,
    verify_stage,
)
from .outcome import BudgetError, RunFailure
from .types import (
    ArmConfigDigest,
    DesignDigest,
    DigestText,
    ModelConfigDigest,
    NonEmptyText,
    NonNegativeInt,
    SourceId,
    StrictModel,
    TrialIndex,
    TrialSeed,
)

CheckpointArm: TypeAlias = Literal["evolved", "carry-reference"]
CE_ARMS: tuple[CheckpointArm, CheckpointArm] = ("evolved", "carry-reference")

StageOutcome: TypeAlias = Annotated[
    StageVerification | RunFailure,
    Field(discriminator="kind"),
]


class CheckpointRunError(ValueError):
    pass


class AdmittedFamily(StrictModel):
    family: CheckpointFamily
    references: ReferenceBuild
    admission: AdmissionReceipt

    @model_validator(mode="after")
    def admitted_only(self) -> Self:
        if self.admission.decision != "admitted":
            raise CheckpointRunError(f"family {self.family.family_id} was not admitted")
        if (
            self.admission.family_digest != self.family.digest
            or self.admission.reference_digest != self.references.digest
            or self.references.family_digest != self.family.digest
        ):
            raise CheckpointRunError(
                "admission receipt is bound to different family or reference bytes"
            )
        return self


class CheckpointDelivery(StrictModel):
    index: PositiveInt
    public_spec: NonEmptyText
    workspace: Workspace
    max_output_bytes: PositiveInt


CheckpointAgent: TypeAlias = Callable[[CheckpointDelivery], Workspace]
AgentFactory: TypeAlias = Callable[
    [SourceId, CheckpointArm, TrialSeed], CheckpointAgent
]


class StageReceipt(StrictModel):
    index: PositiveInt
    spec_digest: DigestText
    input_workspace_digest: DigestText
    output_workspace_digest: DigestText | None
    max_output_bytes: PositiveInt
    output_bytes: NonNegativeInt
    outcome: StageOutcome

    @model_validator(mode="after")
    def graded_only_with_workspace(self) -> Self:
        if isinstance(self.outcome, StageVerification):
            if self.output_workspace_digest is None:
                raise CheckpointRunError(
                    f"stage {self.index} was graded without a produced workspace"
                )
            if self.outcome.index != self.index:
                raise CheckpointRunError(
                    f"stage {self.index} carries a verification for another stage"
                )
        elif isinstance(self.outcome, RunFailure):
            pass
        else:
            assert_never(self.outcome)
        if self.output_workspace_digest is None and self.output_bytes != 0:
            raise CheckpointRunError(
                f"stage {self.index} counted bytes for a missing workspace"
            )
        if (
            self.output_workspace_digest is not None
            and self.output_bytes > self.max_output_bytes
        ):
            raise CheckpointRunError(
                f"stage {self.index} retained a workspace over its declared budget"
            )
        return self


class FamilyRun(StrictModel):
    admitted: AdmittedFamily
    arm: CheckpointArm
    receipts: tuple[StageReceipt, ...]
    censored: tuple[PositiveInt, ...]
    failure: RunFailure | None

    @model_validator(mode="after")
    def full_delivery_or_censored(self) -> Self:
        family = self.admitted.family
        total = len(family.checkpoints)
        delivered = len(self.receipts)
        if tuple(receipt.index for receipt in self.receipts) != tuple(
            range(1, delivered + 1)
        ):
            raise CheckpointRunError(
                "checkpoint delivery must be contiguous from stage 1"
            )
        if self.censored != tuple(range(delivered + 1, total + 1)):
            raise CheckpointRunError(
                "censored stages must be exactly the undelivered suffix"
            )
        if (self.failure is not None) != (delivered == 0):
            raise CheckpointRunError(
                "a run must hold receipts or exactly one pre-episode failure"
            )
        for receipt, checkpoint in zip(self.receipts, family.checkpoints, strict=False):
            if receipt.spec_digest != checkpoint.spec_digest:
                raise CheckpointRunError(
                    f"stage {receipt.index} delivered a drifted specification"
                )
            if receipt.max_output_bytes != checkpoint.max_output_bytes:
                raise CheckpointRunError(
                    f"stage {receipt.index} ran under an undeclared budget"
                )
            if isinstance(receipt.outcome, StageVerification):
                scheduled = {
                    (
                        origin,
                        case.case_id,
                        "new" if origin == receipt.index else "regression",
                        case.category,
                    )
                    for origin, case in family.obligations(receipt.index)
                }
                graded = {
                    (
                        result.origin_index,
                        result.case_id,
                        result.role,
                        result.category,
                    )
                    for result in receipt.outcome.case_results
                }
                if scheduled != graded:
                    raise CheckpointRunError(
                        f"stage {receipt.index} was graded against a different "
                        "obligation set than the accumulated sealed suite"
                    )
        self._validate_workspace_chain()
        return self

    def _validate_workspace_chain(self) -> None:
        total = len(self.admitted.family.checkpoints)
        delivered = len(self.receipts)
        if self.arm == "evolved":
            previous = EMPTY_WORKSPACE.digest
            for receipt in self.receipts:
                if previous is None or receipt.input_workspace_digest != previous:
                    raise CheckpointRunError(
                        f"stage {receipt.index} did not start from the agent's "
                        "own terminal workspace"
                    )
                previous = receipt.output_workspace_digest
            if delivered not in (0, total):
                last = self.receipts[-1]
                if last.output_workspace_digest is not None or not isinstance(
                    last.outcome, RunFailure
                ):
                    raise CheckpointRunError(
                        "evolved censoring requires a missing workspace after "
                        "a run failure"
                    )
        elif self.arm == "carry-reference":
            if delivered not in (0, total):
                raise CheckpointRunError(
                    "carry-reference must deliver every checkpoint"
                )
            stages = self.admitted.references.stages
            for receipt in self.receipts:
                expected = (
                    EMPTY_WORKSPACE.digest
                    if receipt.index == 1
                    else stages[receipt.index - 2].digest
                )
                if receipt.input_workspace_digest != expected:
                    raise CheckpointRunError(
                        f"stage {receipt.index} did not start from the frozen "
                        "reference workspace"
                    )
        else:
            assert_never(self.arm)


def _stage_attempt(
    agent: CheckpointAgent,
    delivery: CheckpointDelivery,
) -> Workspace | RunFailure:
    try:
        produced = agent(delivery)
        if not isinstance(produced, Workspace):
            raise TypeError("agent returned a non-workspace artifact")
    except BudgetError as error:
        return RunFailure(
            failure_kind="budget",
            error_type=type(error).__name__,
            message=str(error),
        )
    except Exception as error:
        return RunFailure(
            failure_kind="agent",
            error_type=type(error).__name__,
            message=str(error),
        )
    if produced.content_bytes > delivery.max_output_bytes:
        return RunFailure(
            failure_kind="budget",
            error_type="WorkspaceBudgetExceeded",
            message=(
                f"stage {delivery.index} returned {produced.content_bytes} bytes "
                f"over the declared {delivery.max_output_bytes}-byte budget"
            ),
        )
    return produced


def run_checkpoint_family(
    admitted: AdmittedFamily,
    agent: CheckpointAgent,
    *,
    arm: CheckpointArm,
) -> FamilyRun:
    family = admitted.family
    receipts: list[StageReceipt] = []
    carried = EMPTY_WORKSPACE
    for checkpoint in family.checkpoints:
        if arm == "evolved":
            opening = carried
        elif arm == "carry-reference":
            opening = (
                EMPTY_WORKSPACE
                if checkpoint.index == 1
                else admitted.references.stages[checkpoint.index - 2]
            )
        else:
            assert_never(arm)
        delivery = CheckpointDelivery(
            index=checkpoint.index,
            public_spec=checkpoint.public_spec,
            workspace=opening,
            max_output_bytes=checkpoint.max_output_bytes,
        )
        attempt = _stage_attempt(agent, delivery)
        produced: Workspace | None
        outcome: StageVerification | RunFailure
        if isinstance(attempt, RunFailure):
            produced = None
            outcome = attempt
        else:
            produced = attempt
            try:
                outcome = verify_stage(family, checkpoint.index, produced)
            except VerifierError as error:
                outcome = RunFailure(
                    failure_kind="verifier",
                    error_type=type(error).__name__,
                    message=str(error),
                )
        receipts.append(
            StageReceipt(
                index=checkpoint.index,
                spec_digest=checkpoint.spec_digest,
                input_workspace_digest=opening.digest,
                output_workspace_digest=None if produced is None else produced.digest,
                max_output_bytes=checkpoint.max_output_bytes,
                output_bytes=0 if produced is None else produced.content_bytes,
                outcome=outcome,
            )
        )
        if arm == "evolved":
            if produced is None:
                break
            carried = produced
    return FamilyRun(
        admitted=admitted,
        arm=arm,
        receipts=tuple(receipts),
        censored=tuple(range(len(receipts) + 1, len(family.checkpoints) + 1)),
        failure=None,
    )


class CeManifestUnit(StrictModel):
    family_id: SourceId
    family_digest: DigestText
    trial_index: TrialIndex
    trial_seed: TrialSeed


class CeArmConfig(StrictModel):
    family_id: SourceId
    arm: CheckpointArm
    digest: ArmConfigDigest


class CeManifestRecord(StrictModel):
    kind: Literal["ce_manifest"] = "ce_manifest"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    model_config_digest: ModelConfigDigest
    units: Annotated[tuple[CeManifestUnit, ...], Field(min_length=1)]
    arm_configs: Annotated[tuple[CeArmConfig, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def preregistered_design(self) -> Self:
        unit_keys = tuple((unit.family_id, unit.trial_index) for unit in self.units)
        arm_keys = tuple((config.family_id, config.arm) for config in self.arm_configs)
        if len(set(unit_keys)) != len(unit_keys):
            raise CheckpointRunError("manifest units must be unique")
        if len(set(arm_keys)) != len(arm_keys):
            raise CheckpointRunError("manifest arm configurations must be unique")
        expected = {(unit.family_id, arm) for unit in self.units for arm in CE_ARMS}
        if set(arm_keys) != expected:
            raise CheckpointRunError(
                "manifest arm configurations differ from scheduled families"
            )
        body = {
            "schema_version": self.schema_version,
            "model_config_digest": self.model_config_digest,
            "units": [unit.model_dump(mode="json") for unit in self.units],
            "arm_configs": [
                config.model_dump(mode="json") for config in self.arm_configs
            ],
        }
        if canonical_digest(body) != self.design_digest:
            raise CheckpointRunError("manifest design digest does not match its body")
        return self


class CeFamilyRecord(StrictModel):
    kind: Literal["ce_family"] = "ce_family"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    family: CheckpointFamily
    reference_digest: DigestText
    admission: AdmissionReceipt


class CeRunRecord(StrictModel):
    kind: Literal["ce_run"] = "ce_run"
    schema_version: Literal[1] = 1
    design_digest: DesignDigest
    family_id: SourceId
    family_digest: DigestText
    model_config_digest: ModelConfigDigest
    trial_index: TrialIndex
    trial_seed: TrialSeed
    arm: CheckpointArm
    arm_config_digest: ArmConfigDigest
    agent_model: NonEmptyText
    receipts: tuple[StageReceipt, ...]
    censored: tuple[PositiveInt, ...]
    failure: RunFailure | None

    @model_validator(mode="after")
    def replayable_shape(self) -> Self:
        delivered = len(self.receipts)
        if tuple(receipt.index for receipt in self.receipts) != tuple(
            range(1, delivered + 1)
        ):
            raise CheckpointRunError("run record receipts must be contiguous")
        if self.censored != tuple(
            range(delivered + 1, delivered + 1 + len(self.censored))
        ):
            raise CheckpointRunError(
                "run record censored stages must be the undelivered suffix"
            )
        if (self.failure is not None) != (delivered == 0):
            raise CheckpointRunError(
                "run record must hold receipts or one pre-episode failure"
            )
        return self


CeEvidenceRecord: TypeAlias = Annotated[
    CeManifestRecord | CeFamilyRecord | CeRunRecord,
    Field(discriminator="kind"),
]
_CE_EVIDENCE = TypeAdapter(CeEvidenceRecord)


def _arm_config_digest(admitted: AdmittedFamily, arm: CheckpointArm) -> ArmConfigDigest:
    body: dict[str, object] = {
        "family_id": admitted.family.family_id,
        "arm": arm,
        "contract": admitted.family.contract.model_dump(mode="json"),
        "budgets": [
            checkpoint.max_output_bytes for checkpoint in admitted.family.checkpoints
        ],
    }
    if arm == "carry-reference":
        body["reference_digest"] = admitted.references.digest
    return ArmConfigDigest(canonical_digest(body))


def _build_manifest(
    admitted_families: tuple[AdmittedFamily, ...],
    trial_seeds: tuple[int, ...],
    agent_model: str,
    model_config: Mapping[str, object],
) -> CeManifestRecord:
    if not admitted_families or not trial_seeds:
        raise CheckpointRunError("families and trial seeds must be non-empty")
    family_ids = [item.family.family_id for item in admitted_families]
    if len(set(family_ids)) != len(family_ids):
        raise CheckpointRunError("family ids must be unique")
    model_digest = ModelConfigDigest(
        canonical_digest({"agent_model": agent_model, "config": dict(model_config)})
    )
    units = tuple(
        CeManifestUnit(
            family_id=item.family.family_id,
            family_digest=item.family.digest,
            trial_index=TrialIndex(trial_index),
            trial_seed=TrialSeed(trial_seed),
        )
        for item in admitted_families
        for trial_index, trial_seed in enumerate(trial_seeds)
    )
    arm_configs = tuple(
        CeArmConfig(
            family_id=item.family.family_id,
            arm=arm,
            digest=_arm_config_digest(item, arm),
        )
        for item in admitted_families
        for arm in CE_ARMS
    )
    body = {
        "schema_version": 1,
        "model_config_digest": model_digest,
        "units": [unit.model_dump(mode="json") for unit in units],
        "arm_configs": [config.model_dump(mode="json") for config in arm_configs],
    }
    return CeManifestRecord(
        design_digest=DesignDigest(canonical_digest(body)),
        model_config_digest=model_digest,
        units=units,
        arm_configs=arm_configs,
    )


def _run_record(
    run: FamilyRun,
    manifest: CeManifestRecord,
    unit: CeManifestUnit,
    arm_config_digest: ArmConfigDigest,
    agent_model: str,
) -> CeRunRecord:
    return CeRunRecord(
        design_digest=manifest.design_digest,
        family_id=unit.family_id,
        family_digest=unit.family_digest,
        model_config_digest=manifest.model_config_digest,
        trial_index=unit.trial_index,
        trial_seed=unit.trial_seed,
        arm=run.arm,
        arm_config_digest=arm_config_digest,
        agent_model=agent_model,
        receipts=run.receipts,
        censored=run.censored,
        failure=run.failure,
    )


def _factory_failure(
    admitted: AdmittedFamily, arm: CheckpointArm, error: Exception
) -> FamilyRun:
    return FamilyRun(
        admitted=admitted,
        arm=arm,
        receipts=(),
        censored=tuple(range(1, len(admitted.family.checkpoints) + 1)),
        failure=RunFailure(
            failure_kind="agent",
            error_type=type(error).__name__,
            message=str(error),
        ),
    )


def run_ce_experiment(
    admitted_families: tuple[AdmittedFamily, ...],
    agent_factory: AgentFactory,
    *,
    trial_seeds: tuple[int, ...],
    agent_model: str,
    model_config: Mapping[str, object],
    output_path: Path,
) -> tuple[FamilyRun, ...]:
    ordered = tuple(sorted(admitted_families, key=lambda item: item.family.family_id))
    manifest = _build_manifest(ordered, trial_seeds, agent_model, model_config)
    by_family = {item.family.family_id: item for item in ordered}
    arm_digests = {
        (config.family_id, config.arm): config.digest for config in manifest.arm_configs
    }
    records: list[CeEvidenceRecord] = [manifest]
    records.extend(
        CeFamilyRecord(
            design_digest=manifest.design_digest,
            family=item.family,
            reference_digest=item.references.digest,
            admission=item.admission,
        )
        for item in ordered
    )
    runs: list[FamilyRun] = []
    for unit in manifest.units:
        admitted = by_family[unit.family_id]
        for arm in CE_ARMS:
            try:
                agent = agent_factory(unit.family_id, arm, unit.trial_seed)
            except Exception as error:
                run = _factory_failure(admitted, arm, error)
            else:
                run = run_checkpoint_family(admitted, agent, arm=arm)
            runs.append(run)
            records.append(
                _run_record(
                    run,
                    manifest,
                    unit,
                    arm_digests[(unit.family_id, arm)],
                    agent_model,
                )
            )
    data = b"".join(canonical_bytes(record) + b"\n" for record in records)
    atomic_write(output_path, data)
    return tuple(runs)


def read_ce_jsonl(path: Path) -> tuple[CeEvidenceRecord, ...]:
    records: list[CeEvidenceRecord] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                records.append(_CE_EVIDENCE.validate_json(line))
            except ValidationError as error:
                detail = error.errors(include_url=False)[0]["msg"]
                raise CheckpointRunError(f"line {line_number}: {detail}") from error
    return tuple(records)
