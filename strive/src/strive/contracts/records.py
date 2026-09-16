"""Closed authority field groups (§4 plus Amendment 1).

Owners name trusted append interfaces, not caller-supplied authentication.
The future supervisor must derive producer identity from the append interface.
Constructing a schema-valid record never grants permission to append it.
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import ClassVar, Final, Mapping

from .annotations import Annotation
from .bindings import HarnessBinding
from .harness import ProcessObservations
from .lifecycle import DispatchStage, EffectState, RecoveryContract
from .manifest import BudgetTable, ComparisonTable, FeedbackTable, NamedModel
from .primitives import (
    AccessScope, ArtifactRef, CommandId, EffectId, EnvironmentId, EpisodeId,
    ExecutionStatus, IntegrationLevel, InvocationId, LineageId, ObservedModelIdentity,
    RecordId, RequestedModelIdentity, Reservation, ResourceQuantity, ResultCursor,
    RevisionId, RunId, TrajectoryId, TrustMode, WireModelIdentity,
)


class RecordClass(StrEnum):
    RUN_BINDING = "run_binding"
    EFFECT_AUTHORIZATION = "effect_authorization"
    EFFECT_OBSERVATION_SETTLEMENT = "effect_observation_settlement"
    MEASUREMENT = "measurement"
    REVISION_ACTIVATION = "revision_activation"
    CONTINUATION_COMMIT = "continuation_commit"
    ANNOTATION = "annotation"


class RecordOwner(StrEnum):
    SUPERVISOR = "supervisor"
    TRUSTED_RUN_SETUP = "trusted_run_setup"
    BROKER_AND_SUPERVISOR = "broker_and_supervisor"
    BROKER_AND_TRUSTED_ADAPTERS = "broker_and_trusted_adapters"
    TRUSTED_SCORER = "trusted_scorer"


class ProducerKind(StrEnum):
    SUPERVISOR = "supervisor"
    RUN_SETUP = "run_setup"
    BROKER = "broker"
    TRUSTED_ADAPTER = "trusted_adapter"
    TRUSTED_SCORER = "trusted_scorer"
    CANDIDATE = "candidate"
    OPERATOR = "operator"


@dataclass(frozen=True, slots=True)
class ProducerIdentity:
    kind: ProducerKind
    implementation: ArtifactRef


@dataclass(frozen=True, slots=True)
class CausalIdentity:
    parent_record: RecordId | None
    invocation_id: InvocationId | None
    command_id: CommandId | None
    effect_id: EffectId | None


@dataclass(frozen=True, slots=True)
class IntegrityLinkage:
    previous_record_digest: ArtifactRef | None
    record_digest: ArtifactRef


@dataclass(frozen=True, slots=True)
class Envelope:
    owner: ClassVar[RecordOwner] = RecordOwner.SUPERVISOR
    run_id: RunId
    sequence: int
    record_id: RecordId
    record_class: RecordClass
    causal_identity: CausalIdentity
    producer_identity: ProducerIdentity
    access_scope: AccessScope
    payload_reference: ArtifactRef
    integrity_linkage: IntegrityLinkage

    def __post_init__(self) -> None:
        if self.sequence < 0:
            raise ValueError("record sequence must be nonnegative")
        if self.run_id != self.access_scope.run_id:
            raise ValueError("record access scope must belong to its run")


@dataclass(frozen=True, slots=True)
class DeclaredLineage:
    lineage_id: LineageId
    parent_run: RunId | None
    parent_cursor: int | None
    authorized_import_scope: ArtifactRef


@dataclass(frozen=True, slots=True)
class BoundHarness:
    name: str
    binding: HarnessBinding[ArtifactRef]
    descriptor: ArtifactRef
    executable_closure: ArtifactRef
    launch_profile: ArtifactRef
    sandbox_profile: ArtifactRef
    integration_level: IntegrationLevel


@dataclass(frozen=True, slots=True)
class RunBinding:
    owner: ClassVar[RecordOwner] = RecordOwner.TRUSTED_RUN_SETUP
    record_class: ClassVar[RecordClass] = RecordClass.RUN_BINDING
    resolved_manifest: ArtifactRef
    trusted_runtime: ArtifactRef
    verifier: ArtifactRef
    adapters: ArtifactRef
    scorer: ArtifactRef
    initial_environment: ArtifactRef
    initial_bundle: ArtifactRef
    model_bindings: tuple[NamedModel[ArtifactRef], ...]
    limits: BudgetTable[ArtifactRef]
    capabilities: ArtifactRef
    editable_scope: tuple[str, ...]
    feedback_contract: FeedbackTable[ArtifactRef]
    comparison_contract: ComparisonTable[ArtifactRef]
    trust_mode: TrustMode
    declared_lineage: DeclaredLineage
    harness_bindings: tuple[BoundHarness, ...]
    gateway_identity: ArtifactRef


@dataclass(frozen=True, slots=True)
class EffectAuthorization:
    owner: ClassVar[RecordOwner] = RecordOwner.BROKER_AND_SUPERVISOR
    record_class: ClassVar[RecordClass] = RecordClass.EFFECT_AUTHORIZATION
    command_id: CommandId
    effect_id: EffectId
    exact_request_reference: ArtifactRef
    executing_bundle: ArtifactRef
    adapter: ArtifactRef
    operation: str
    target_environment: EnvironmentId
    permitted_scope: AccessScope
    reservation: Reservation
    recovery_contract: RecoveryContract
    execution_epoch: int
    dispatch_stage: DispatchStage
    harness_binding_reference: ArtifactRef | None
    generation_envelope: ArtifactRef | None
    input_references: tuple[ArtifactRef, ...]
    actual_provider_request_reference: ArtifactRef | None

    def __post_init__(self) -> None:
        if self.execution_epoch < 0:
            raise ValueError("execution epoch must be nonnegative")
        if self.operation == "model.generate" and self.generation_envelope is None:
            raise ValueError("model.generate requires a retained generation envelope")
        if self.dispatch_stage is DispatchStage.UPSTREAM_FORWARD and self.actual_provider_request_reference is None:
            raise ValueError("upstream forwarding requires the retained actual provider request")
        if self.dispatch_stage is DispatchStage.HARNESS_LAUNCH and (
            self.harness_binding_reference is None or self.generation_envelope is None
        ):
            raise ValueError("harness launch requires a retained binding and generation envelope")


class OutcomeStatus(StrEnum):
    DISPATCHED = "dispatched"
    RETURNED = "returned"
    FAILED = "failed"
    UNCERTAIN = "uncertain"


class UsageCompleteness(StrEnum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    MISSING = "missing"
    NOT_APPLICABLE = "not_applicable"


class UsageKind(StrEnum):
    MEASURED = "measured"
    RESERVED = "reserved"
    UNKNOWN = "unknown"


class UsageProvenance(StrEnum):
    PROVIDER_RECEIPT = "provider_receipt"
    TRUSTED_ADAPTER = "trusted_adapter"
    GATEWAY = "gateway"
    CALCULATED_COST = "calculated_cost"
    SIMULATED = "simulated"


@dataclass(frozen=True, slots=True)
class UsageObservation:
    kind: UsageKind
    quantity: ResourceQuantity | None
    provenance: UsageProvenance
    supporting_reference: ArtifactRef
    remaining_obligation: ResourceQuantity | None

    def __post_init__(self) -> None:
        if self.kind is UsageKind.UNKNOWN and (self.quantity is not None or self.remaining_obligation is None):
            raise ValueError("unknown usage requires an obligation and no invented quantity")
        if self.kind is not UsageKind.UNKNOWN and self.quantity is None:
            raise ValueError("measured/reserved usage requires an explicit quantity")


class ReservationDisposition(StrEnum):
    RETAIN = "retain"
    REPLACE_KNOWN_COMPONENTS = "replace_known_components"
    RELEASE = "release"


@dataclass(frozen=True, slots=True)
class EffectObservationSettlement:
    owner: ClassVar[RecordOwner] = RecordOwner.BROKER_AND_TRUSTED_ADAPTERS
    record_class: ClassVar[RecordClass] = RecordClass.EFFECT_OBSERVATION_SETTLEMENT
    effect_id: EffectId
    execution_epoch: int
    state: EffectState
    dispatch_stage: DispatchStage
    outcome_status: OutcomeStatus
    response_reference: ArtifactRef | None
    receipt_references: tuple[ArtifactRef, ...]
    observed_environment_version: ArtifactRef | None
    usage: tuple[UsageObservation, ...]
    usage_completeness: UsageCompleteness
    reservation_disposition: ReservationDisposition
    reconciliation_references: tuple[ArtifactRef, ...]
    process_outcome: ProcessObservations | None
    raw_output_references: tuple[ArtifactRef, ...]
    decoded_output_reference: ArtifactRef | None
    provider_request_id: str | None
    requested_model_identity: RequestedModelIdentity | None
    wire_model_identity: WireModelIdentity | None
    observed_model_identity: ObservedModelIdentity | None
    identity_provenance: ArtifactRef | None
    gateway_reconciliation_references: tuple[ArtifactRef, ...]
    overrun: tuple[ResourceQuantity, ...] = ()

    def __post_init__(self) -> None:
        if self.reservation_disposition is ReservationDisposition.RELEASE and (
            self.usage_completeness in {UsageCompleteness.PARTIAL, UsageCompleteness.MISSING}
            or any(item.remaining_obligation is not None for item in self.usage)
            or self.outcome_status is OutcomeStatus.UNCERTAIN
        ):
            raise ValueError("unresolved usage/outcome cannot release its reservation")


@dataclass(frozen=True, slots=True)
class CoverageExclusion:
    subject: str
    reason: str
    supporting_reference: ArtifactRef


@dataclass(frozen=True, slots=True)
class Measurement:
    owner: ClassVar[RecordOwner] = RecordOwner.TRUSTED_SCORER
    record_class: ClassVar[RecordClass] = RecordClass.MEASUREMENT
    subject_run: RunId
    subject_window: ArtifactRef
    revision_references: tuple[RevisionId, ...]
    workload_identity: ArtifactRef
    scorer_version: ArtifactRef
    supporting_receipt_references: tuple[ArtifactRef, ...]
    supporting_state_references: tuple[ArtifactRef, ...]
    planned_coverage: tuple[str, ...]
    admitted_coverage: tuple[str, ...]
    completed_coverage: tuple[str, ...]
    exclusions: tuple[CoverageExclusion, ...]
    metric_identity: ArtifactRef
    metric_value: Decimal
    benchmark_upstream_revision: str | None
    split_grouping_identity: ArtifactRef | None
    episode_identity: EpisodeId | None
    trajectory_identity: TrajectoryId | None
    reset_boundary: ArtifactRef | None
    exact_reward_definition: ArtifactRef


@dataclass(frozen=True, slots=True)
class RevisionActivation:
    owner: ClassVar[RecordOwner] = RecordOwner.SUPERVISOR
    record_class: ClassVar[RecordClass] = RecordClass.REVISION_ACTIVATION
    previous_bundle: ArtifactRef
    next_bundle: ArtifactRef
    expected_active_revision: RevisionId
    activation_boundary: ArtifactRef
    coupled_controller_state_reference: ArtifactRef | None


@dataclass(frozen=True, slots=True)
class ContinuationCommit:
    owner: ClassVar[RecordOwner] = RecordOwner.SUPERVISOR
    record_class: ClassVar[RecordClass] = RecordClass.CONTINUATION_COMMIT
    private_state: bytes
    executing_bundle: ArtifactRef
    consumed_result_cursor: ResultCursor | None
    pending_command_reference: ArtifactRef | None
    environment_reference: ArtifactRef
    execution_status: ExecutionStatus


type AuthorityRecord = RunBinding | EffectAuthorization | EffectObservationSettlement | Measurement | RevisionActivation | ContinuationCommit
type RecordPayload = AuthorityRecord | Annotation

RECORD_OWNERS: Final[Mapping[RecordClass, RecordOwner]] = MappingProxyType({
    RecordClass.RUN_BINDING: RunBinding.owner,
    RecordClass.EFFECT_AUTHORIZATION: EffectAuthorization.owner,
    RecordClass.EFFECT_OBSERVATION_SETTLEMENT: EffectObservationSettlement.owner,
    RecordClass.MEASUREMENT: Measurement.owner,
    RecordClass.REVISION_ACTIVATION: RevisionActivation.owner,
    RecordClass.CONTINUATION_COMMIT: ContinuationCommit.owner,
})


@dataclass(frozen=True, slots=True)
class Record:
    envelope: Envelope
    payload: RecordPayload

    def __post_init__(self) -> None:
        expected = RecordClass.ANNOTATION if isinstance(self.payload, Annotation) else self.payload.record_class
        if self.envelope.record_class is not expected:
            raise ValueError("envelope record class does not match payload")
