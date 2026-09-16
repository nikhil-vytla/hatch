"""Storage failure boundaries and the pure authority protocol."""

from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
import os
from decimal import Decimal

from strive.vnext.codec import content_ref, decode, encode, opaque_annotation
from strive.vnext.contracts.annotations import Annotation, MAX_ANNOTATION_BYTES
from strive.vnext.contracts.commands import ApplyChange, ExecuteEffect
from strive.vnext.contracts.lifecycle import DispatchStage, EffectState
from strive.vnext.contracts.primitives import ArtifactRef, CommandId, EffectId, ExecutionStatus, InvocationId, RecordId, Resource, ResourceQuantity, ResultCursor, RevisionId, RunId
from strive.vnext.contracts.records import (
    CausalIdentity, ContinuationCommit, EffectObservationSettlement, IntegrityLinkage, Measurement, RecordClass,
    OutcomeStatus, ProducerIdentity, ProducerKind, RecordPayload, ReservationDisposition,
    RevisionActivation, UsageCompleteness, UsageKind, UsageObservation, UsageProvenance,
)
from strive.vnext.errors import IncompleteTail, JournalCorruption, LeaseError, VerificationError
from strive.vnext.store import ArtifactStore
from strive.vnext.store.journal import RunWriter
from strive.vnext.verify import preflight, replay
from strive.vnext.wire import Frame, ZERO_REF, pack_frame, record_digest

from .storage_fixtures import LocalHistory, local_history


@pytest.fixture
def history(tmp_path: Path) -> Iterator[LocalHistory]:
    value = local_history(tmp_path / "new-root")
    try:
        yield value
    finally:
        value.writer.close()


def snapshot(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def attempted_frame(history: LocalHistory, payload: RecordPayload, *, prior: ArtifactRef | None = None) -> Frame:
    """Construct an authenticated but unchecked record to test replay independently."""
    state = history.reader.verify()
    template = history.frames[-1]
    kind = ProducerKind.SUPERVISOR if isinstance(payload, (ContinuationCommit, RevisionActivation)) else ProducerKind.TRUSTED_ADAPTER
    reference = history.store.objects.publish(encode(payload))
    envelope = replace(template.envelope, sequence=len(state.records), record_id=RecordId(f"forged-{len(state.records)}"),
                       record_class=payload.record_class if not isinstance(payload, Annotation) else RecordClass.ANNOTATION,
                       payload_reference=reference, producer_identity=history.reader.authority.producers[kind],
                       causal_identity=CausalIdentity(template.envelope.record_id, template.envelope.causal_identity.invocation_id,
                                                     CommandId("command-1"), EffectId("effect-1")),
                       integrity_linkage=IntegrityLinkage(prior or state.head, ZERO_REF))
    envelope = replace(envelope, integrity_linkage=IntegrityLinkage(envelope.integrity_linkage.previous_record_digest,
                                                                   record_digest(envelope, history.writer.epoch, kind)))
    return history.reader.authority.sign(history.writer.epoch, kind, envelope)


def test_round_trip_publish_append_verify_and_replay(history: LocalHistory) -> None:
    history.complete()
    before = snapshot(history.store.root)
    state = replay(history.reader.journal, history.reader.objects, history.reader.authority)
    assert state == history.reader.verify()
    assert len(state.records) == 6
    assert state.active_bundle == history.next_bundle
    assert state.active_revision == RevisionId(history.frames[3].envelope.record_id)
    assert state.revisions == ((RevisionId("run-1:r0"), history.pin), (RevisionId("run-1:r3"), history.next_bundle))
    assert state.private_state == b"private-state\x00" and state.environment == history.pin
    assert state.effect(EffectId("effect-1")).state is EffectState.CONSUMED
    assert state.effect(EffectId("effect-1")).response == history.response
    assert state.consumed_results == {ResultCursor(EffectId("effect-1"), history.frames[2].envelope.record_id)}
    assert {item.resource: item.quantity for item in state.measured} == {Resource.INPUT_TOKENS: 40, Resource.USD_NANODOLLARS: 400}
    assert not state.obligations
    assert before == snapshot(history.store.root)


@pytest.mark.parametrize("attack", ["missing", "corrupt"])
def test_required_artifact_missing_or_corrupted_stops_reads_and_appends(history: LocalHistory, attack: str) -> None:
    history.complete()
    path = history.store.objects.path(history.response)
    if attack == "missing":
        path.unlink()
    else:
        path.write_bytes(b"forged outcome")
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError, match="artifact"):
        history.reader.verify()
    with pytest.raises(VerificationError, match="artifact"):
        history.append(opaque_annotation("some.diagnostic", b"irrelevant"), ProducerKind.CANDIDATE)
    assert before == snapshot(history.store.root)


def test_tampered_record_hash_chain_rejected_even_with_valid_mac(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    frame = attempted_frame(history, history.settlement(), prior=history.pin)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError, match="hash chain"):
        history.reader.verify()


def test_record_digest_and_commit_checksum_are_checked(history: LocalHistory) -> None:
    original = history.frames[0]
    bad = replace(original.envelope, integrity_linkage=replace(original.envelope.integrity_linkage, record_digest=history.pin))
    frame = history.reader.authority.sign(original.epoch, original.append_path, bad)
    history.reader.journal.path.write_bytes(pack_frame(frame))
    with pytest.raises(VerificationError, match="record digest"):
        history.reader.verify()
    packed = bytearray(pack_frame(original))
    packed[-41] ^= 1
    history.reader.journal.path.write_bytes(packed)
    with pytest.raises(JournalCorruption, match="damaged"):
        history.reader.verify()


def test_illegal_transition_fails_preflight_and_replay_without_mutating_state(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    bad = replace(history.settlement(), state=EffectState.CONSUMED)
    frame = attempted_frame(history, bad)
    state = history.reader.verify()
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError, match="consume"):
        preflight(state, frame, history.reader.objects, history.reader.authority)
    assert state == history.reader.verify() and before == snapshot(history.store.root)
    with pytest.raises(VerificationError, match="consume"):
        history.append(bad, ProducerKind.TRUSTED_ADAPTER)
    assert before == snapshot(history.store.root)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError, match="consume"):
        history.reader.verify()


def test_forged_producer_identity_and_wrong_owner_port_are_rejected(history: LocalHistory) -> None:
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError, match="own"):
        history.append(history.authorization(), ProducerKind.CANDIDATE)
    assert snapshot(history.store.root) == before
    history.append(history.authorization(), ProducerKind.BROKER)
    frame = attempted_frame(history, history.settlement())
    forged = replace(frame.envelope, producer_identity=ProducerIdentity(ProducerKind.TRUSTED_SCORER, history.pin))
    forged = replace(forged, integrity_linkage=replace(forged.integrity_linkage, record_digest=record_digest(forged, frame.epoch, frame.append_path)))
    frame = history.reader.authority.sign(frame.epoch, frame.append_path, forged)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError, match="forged producer"):
        history.reader.verify()


def test_producer_name_and_hash_are_not_authentication(history: LocalHistory) -> None:
    frame = history.frames[0]
    changed = replace(frame.envelope, record_id=RecordId("forged-binding"))
    changed = replace(changed, integrity_linkage=replace(changed.integrity_linkage, record_digest=record_digest(changed, frame.epoch, frame.append_path)))
    history.reader.journal.path.write_bytes(pack_frame(replace(frame, envelope=changed)))
    with pytest.raises(VerificationError, match="authentication"):
        history.reader.verify()


def test_second_result_consumption_is_rejected(history: LocalHistory) -> None:
    history.complete()
    previous = history.reader.verify().records[4].payload
    assert isinstance(previous, ContinuationCommit)
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError, match="already consumed"):
        history.append(previous)
    assert before == snapshot(history.store.root)
    frame = attempted_frame(history, previous)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError, match="already consumed"):
        history.reader.verify()


def test_second_writer_and_stale_epoch_are_rejected(history: LocalHistory) -> None:
    with pytest.raises(LeaseError, match="already has a writer"):
        history.store.writer(history.reader.authority.run_id)
    port = history.writer.port(ProducerKind.CANDIDATE)
    with pytest.raises(LeaseError, match="stale"):
        port.append(opaque_annotation("opaque.test", b"x"), causal=CausalIdentity(history.frames[0].envelope.record_id, None, None, None), epoch=0)
    old_epoch = history.writer.epoch
    history.writer.close()
    with history.store.writer(history.reader.authority.run_id) as replacement:
        assert replacement.epoch == old_epoch + 1
        with pytest.raises(LeaseError, match="closed|stale"):
            port.append(opaque_annotation("opaque.test", b"x"), causal=CausalIdentity(history.frames[0].envelope.record_id, None, None, None), epoch=old_epoch)


@pytest.mark.parametrize("cut", [1, 11, 12, 30, -1, -8, -40])
def test_torn_final_frame_requires_explicit_recovery(history: LocalHistory, cut: int) -> None:
    original = history.reader.journal.path.read_bytes()
    history.append(opaque_annotation("unknown.schema", b"x"), ProducerKind.CANDIDATE)
    complete = history.reader.journal.path.read_bytes()
    history.reader.journal.path.write_bytes(original + complete[len(original):][:cut])
    history.writer.close()
    before = snapshot(history.store.root)
    with pytest.raises(IncompleteTail, match="explicit recovery") as error:
        history.reader.verify()
    assert error.value.offset == len(original)
    with pytest.raises(IncompleteTail):
        history.store.writer(history.reader.authority.run_id)
    assert before == snapshot(history.store.root)


def test_unknown_bounded_annotations_are_opaque_and_never_authority(history: LocalHistory) -> None:
    prior = history.reader.verify()
    payload = b'\xff\x00{"effect_id":"fake", "producer":"broker", "usage":0}'
    frame = history.append(opaque_annotation("unknown.v100", payload), ProducerKind.CANDIDATE)
    after = history.reader.verify()
    assert replace(after, records=prior.records) == prior
    assert isinstance(after.records[-1].payload, Annotation) and after.records[-1].payload.payload == payload
    assert decode(history.reader.objects.read(frame.envelope.payload_reference)) == opaque_annotation("unknown.v100", payload)
    with pytest.raises(VerificationError, match="quota"):
        opaque_annotation("unknown.schema", b"x" * (MAX_ANNOTATION_BYTES + 1))


def test_revision_continuity_and_controller_handover_boundary(history: LocalHistory) -> None:
    state = history.reader.verify()
    assert state.active_revision is not None
    with pytest.raises(VerificationError, match="continuity"):
        history.append(RevisionActivation(history.next_bundle, history.pin, state.active_revision, history.pin, None))
    history.append(history.authorization(), ProducerKind.BROKER)
    with pytest.raises(VerificationError, match="boundary"):
        history.append(RevisionActivation(history.pin, history.next_bundle, state.active_revision, history.pin, None))
    history.append(history.settlement(), ProducerKind.TRUSTED_ADAPTER)
    with pytest.raises(VerificationError, match="unconsumed"):
        history.append(RevisionActivation(history.pin, history.next_bundle, state.active_revision, history.pin, history.pin))


def test_cas_content_deduplication_does_not_deduplicate_execution(history: LocalHistory) -> None:
    assert history.store.objects.publish(b"recorded result") == history.response
    history.complete()
    second = replace(history.authorization(), effect_id=EffectId("effect-2"), command_id=CommandId("command-2"), executing_bundle=history.next_bundle)
    parent = history.frames[-1].envelope
    causal = replace(parent.causal_identity, parent_record=parent.record_id, effect_id=second.effect_id, command_id=second.command_id)
    history.writer.port(ProducerKind.BROKER).append(second, causal=causal, epoch=history.writer.epoch)
    state = history.reader.verify()
    assert len(state.effects) == 2 and state.effects[0].authorization.exact_request_reference == state.effects[1].authorization.exact_request_reference
    assert {item.resource: item.quantity for item in state.obligations} == {Resource.INPUT_TOKENS: 100, Resource.USD_NANODOLLARS: 1000}


def test_partial_usage_retains_unknown_obligation_through_consumption_and_late_receipt(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    partial = replace(history.settlement(), usage_completeness=UsageCompleteness.PARTIAL,
                      reservation_disposition=ReservationDisposition.REPLACE_KNOWN_COMPONENTS,
                      usage=(history.settlement().usage[0], UsageObservation(UsageKind.UNKNOWN, None, UsageProvenance.GATEWAY, history.pin,
                                                                          ResourceQuantity(Resource.USD_NANODOLLARS, 1000))))
    result = history.append(partial, ProducerKind.TRUSTED_ADAPTER)
    cursor = ResultCursor(EffectId("effect-1"), result.envelope.record_id)
    history.append(ContinuationCommit(b"done", history.pin, cursor, None, history.pin, ExecutionStatus.FINISHED))
    state = history.reader.verify()
    assert state.obligations == (ResourceQuantity(Resource.USD_NANODOLLARS, 1000),)
    late = replace(history.settlement(), state=EffectState.CONSUMED, reconciliation_references=(history.pin,))
    causal = replace(result.envelope.causal_identity, parent_record=result.envelope.record_id)
    history.writer.port(ProducerKind.TRUSTED_ADAPTER).append(late, causal=causal, epoch=history.writer.epoch)
    state = history.reader.verify()
    assert not state.obligations and state.execution_status is ExecutionStatus.FINISHED
    assert state.consumed_results == {cursor}
    assert {item.resource: item.quantity for item in state.measured} == {Resource.INPUT_TOKENS: 40, Resource.USD_NANODOLLARS: 400}


def test_uncertain_outcome_keeps_reservations_and_cannot_be_consumed(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    uncertain = replace(history.settlement(), state=EffectState.UNCERTAIN, outcome_status=OutcomeStatus.UNCERTAIN,
                        response_reference=None, usage=(), usage_completeness=UsageCompleteness.MISSING,
                        reservation_disposition=ReservationDisposition.RETAIN)
    result = history.append(uncertain, ProducerKind.TRUSTED_ADAPTER)
    with pytest.raises(VerificationError, match="cursor"):
        history.append(ContinuationCommit(b"x", history.pin, ResultCursor(EffectId("effect-1"), result.envelope.record_id), None, history.pin, ExecutionStatus.CONTINUE))
    assert history.reader.verify().obligations


@pytest.mark.parametrize("fault", ["missing_component", "double_count", "erased_unknown", "wrong_overrun"])
def test_inconsistent_reservation_settlement_rejected(history: LocalHistory, fault: str) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    settlement = history.settlement()
    if fault == "missing_component":
        settlement = replace(settlement, usage=settlement.usage[:1])
    elif fault == "double_count":
        settlement = replace(settlement, usage=settlement.usage + settlement.usage[:1])
    elif fault == "erased_unknown":
        settlement = replace(settlement, usage_completeness=UsageCompleteness.PARTIAL,
                             reservation_disposition=ReservationDisposition.REPLACE_KNOWN_COMPONENTS,
                             usage=(UsageObservation(UsageKind.UNKNOWN, None, UsageProvenance.GATEWAY, history.pin,
                                                     ResourceQuantity(Resource.INPUT_TOKENS, 1)),))
    else:
        settlement = replace(settlement, overrun=(ResourceQuantity(Resource.INPUT_TOKENS, 1),))
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError):
        history.append(settlement, ProducerKind.TRUSTED_ADAPTER)
    assert snapshot(history.store.root) == before


def test_real_overrun_is_recorded_and_stops_new_dispatch(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    settlement = history.settlement()
    settlement = replace(settlement, usage=(replace(settlement.usage[0], quantity=ResourceQuantity(Resource.INPUT_TOKENS, 110)), settlement.usage[1]),
                         overrun=(ResourceQuantity(Resource.INPUT_TOKENS, 10),))
    returned = history.append(settlement, ProducerKind.TRUSTED_ADAPTER)
    history.append(ContinuationCommit(b"stop", history.pin, ResultCursor(EffectId("effect-1"), returned.envelope.record_id), None, history.pin, ExecutionStatus.SUSPENDED))
    assert history.reader.verify().dispatch_stopped
    with pytest.raises(VerificationError, match="stopped"):
        history.append(history.authorization(), ProducerKind.BROKER)


def test_harness_launch_and_upstream_forward_share_one_reservation(history: LocalHistory) -> None:
    authorization = replace(history.authorization(), operation="model.generate", dispatch_stage=DispatchStage.HARNESS_LAUNCH,
                            harness_binding_reference=history.pin, generation_envelope=history.pin)
    history.append(authorization, ProducerKind.BROKER)
    history.append(replace(authorization, dispatch_stage=DispatchStage.UPSTREAM_FORWARD, actual_provider_request_reference=history.response), ProducerKind.BROKER)
    assert len(history.reader.verify().effects) == 1
    assert history.reader.verify().obligations == authorization.reservation.components
    with pytest.raises(VerificationError, match="duplicate"):
        history.append(replace(authorization, dispatch_stage=DispatchStage.UPSTREAM_FORWARD, actual_provider_request_reference=history.response), ProducerKind.BROKER)


def test_publish_before_reference_and_commit_failure_leave_detectable_tail(history: LocalHistory, monkeypatch: pytest.MonkeyPatch) -> None:
    committed = history.reader.journal.path.read_bytes()
    original_commit = RunWriter._commit
    called = False

    def interrupted(writer: RunWriter, packed: bytes) -> None:
        nonlocal called
        called = True
        frame = Frame.from_bytes(packed[12:-40])
        assert content_ref(writer.objects.read(frame.envelope.payload_reference)) == frame.envelope.payload_reference
        with writer.reader.journal.path.open("ab") as stream:
            stream.write(packed[:-1])
        raise OSError("injected interruption")

    monkeypatch.setattr(RunWriter, "_commit", interrupted)
    with pytest.raises(OSError, match="interruption"):
        history.append(history.authorization(), ProducerKind.BROKER)
    assert called and history.reader.journal.path.read_bytes().startswith(committed)
    with pytest.raises(IncompleteTail):
        history.reader.verify()
    monkeypatch.setattr(RunWriter, "_commit", original_commit)
    with pytest.raises(LeaseError):
        history.writer.port(ProducerKind.BROKER)


def test_closed_codec_rejects_unknown_fields_boolean_integers_and_arbitrary_types(history: LocalHistory) -> None:
    wire = encode(history.authorization())
    for malformed in (wire.replace(b'"execution_epoch":1', b'"execution_epoch":true'),
                      wire.replace(b'"execution_epoch":1', b'"unknown":1,"execution_epoch":1'),
                      wire.replace(b'"EffectAuthorization"', b'"candidate.Evil"')):
        with pytest.raises(VerificationError, match="malformed"):
            decode(malformed)


def test_old_artifact_roots_and_path_traversal_are_rejected(tmp_path: Path) -> None:
    root = tmp_path / "legacy"
    root.mkdir()
    (root / "ledger").mkdir()
    with pytest.raises(VerificationError, match="legacy"):
        ArtifactStore(root)
    store = ArtifactStore(tmp_path / "new")
    with pytest.raises(VerificationError, match="run ID"):
        store.reader(RunId("../escape"))


@pytest.mark.parametrize("fault", ["sequence", "future_parent", "epoch", "invocation", "class"])
def test_envelope_and_causation_fail_closed(history: LocalHistory, fault: str) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    frame = attempted_frame(history, history.settlement())
    envelope = frame.envelope
    if fault == "sequence":
        envelope = replace(envelope, sequence=envelope.sequence + 1)
    elif fault == "future_parent":
        envelope = replace(envelope, causal_identity=replace(envelope.causal_identity, parent_record=RecordId("future")))
    elif fault == "epoch":
        payload = replace(history.settlement(), execution_epoch=0)
        envelope = replace(envelope, payload_reference=history.store.objects.publish(encode(payload)))
    elif fault == "invocation":
        envelope = replace(envelope, causal_identity=replace(envelope.causal_identity, invocation_id=InvocationId("wrong-invocation")))
    else:
        envelope = replace(envelope, record_class=RecordClass.ANNOTATION)
    envelope = replace(envelope, integrity_linkage=replace(envelope.integrity_linkage, record_digest=record_digest(envelope, frame.epoch, frame.append_path)))
    frame = history.reader.authority.sign(frame.epoch, frame.append_path, envelope)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError):
        history.reader.verify()


def test_committed_malformed_payload_is_not_treated_as_torn_tail(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    frame = attempted_frame(history, history.settlement())
    payload = encode(history.settlement()).replace(b'"execution_epoch":1', b'"execution_epoch":true')
    envelope = replace(frame.envelope, payload_reference=history.store.objects.publish(payload))
    envelope = replace(envelope, integrity_linkage=replace(envelope.integrity_linkage, record_digest=record_digest(envelope, frame.epoch, frame.append_path)))
    frame = history.reader.authority.sign(frame.epoch, frame.append_path, envelope)
    with history.reader.journal.path.open("ab") as stream:
        stream.write(pack_frame(frame))
    with pytest.raises(VerificationError, match="malformed") as error:
        history.reader.verify()
    assert not isinstance(error.value, IncompleteTail)


def test_new_epoch_rejects_stale_return_and_requires_reconciliation(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    old_return = history.settlement()
    history.writer.close()
    history.writer = history.store.writer(history.reader.authority.run_id)
    with pytest.raises(VerificationError, match="stale observation"):
        history.append(old_return, ProducerKind.TRUSTED_ADAPTER)
    with pytest.raises(VerificationError, match="explicit reconciliation"):
        history.append(history.settlement(), ProducerKind.TRUSTED_ADAPTER)
    history.append(replace(history.settlement(), reconciliation_references=(history.pin,)), ProducerKind.TRUSTED_ADAPTER)
    assert history.reader.verify().effect(EffectId("effect-1")).state is EffectState.SETTLED


def test_explicit_dispatch_return_settlement_uses_original_result_cursor(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    dispatch = replace(history.settlement(), state=EffectState.DISPATCHED, outcome_status=OutcomeStatus.DISPATCHED,
                       response_reference=None, usage=(), usage_completeness=UsageCompleteness.MISSING,
                       reservation_disposition=ReservationDisposition.RETAIN)
    history.append(dispatch, ProducerKind.TRUSTED_ADAPTER)
    returned = history.append(replace(history.settlement(), state=EffectState.RETURNED,
                                      reservation_disposition=ReservationDisposition.RETAIN), ProducerKind.TRUSTED_ADAPTER)
    history.append(history.settlement(), ProducerKind.TRUSTED_ADAPTER)
    cursor = ResultCursor(EffectId("effect-1"), returned.envelope.record_id)
    history.append(ContinuationCommit(b"advanced", history.pin, cursor, None, history.pin, ExecutionStatus.CONTINUE))
    assert history.reader.verify().consumed_results == {cursor}


def test_committed_command_matches_authorization_and_is_not_lost(history: LocalHistory) -> None:
    command = history.store.objects.publish(encode(ExecuteEffect("benchmark.tool", "benchmark", history.pin)))
    continuation = ContinuationCommit(b"awaiting", history.pin, None, command, history.pin, ExecutionStatus.CONTINUE)
    causal = CausalIdentity(history.frames[-1].envelope.record_id, InvocationId("invocation-1"), CommandId("command-1"), None)
    frame = history.writer.port(ProducerKind.SUPERVISOR).append(continuation, causal=causal, epoch=history.writer.epoch)
    history.frames.append(frame)
    with pytest.raises(VerificationError, match="lose"):
        history.append(replace(continuation, pending_command_reference=None))
    with pytest.raises(VerificationError, match="differs"):
        history.append(replace(history.authorization(), exact_request_reference=history.response), ProducerKind.BROKER)
    history.append(history.authorization(), ProducerKind.BROKER)
    assert history.reader.verify().pending_command is None


def test_committed_apply_change_activates_exact_bundle_and_private_state(history: LocalHistory) -> None:
    state = history.reader.verify()
    assert state.active_revision is not None
    private_state = history.store.objects.publish(b"new controller state")
    command = history.store.objects.publish(encode(ApplyChange(history.next_bundle, state.active_revision, private_state)))
    continuation = ContinuationCommit(b"old controller", history.pin, None, command, history.pin, ExecutionStatus.CONTINUE)
    causal = CausalIdentity(history.frames[-1].envelope.record_id, InvocationId("invoke"), CommandId("change-1"), None)
    accepted = history.writer.port(ProducerKind.SUPERVISOR).append(continuation, causal=causal, epoch=history.writer.epoch)
    activation = RevisionActivation(history.pin, history.next_bundle, state.active_revision, history.pin, private_state)
    frame = history.writer.port(ProducerKind.SUPERVISOR).append(activation, causal=replace(causal, parent_record=accepted.envelope.record_id), epoch=history.writer.epoch)
    state = history.reader.verify()
    assert state.pending_command is None and state.private_state == b"new controller state"
    assert state.active_revision == RevisionId(frame.envelope.record_id)
    assert state.active_bundle == history.next_bundle


def test_nested_pending_command_references_are_required(history: LocalHistory) -> None:
    absent = ArtifactRef("sha256:" + "f" * 64)
    command = history.store.objects.publish(encode(ExecuteEffect("benchmark.tool", "benchmark", absent)))
    continuation = ContinuationCommit(b"awaiting", history.pin, None, command, history.pin, ExecutionStatus.CONTINUE)
    causal = CausalIdentity(history.frames[-1].envelope.record_id, InvocationId("invoke"), CommandId("command-1"), None)
    before = snapshot(history.store.root)
    with pytest.raises(VerificationError, match="artifact"):
        history.writer.port(ProducerKind.SUPERVISOR).append(continuation, causal=causal, epoch=history.writer.epoch)
    assert before == snapshot(history.store.root)


def test_measurement_requires_scorer_owner_and_bound_revisions(history: LocalHistory) -> None:
    state = history.reader.verify()
    assert state.active_revision is not None
    measurement = Measurement(history.reader.authority.run_id, history.pin, (state.active_revision,), history.pin, history.pin,
                              (history.pin,), (history.pin,), ("task-1",), ("task-1",), ("task-1",), (), history.pin, Decimal("1"),
                              "retained-benchmark-revision", history.pin, None, None, history.pin, history.pin)
    with pytest.raises(VerificationError, match="own"):
        history.append(measurement, ProducerKind.CANDIDATE)
    history.append(measurement, ProducerKind.TRUSTED_SCORER)
    assert history.reader.verify().measurements == (measurement,)
    with pytest.raises(VerificationError, match="revision"):
        history.append(replace(measurement, revision_references=(RevisionId("never-active"),)), ProducerKind.TRUSTED_SCORER)


def test_late_accounting_cannot_rewind_environment(history: LocalHistory) -> None:
    history.complete()
    late = replace(history.settlement(), state=EffectState.CONSUMED, reconciliation_references=(history.pin,),
                   observed_environment_version=history.next_bundle)
    effect = history.reader.verify().effect(EffectId("effect-1"))
    causal = CausalIdentity(effect.last_record_id, effect.invocation_id, effect.authorization.command_id, effect.authorization.effect_id)
    with pytest.raises(VerificationError, match="rewind"):
        history.writer.port(ProducerKind.TRUSTED_ADAPTER).append(late, causal=causal, epoch=history.writer.epoch)


def test_payload_and_directory_fsync_precede_journal_commit(history: LocalHistory, monkeypatch: pytest.MonkeyPatch) -> None:
    synced: list[int] = []
    real_fsync = os.fsync
    real_commit = RunWriter._commit
    commits = 0

    def track_sync(descriptor: int) -> None:
        real_fsync(descriptor)
        synced.append(os.fstat(descriptor).st_ino)

    def check_commit(writer: RunWriter, packed: bytes) -> None:
        nonlocal commits
        commits += 1
        frame = Frame.from_bytes(packed[12:-40])
        assert writer.objects.path(frame.envelope.payload_reference).stat().st_ino in synced
        assert writer.objects.directory.stat().st_ino in synced
        assert writer.objects.path(history.pin).stat().st_ino in synced
        real_commit(writer, packed)
        assert synced[-1] == writer.reader.journal.path.stat().st_ino

    monkeypatch.setattr(os, "fsync", track_sync)
    monkeypatch.setattr(RunWriter, "_commit", check_commit)
    history.append(history.authorization(), ProducerKind.BROKER)
    assert commits == 1


def test_cas_fsync_failure_never_commits_reference(history: LocalHistory, monkeypatch: pytest.MonkeyPatch) -> None:
    journal = history.reader.journal.path.read_bytes()
    real_fsync = os.fsync

    def fail_payload_sync(descriptor: int) -> None:
        if os.fstat(descriptor).st_size == len(encode(history.authorization())):
            raise OSError("injected CAS fsync failure")
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", fail_payload_sync)
    with pytest.raises(OSError, match="CAS fsync"):
        history.append(history.authorization(), ProducerKind.BROKER)
    assert history.reader.journal.path.read_bytes() == journal
    assert len(history.reader.verify().records) == 1


def test_known_zero_usage_remains_known_when_another_component_settles_later(history: LocalHistory) -> None:
    history.append(history.authorization(), ProducerKind.BROKER)
    original = history.settlement()
    zero = replace(original.usage[0], quantity=ResourceQuantity(Resource.INPUT_TOKENS, 0))
    unknown_cost = UsageObservation(UsageKind.UNKNOWN, None, UsageProvenance.GATEWAY, history.pin,
                                    ResourceQuantity(Resource.USD_NANODOLLARS, 1000))
    partial = replace(original, usage=(zero, unknown_cost), usage_completeness=UsageCompleteness.PARTIAL,
                      reservation_disposition=ReservationDisposition.REPLACE_KNOWN_COMPONENTS)
    history.append(partial, ProducerKind.TRUSTED_ADAPTER)
    assert history.reader.verify().effects[0].measured == (ResourceQuantity(Resource.INPUT_TOKENS, 0),)
    late = replace(original, usage=original.usage[1:], reconciliation_references=(history.pin,))
    history.append(late, ProducerKind.TRUSTED_ADAPTER)
    state = history.reader.verify()
    assert not state.obligations
    assert state.effects[0].measured == (ResourceQuantity(Resource.INPUT_TOKENS, 0), ResourceQuantity(Resource.USD_NANODOLLARS, 400))


def test_close_cannot_release_lease_during_an_append(history: LocalHistory, monkeypatch: pytest.MonkeyPatch) -> None:
    from threading import Event, Thread

    in_commit, release_commit, closing, closed = Event(), Event(), Event(), Event()
    failures: list[BaseException] = []
    real_commit = RunWriter._commit

    def paused_commit(writer: RunWriter, packed: bytes) -> None:
        in_commit.set()
        assert release_commit.wait(5)
        real_commit(writer, packed)

    def append() -> None:
        try:
            history.append(history.authorization(), ProducerKind.BROKER)
        except BaseException as error:
            failures.append(error)

    def close() -> None:
        closing.set()
        history.writer.close()
        closed.set()

    monkeypatch.setattr(RunWriter, "_commit", paused_commit)
    appender, closer = Thread(target=append), Thread(target=close)
    appender.start()
    assert in_commit.wait(5)
    closer.start()
    try:
        assert closing.wait(5)
        assert not closed.wait(0.05)
        with pytest.raises(LeaseError, match="already has a writer"):
            history.store.writer(history.reader.authority.run_id)
    finally:
        release_commit.set()
        appender.join(5)
        closer.join(5)
    assert not appender.is_alive() and not closer.is_alive() and not failures
    assert len(history.reader.verify().records) == 2
