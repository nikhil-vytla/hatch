"""Local authority histories shared by protocol tests and runtime guarantee 5."""

from dataclasses import dataclass, replace
from pathlib import Path

from strive.vnext.codec import opaque_annotation
from strive.vnext.contracts.lifecycle import DispatchStage, EffectState, RecoveryCapability, RecoveryContract
from strive.vnext.contracts.manifest import load_resolved_configuration
from strive.vnext.contracts.primitives import (
    AccessScope, ArtifactRef, CommandId, EffectId, EnvironmentId, ExecutionStatus,
    InvocationId, LineageId, Reservation, Resource, ResourceQuantity, ResultCursor, RunId,
)
from strive.vnext.contracts.records import (
    CausalIdentity, ContinuationCommit, DeclaredLineage, EffectAuthorization,
    EffectObservationSettlement, OutcomeStatus, ProducerKind, RecordPayload,
    ReservationDisposition, RevisionActivation, RunBinding, UsageCompleteness,
    UsageKind, UsageObservation, UsageProvenance,
)
from strive.vnext.store import ArtifactStore, RunReader, RunWriter
from strive.vnext.wire import Frame

from .fixtures import AUTHORED_TOML


@dataclass
class LocalHistory:
    store: ArtifactStore
    reader: RunReader
    writer: RunWriter
    pin: ArtifactRef
    response: ArtifactRef
    next_bundle: ArtifactRef
    frames: list[Frame]

    def append(self, payload: RecordPayload, kind: ProducerKind = ProducerKind.SUPERVISOR) -> Frame:
        parent = self.frames[-1].envelope.record_id if self.frames else None
        effect_id = payload.effect_id if isinstance(payload, (EffectAuthorization, EffectObservationSettlement)) else None
        command_id = CommandId("command-1") if effect_id is not None else None
        invocation = InvocationId("invocation-1") if parent is not None else None
        causal = CausalIdentity(parent, invocation, command_id, effect_id)
        frame = self.writer.port(kind).append(payload, causal=causal, epoch=self.writer.epoch)
        self.frames.append(frame)
        return frame

    def authorization(self) -> EffectAuthorization:
        return EffectAuthorization(
            CommandId("command-1"), EffectId("effect-1"), self.pin, self.pin, self.pin,
            "benchmark.tool", EnvironmentId("environment-1"), self.reader.authority.scope,
            Reservation((ResourceQuantity(Resource.INPUT_TOKENS, 100), ResourceQuantity(Resource.USD_NANODOLLARS, 1000)), self.pin),
            RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP}), True, True),
            self.writer.epoch, DispatchStage.OPERATION, None, None, (), None,
        )

    def settlement(self) -> EffectObservationSettlement:
        return EffectObservationSettlement(
            effect_id=EffectId("effect-1"), execution_epoch=self.writer.epoch, state=EffectState.SETTLED,
            dispatch_stage=DispatchStage.OPERATION, outcome_status=OutcomeStatus.RETURNED,
            response_reference=self.response, receipt_references=(self.pin,), observed_environment_version=self.pin,
            usage=(UsageObservation(UsageKind.MEASURED, ResourceQuantity(Resource.INPUT_TOKENS, 40), UsageProvenance.TRUSTED_ADAPTER, self.pin, None),
                   UsageObservation(UsageKind.MEASURED, ResourceQuantity(Resource.USD_NANODOLLARS, 400), UsageProvenance.CALCULATED_COST, self.pin, None)),
            usage_completeness=UsageCompleteness.COMPLETE, reservation_disposition=ReservationDisposition.RELEASE,
            reconciliation_references=(), process_outcome=None, raw_output_references=(), decoded_output_reference=None,
            provider_request_id=None, requested_model_identity=None, wire_model_identity=None,
            observed_model_identity=None, identity_provenance=None, gateway_reconciliation_references=(),
        )

    def complete(self) -> None:
        self.append(self.authorization(), ProducerKind.BROKER)
        returned = self.append(self.settlement(), ProducerKind.TRUSTED_ADAPTER)
        state = self.reader.verify()
        assert state.active_revision is not None
        self.append(RevisionActivation(self.pin, self.next_bundle, state.active_revision, self.pin, None))
        self.append(ContinuationCommit(b"private-state\x00", self.next_bundle,
                                      ResultCursor(EffectId("effect-1"), returned.envelope.record_id),
                                      None, self.pin, ExecutionStatus.CONTINUE))
        self.append(opaque_annotation("future.schema.v99", b'\xffnot JSON; {"producer":"broker","usage":0}'), ProducerKind.CANDIDATE)


def local_history(root: Path) -> LocalHistory:
    store = ArtifactStore(root)
    pin = store.objects.publish(b"retained trusted runtime, input, scope, and initial snapshot fixture")
    candidate = store.objects.publish(b'raise RuntimeError("CANDIDATE CODE MUST NEVER EXECUTE")\n')
    response = store.objects.publish(b"recorded result")
    next_bundle = store.objects.publish(b"next executable bundle")
    run_id = RunId("run-1")
    scope = AccessScope(run_id, LineageId("development"), pin)
    producers = {kind: candidate if kind is ProducerKind.CANDIDATE else pin for kind in ProducerKind}
    reader = store.create_run(run_id, scope, producers)
    writer = store.writer(run_id)
    history = LocalHistory(store, reader, writer, pin, response, next_bundle, [])
    configuration = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", pin.digest))
    binding = RunBinding(
        pin, pin, pin, pin, pin, pin, pin, configuration.models, configuration.budget,
        pin, configuration.run.editable, configuration.feedback, configuration.comparison,
        configuration.run.mode, DeclaredLineage(scope.lineage_id, None, None, scope.grant), (), pin,
    )
    history.append(binding, ProducerKind.RUN_SETUP)
    return history


def complete_history(root: Path) -> RunReader:
    history = local_history(root)
    try:
        history.complete()
    finally:
        history.writer.close()
    return history.reader
