"""strive.harness/1. Interfaces only; no process launch or provider behavior."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, Protocol

from .annotations import Annotation
from .bindings import ModelBinding
from .lifecycle import RecoveryCapability
from .primitives import (
    AccessScope, ArtifactRef, EffectId, IntegrationLevel, InvocationId, ModelRole,
    Reservation, ResourceQuantity, RunId, ScopedArtifact,
)


@dataclass(frozen=True, slots=True)
class ConfinementRequirements:
    process_tree: bool
    gateway_only_network: bool
    credentials_denied: bool
    authoritative_storage_denied: bool
    protected_evidence_denied: bool
    fresh_native_session: bool
    disabled_features: tuple[str, ...]
    profile: ArtifactRef


@dataclass(frozen=True, slots=True)
class HarnessDescriptor:
    interface_version: Literal["strive.harness/1"]
    backend_name: str
    supported_integration_levels: frozenset[IntegrationLevel]
    compatible_executable_versions: tuple[str, ...]
    supported_provider_protocols: tuple[str, ...]
    confinement_requirements: ConfinementRequirements
    accounting_bound_method: ArtifactRef
    output_decoder_identity: ArtifactRef
    recovery_capabilities: frozenset[RecoveryCapability]


@dataclass(frozen=True, slots=True)
class GenerationInput:
    role: ModelRole
    authorized_context: tuple[ScopedArtifact, ...]
    requested_model_binding: ModelBinding[ArtifactRef]
    generation_settings: ArtifactRef
    output_schema: ArtifactRef
    resource_limits: tuple[ResourceQuantity, ...]


@dataclass(frozen=True, slots=True)
class ExecutionContext:
    """Assigned by supervisor. Merely constructing this value grants nothing."""

    run_id: RunId
    invocation_id: InvocationId
    effect_id: EffectId
    bundle: ArtifactRef
    epoch: int
    evidence_scope: AccessScope

    def __post_init__(self) -> None:
        if self.epoch < 0:
            raise ValueError("execution epoch must be nonnegative")


@dataclass(frozen=True, slots=True)
class PreparedGeneration:
    execution_context: ExecutionContext
    launch_arguments: tuple[str, ...]
    input_bytes: bytes
    effective_configuration: ArtifactRef
    dependency_references: tuple[ArtifactRef, ...]
    executable_reference: ArtifactRef
    sandbox_profile: ArtifactRef
    output_decoding_contract: ArtifactRef
    deadline_seconds: int
    reservation_requirements: Reservation


class CompletionClassification(StrEnum):
    COMPLETE = "complete"
    FAILED = "failed"
    INCOMPLETE = "incomplete"
    INDETERMINATE = "indeterminate"


@dataclass(frozen=True, slots=True)
class ProcessObservations:
    exit_code: int | None
    signal: int | None
    deadline_exceeded: bool
    cancellation_requested: bool
    output_truncated: bool
    active_milliseconds: int


@dataclass(frozen=True, slots=True)
class HarnessReturn:
    completion_classification: CompletionClassification
    captured_output_references: tuple[ArtifactRef, ...]
    decoded_text_or_proposal_reference: ArtifactRef | None
    process_observations: ProcessObservations
    gateway_receipt_references: tuple[ArtifactRef, ...]
    harness_reported_diagnostics: tuple[Annotation, ...] = ()


@dataclass(frozen=True, slots=True)
class Unsupported:
    reason: str


@dataclass(frozen=True, slots=True)
class DurableEvidence:
    execution_context: ExecutionContext
    authorization_records: tuple[ArtifactRef, ...]
    gateway_records: tuple[ArtifactRef, ...]
    captured_provider_responses: tuple[ArtifactRef, ...]
    captured_harness_returns: tuple[ArtifactRef, ...]


@dataclass(frozen=True, slots=True)
class RecordedReturn:
    return_reference: ArtifactRef
    result: HarnessReturn


@dataclass(frozen=True, slots=True)
class DefinitelyNotDispatched:
    """Requires durable gateway proof, never an inference from process death."""

    gateway_proof: ArtifactRef


@dataclass(frozen=True, slots=True)
class Indeterminate:
    evidence: tuple[ArtifactRef, ...]
    reason: str


type ReconciliationResult = RecordedReturn | DefinitelyNotDispatched | Indeterminate


@dataclass(frozen=True, slots=True)
class ProcessHandle:
    effect_id: EffectId
    epoch: int
    handle: str


@dataclass(frozen=True, slots=True)
class CapturedStreams:
    stdout: ArtifactRef
    stderr: ArtifactRef
    observations: ProcessObservations


class EffectScopedModelGateway(Protocol):
    """Bound to one effect/epoch/route/model. Validates and spools before forwarding."""

    def forward(self, actual_provider_request: ArtifactRef) -> ArtifactRef: ...


class SupervisorServices(Protocol):
    @property
    def model_gateway(self) -> EffectScopedModelGateway: ...

    def launch_confined(self, prepared_generation: PreparedGeneration) -> ProcessHandle: ...

    def capture_bounded(self, process: ProcessHandle, max_bytes: int) -> CapturedStreams: ...

    def enforce_deadline(self, process: ProcessHandle, deadline_seconds: int) -> None: ...

    def cancel(self, process: ProcessHandle) -> None:
        """Revoke gateway capability before terminating the process tree."""
        ...


class HarnessAdapter(Protocol):
    def describe(self) -> HarnessDescriptor: ...

    def prepare(
        self,
        binding: ModelBinding[ArtifactRef],
        generation_input: GenerationInput,
        execution_context: ExecutionContext,
    ) -> PreparedGeneration | Unsupported: ...

    def invoke(
        self,
        prepared_generation: PreparedGeneration,
        supervisor_services: SupervisorServices,
    ) -> HarnessReturn: ...

    def reconcile(
        self,
        prepared_generation: PreparedGeneration,
        durable_evidence: DurableEvidence,
    ) -> ReconciliationResult: ...
