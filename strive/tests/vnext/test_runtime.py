from dataclasses import replace
from pathlib import Path
from typing import Iterator

import pytest

from strive.vnext.codec import decode, encode
from strive.vnext.contracts.annotations import Annotation
from strive.vnext.contracts.commands import ApplyChange, Continue, Finish, StepOutput, Suspend
from strive.vnext.contracts.lifecycle import DispatchStage, EffectState, RecoveryCapability, RecoveryContract
from strive.vnext.contracts.primitives import ArtifactRef, ExecutionStatus, LineageId, Resource, ResourceQuantity
from strive.vnext.contracts.records import ContinuationCommit, EffectAuthorization, EffectObservationSettlement
from strive.vnext.errors import LeaseError, VerificationError
from strive.vnext.runtime import Boundary, EffectRequest
from strive.vnext.runtime.ledger import amounts

from .runtime_fixtures import RuntimeFixture


class Crash(BaseException):
    pass


@pytest.fixture
def runtime(tmp_path: Path) -> Iterator[RuntimeFixture]:
    fixture = RuntimeFixture(tmp_path / "runtime")
    yield fixture
    fixture.close()


def arm(runtime: RuntimeFixture, boundary: Boundary) -> None:
    def fault(actual: Boundary) -> None:
        if actual is boundary:
            raise Crash(actual)
    runtime.supervisor.fault = fault


def accept_effect(runtime: RuntimeFixture) -> None:
    supervisor = runtime.supervisor
    supervisor.accept(StepOutput(runtime.command(), b"before effect"), expected_head=supervisor.state.head)


def consume(runtime: RuntimeFixture, *, finish: bool = False) -> None:
    supervisor = runtime.supervisor
    supervisor.accept(StepOutput(Finish("done") if finish else Continue(), b"consumed exactly once"), expected_head=supervisor.state.head)


@pytest.mark.parametrize("boundary", [Boundary.ACCEPTED, Boundary.AUTHORIZED, Boundary.DISPATCH,
                                      Boundary.EXTERNAL_RETURN, Boundary.RETURN_RECORDED, Boundary.SETTLED])
def test_crash_and_recover_every_effect_boundary(runtime: RuntimeFixture, boundary: Boundary) -> None:
    arm(runtime, boundary)
    with pytest.raises(Crash):
        accept_effect(runtime)
        runtime.supervisor.drive()
    prior_calls = runtime.provider.calls
    supervisor = runtime.restart()
    supervisor.recover()
    if boundary in {Boundary.AUTHORIZED, Boundary.DISPATCH}:
        assert supervisor.state.execution_status is ExecutionStatus.SUSPENDED
        assert supervisor.state.effects[0].state is EffectState.UNCERTAIN
        assert amounts(supervisor.state.obligations)[Resource.INPUT_TOKENS] == 100
        assert runtime.provider.calls == prior_calls == 0
        supervisor.recover()
        assert runtime.provider.calls == 0
    else:
        assert runtime.provider.calls == 1
        assert amounts(supervisor.state.measured)[Resource.INPUT_TOKENS] == 40
        assert not supervisor.state.obligations
        consume(runtime)
        runtime.restart().recover()
        assert len(runtime.supervisor.state.consumed_results) == 1
        assert runtime.supervisor.state.private_state == b"consumed exactly once"
        assert runtime.provider.calls == 1
    for record in runtime.reader.verify().records:
        if isinstance(record.payload, EffectAuthorization):
            assert runtime.store.objects.read(record.payload.exact_request_reference)
            assert record.payload.reservation.components


def test_continuation_consumes_result_and_next_command_atomically(runtime: RuntimeFixture) -> None:
    accept_effect(runtime)
    runtime.supervisor.drive()
    arm(runtime, Boundary.CONTINUATION)
    with pytest.raises(Crash):
        runtime.supervisor.accept(StepOutput(runtime.command(), b"next command saved"), expected_head=runtime.supervisor.state.head)
    state = runtime.reader.verify()
    assert len(state.consumed_results) == 1 and state.pending_command is not None
    assert state.private_state == b"next command saved"
    runtime.restart().recover()
    assert runtime.provider.calls == 2
    consume(runtime)
    runtime.restart().recover()
    assert len(runtime.supervisor.state.consumed_results) == 2
    assert amounts(runtime.supervisor.state.measured)[Resource.INPUT_TOKENS] == 80


def test_unsupported_ambiguity_retains_reservation_even_after_real_mutation(runtime: RuntimeFixture) -> None:
    runtime.provider.recovery = RecoveryContract(frozenset({RecoveryCapability.SUSPEND}), False, False)
    arm(runtime, Boundary.EXTERNAL_RETURN)
    with pytest.raises(Crash):
        accept_effect(runtime)
        runtime.supervisor.drive()
    runtime.restart().recover()
    assert runtime.provider.calls == 1 and runtime.provider.lookups == 0
    assert runtime.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
    assert amounts(runtime.supervisor.state.obligations)[Resource.INPUT_TOKENS] == 100
    with pytest.raises(VerificationError, match="unresolved"):
        accept_effect(runtime)


def test_business_deduplication_does_not_authorize_paid_retry(runtime: RuntimeFixture) -> None:
    runtime.provider.recovery = RecoveryContract(frozenset({RecoveryCapability.DEDUPLICATED_RETRY}), True, False)
    arm(runtime, Boundary.EXTERNAL_RETURN)
    with pytest.raises(Crash):
        accept_effect(runtime)
        runtime.supervisor.drive()
    runtime.restart().recover()
    assert runtime.provider.lookups == 0 and runtime.provider.calls == 1
    assert runtime.supervisor.state.obligations


@pytest.mark.parametrize("attack", ["destination", "scope", "operation", "arguments", "inputs", "binding"])
def test_broker_rejects_unauthorized_requests(runtime: RuntimeFixture, attack: str) -> None:
    request = EffectRequest("fake://provider", runtime.arguments, runtime.scope)
    if attack == "destination":
        request = replace(request, destination="https://attacker.invalid")
    elif attack == "scope":
        request = replace(request, scope=replace(runtime.scope, lineage_id=LineageId("audit")))
    elif attack == "arguments":
        request = replace(request, arguments=runtime.pin)
    elif attack == "inputs":
        request = replace(request, inputs=(runtime.pin,))
    command = runtime.command(request, operation="shell.exec" if attack == "operation" else "model.generate",
                              binding="refiner" if attack == "binding" else "actor")
    head = runtime.supervisor.state.head
    with pytest.raises(VerificationError, match="not permitted"):
        runtime.supervisor.accept(StepOutput(command, b"bad"), expected_head=head)
    assert runtime.reader.verify().head == head and runtime.provider.calls == 0


def test_reservation_over_limit_rejected_without_dispatch(runtime: RuntimeFixture) -> None:
    runtime.provider.bound = (ResourceQuantity(Resource.INPUT_TOKENS, 1001),)
    with pytest.raises(VerificationError, match="budget"):
        accept_effect(runtime)
    assert not runtime.reader.verify().effects and runtime.provider.calls == 0


def test_candidate_cannot_underreport_usage_with_annotations(runtime: RuntimeFixture) -> None:
    runtime.supervisor.accept(StepOutput(runtime.command(), b"usage=0", (Annotation("candidate.usage", b'{"tokens":0}'),)),
                              expected_head=runtime.supervisor.state.head)
    runtime.supervisor.drive()
    consume(runtime)
    assert amounts(runtime.supervisor.state.measured)[Resource.INPUT_TOKENS] == 40


def test_stale_result_suspends_and_keeps_reservation(runtime: RuntimeFixture) -> None:
    runtime.provider.stale = True
    accept_effect(runtime)
    with pytest.raises(VerificationError, match="stale result"):
        runtime.supervisor.drive()
    assert runtime.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
    assert runtime.supervisor.state.obligations and not runtime.supervisor.state.consumed_results


def test_old_writer_and_stale_step_are_rejected(runtime: RuntimeFixture) -> None:
    old = runtime.supervisor
    head = old.state.head
    runtime.restart()
    with pytest.raises(LeaseError):
        old.accept(StepOutput(Continue(), b""), expected_head=head)
    accept_effect(runtime)
    with pytest.raises(VerificationError, match="stale step"):
        runtime.supervisor.accept(StepOutput(Continue(), b""), expected_head=head)


def test_overrun_is_recorded_and_stops_further_dispatch(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = (ResourceQuantity(Resource.INPUT_TOKENS, 1200), ResourceQuantity(Resource.MODEL_CALLS, 1))
    accept_effect(runtime)
    runtime.supervisor.drive()
    state = runtime.reader.verify()
    assert state.dispatch_stopped and state.execution_status is ExecutionStatus.SUSPENDED
    assert amounts(state.measured)[Resource.INPUT_TOKENS] == 1200
    assert amounts(state.effects[0].overrun)[Resource.INPUT_TOKENS] == 1100
    with pytest.raises(VerificationError, match="dispatch stopped"):
        accept_effect(runtime)
    runtime.restart().recover()
    assert runtime.provider.calls == 1 and runtime.supervisor.state.dispatch_stopped


def test_partial_usage_late_receipt_after_finish_never_reopens_result(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = (ResourceQuantity(Resource.MODEL_CALLS, 1),)
    accept_effect(runtime)
    runtime.supervisor.drive()
    assert amounts(runtime.supervisor.state.obligations)[Resource.INPUT_TOKENS] == 100
    consume(runtime, finish=True)
    supervisor = runtime.restart()
    supervisor.recover()
    effect = supervisor.state.effects[0]
    receipt = replace(runtime.provider.receipts[effect.authorization.effect_id], epoch=runtime.writer.epoch,
                      measured=(ResourceQuantity(Resource.INPUT_TOKENS, 70),))
    supervisor.late_receipt(effect.authorization.effect_id, receipt)
    assert not supervisor.state.obligations
    assert amounts(supervisor.state.measured)[Resource.INPUT_TOKENS] == 70
    assert supervisor.state.execution_status is ExecutionStatus.FINISHED
    assert len(supervisor.state.consumed_results) == 1
    with pytest.raises(VerificationError, match="duplicate settlement"):
        supervisor.late_receipt(effect.authorization.effect_id, receipt)
    with pytest.raises(VerificationError, match="cannot disappear"):
        supervisor.late_receipt(effect.authorization.effect_id, replace(receipt, measured=(ResourceQuantity(Resource.INPUT_TOKENS, 0),)))
    assert runtime.provider.calls == 1


def test_missing_usage_carries_obligation_into_next_admission(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = ()
    runtime.provider.bound = (ResourceQuantity(Resource.INPUT_TOKENS, 600),)
    accept_effect(runtime)
    runtime.supervisor.drive()
    consume(runtime)
    runtime.restart()
    with pytest.raises(VerificationError, match="budget"):
        accept_effect(runtime)
    assert amounts(runtime.supervisor.state.obligations)[Resource.INPUT_TOKENS] == 600


def test_operator_restore_uses_durable_command_preserves_accounting(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = ()
    accept_effect(runtime)
    runtime.supervisor.drive()
    consume(runtime)
    state = runtime.supervisor.state
    assert state.active_revision is not None
    runtime.supervisor.accept(StepOutput(ApplyChange(runtime.pin, state.active_revision), b"new"), expected_head=state.head)
    runtime.supervisor.drive()
    runtime.supervisor.accept(StepOutput(Suspend("broken controller"), b"broken"), expected_head=runtime.supervisor.state.head)
    before = runtime.supervisor.state
    arm(runtime, Boundary.ACTIVATED)
    with pytest.raises(Crash):
        runtime.supervisor.restore(runtime.bundle)
    runtime.restart().recover()
    after = runtime.supervisor.state
    assert after.active_bundle == runtime.bundle
    assert after.obligations == before.obligations and after.measured == before.measured
    assert after.environment == before.environment and after.consumed_results == before.consumed_results
    assert runtime.provider.calls == 1

    assert after.execution_status is ExecutionStatus.SUSPENDED


def test_in_process_upstream_gate_retains_actual_request_and_denies_second(runtime: RuntimeFixture) -> None:
    runtime.provider.harness = True
    runtime.provider.extra_request = True
    accept_effect(runtime)
    with pytest.raises(VerificationError, match="single upstream"):
        runtime.supervisor.drive()
    assert runtime.provider.calls == 1
    state = runtime.reader.verify()
    effect = state.effects[0]
    assert effect.authorization.dispatch_stage is DispatchStage.UPSTREAM_FORWARD
    assert effect.authorization.actual_provider_request_reference is not None
    assert runtime.store.objects.read(effect.authorization.actual_provider_request_reference) == b"approved-wire-request"
    assert state.execution_status is ExecutionStatus.SUSPENDED
    runtime.restart().recover()
    assert runtime.provider.calls == 1


def test_all_authority_passes_replay_and_full_step_output_is_retained(runtime: RuntimeFixture) -> None:
    output = StepOutput(runtime.command(), b"private", (Annotation("candidate.claim", b'{"cost":0}'),))
    runtime.supervisor.accept(output, expected_head=runtime.supervisor.state.head)
    runtime.supervisor.drive()
    consume(runtime)
    state = runtime.reader.verify()
    assert state == runtime.supervisor.state
    assert decode(runtime.store.objects.read(runtime.store.objects.publish(encode(output)))) == output
    assert sum(isinstance(r.payload, ContinuationCommit) and r.payload.consumed_result_cursor is not None for r in state.records) == 1
    assert sum(isinstance(r.payload, EffectObservationSettlement) for r in state.records) == 3


@pytest.mark.parametrize("boundary", [Boundary.UPSTREAM_AUTHORIZED, Boundary.EXTERNAL_RETURN, Boundary.RETURN_RECORDED, Boundary.SETTLED])
def test_upstream_stage_crash_recovery(runtime: RuntimeFixture, boundary: Boundary) -> None:
    runtime.provider.harness = True
    arm(runtime, boundary)
    with pytest.raises(Crash):
        accept_effect(runtime)
        runtime.supervisor.drive()
    runtime.restart().recover()
    effect = runtime.supervisor.state.effects[0]
    assert effect.authorization.actual_provider_request_reference is not None
    assert runtime.store.objects.read(effect.authorization.actual_provider_request_reference) == b"approved-wire-request"
    if boundary is Boundary.UPSTREAM_AUTHORIZED:
        assert runtime.provider.calls == 0
        assert effect.state is EffectState.UNCERTAIN
        assert effect.obligations
    else:
        consume(runtime)
        assert runtime.provider.calls == 1 and len(runtime.supervisor.state.consumed_results) == 1


def test_durable_request_and_reservation_exist_inside_dispatch(runtime: RuntimeFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    original = runtime.provider.invoke
    from strive.vnext.runtime import DispatchContext, Receipt

    def invoke(context: DispatchContext, request: EffectRequest) -> Receipt:
        state = runtime.reader.verify()
        effect = state.effect(context.authorization.effect_id)
        assert effect.authorization.execution_epoch == runtime.writer.epoch
        assert runtime.store.objects.read(effect.authorization.exact_request_reference) == request.to_bytes()
        assert effect.obligations == runtime.provider.bound and not effect.measured
        with pytest.raises(VerificationError, match="already executing"):
            runtime.supervisor.drive()
        return original(context, request)

    monkeypatch.setattr(runtime.provider, "invoke", invoke)
    accept_effect(runtime)
    runtime.supervisor.drive()
    assert runtime.provider.calls == 1


@pytest.mark.parametrize("resource, amount", [(Resource.MODEL_CALLS, 11), (Resource.USD_NANODOLLARS, 10**15),
                                               (Resource.WALL_MILLISECONDS, 10**12), (Resource.OUTPUT_TOKENS, 1001)])
def test_every_limited_resource_is_admitted_before_dispatch(runtime: RuntimeFixture, resource: Resource, amount: int) -> None:
    runtime.provider.bound = (ResourceQuantity(resource, amount),)
    with pytest.raises(VerificationError, match="budget"):
        accept_effect(runtime)
    assert runtime.provider.calls == 0 and not runtime.supervisor.state.effects


def test_same_component_partial_measurement_replaces_reservation(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = ()
    accept_effect(runtime)
    runtime.supervisor.drive()
    consume(runtime)
    effect = runtime.supervisor.state.effects[0]
    receipt = replace(runtime.provider.receipts[effect.authorization.effect_id],
                      measured=(ResourceQuantity(Resource.INPUT_TOKENS, 30), ResourceQuantity(Resource.MODEL_CALLS, 1)),
                      remaining=(ResourceQuantity(Resource.INPUT_TOKENS, 70),))
    runtime.supervisor.late_receipt(effect.authorization.effect_id, receipt)
    state = runtime.supervisor.state
    assert amounts(state.measured)[Resource.INPUT_TOKENS] == 30
    assert amounts(state.obligations)[Resource.INPUT_TOKENS] == 70
    runtime.supervisor.late_receipt(effect.authorization.effect_id,
                                   replace(receipt, measured=(ResourceQuantity(Resource.INPUT_TOKENS, 50),), remaining=()))
    state = runtime.supervisor.state
    assert amounts(state.measured)[Resource.INPUT_TOKENS] == 50 and not state.obligations


def test_overrun_at_settlement_crash_is_still_stopped_on_recovery(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = (ResourceQuantity(Resource.INPUT_TOKENS, 110), ResourceQuantity(Resource.MODEL_CALLS, 1))
    arm(runtime, Boundary.SETTLED)
    with pytest.raises(Crash):
        accept_effect(runtime)
        runtime.supervisor.drive()
    runtime.restart().recover()
    assert runtime.supervisor.state.dispatch_stopped
    assert runtime.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
    assert runtime.provider.calls == 1


def test_late_overrun_keeps_finished_execution_closed(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = ()
    accept_effect(runtime)
    runtime.supervisor.drive()
    consume(runtime, finish=True)
    effect = runtime.supervisor.state.effects[0]
    receipt = replace(runtime.provider.receipts[effect.authorization.effect_id],
                      measured=(ResourceQuantity(Resource.INPUT_TOKENS, 120), ResourceQuantity(Resource.MODEL_CALLS, 1)))
    runtime.supervisor.late_receipt(effect.authorization.effect_id, receipt)
    assert runtime.supervisor.state.dispatch_stopped
    assert runtime.supervisor.state.execution_status is ExecutionStatus.FINISHED
    assert len(runtime.supervisor.state.consumed_results) == 1


def test_late_overrun_preserves_accepted_command_without_dispatch(runtime: RuntimeFixture) -> None:
    runtime.provider.measured = ()
    accept_effect(runtime)
    runtime.supervisor.drive()
    accept_effect(runtime)  # Consume the known result and retain the next command.
    pending = runtime.supervisor.state.pending_command
    effect = runtime.supervisor.state.effects[0]
    receipt = replace(runtime.provider.receipts[effect.authorization.effect_id],
                      measured=(ResourceQuantity(Resource.INPUT_TOKENS, 120), ResourceQuantity(Resource.MODEL_CALLS, 1)))
    runtime.supervisor.late_receipt(effect.authorization.effect_id, receipt)
    assert runtime.supervisor.state.dispatch_stopped
    assert runtime.supervisor.state.pending_command == pending
    runtime.restart().recover()
    assert runtime.supervisor.state.pending_command == pending
    assert runtime.provider.calls == 1
    with pytest.raises(VerificationError, match="dispatch stopped"):
        runtime.supervisor.drive()
