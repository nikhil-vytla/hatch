from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from strive.vnext.benchmarks.api import FoundOperation, OperationReceipt, ProvenAbsent, ScoringInput, UnknownOperation
from strive.vnext.benchmarks.json_data import canonical, obj, parse
from strive.vnext.benchmarks.payloads import dumps, loads
from strive.vnext.codec import encode
from strive.vnext.contracts.commands import ApplyChange, Finish, RestoreBundle, StepOutput
from strive.vnext.contracts.lifecycle import EffectState, RecoveryCapability, RecoveryContract
from strive.vnext.contracts.primitives import EffectId, EpisodeId, ExecutionStatus, Resource, ScopedArtifact
from strive.vnext.contracts.records import CausalIdentity, Measurement, ProducerKind
from strive.vnext.errors import VerificationError
from strive.vnext.runtime import Boundary
from strive.vnext.runtime.ledger import amounts
from strive.vnext.runtime.admission import ValidatedArguments
from strive.vnext.benchmarks.store import OperationStore

from .benchmark_fixtures import BenchmarkFixture, action_matches
from .test_runtime import Crash


def recovery_probe(root: Path, requestor: str) -> None:
    fixture = BenchmarkFixture(root)
    try:
        fixture.initialize()
        state = fixture.supervisor.state
        assert state.active_revision is not None
        fixture.supervisor.accept(StepOutput(ApplyChange(fixture.pin, state.active_revision), b"changed bundle"), expected_head=state.head)
        fixture.supervisor.drive()
        def fault(boundary: Boundary) -> None:
            if boundary is Boundary.EXTERNAL_RETURN:
                raise Crash()
        fixture.supervisor.fault = fault
        with pytest.raises(Crash):
            fixture.tool(requestor)
        assert fixture.backend.calls[requestor + "_tool"] == 1
        fixture.restart()
        fixture.supervisor.recover()
        assert fixture.supervisor.state.effects[-1].state is EffectState.SETTLED
        fixture.driver.consume()
        fixture.supervisor.recover()
        assert fixture.backend.calls[requestor + "_tool"] == 1
        environment = fixture.supervisor.state.environment
        snapshot = fixture.operations.head(EpisodeId("episode"))
        assert snapshot is not None
        data = obj(parse(fixture.store.objects.read(snapshot.state)))
        assert obj(data["agent_db" if requestor == "agent" else "user_db"])["active" if requestor == "agent" else "enabled"] is True
        fixture.provider.recovery = RecoveryContract(frozenset({RecoveryCapability.SUSPEND}), False, False)
        fixture.supervisor.fault = fault
        with pytest.raises(Crash):
            fixture.model()
        fixture.restart()
        fixture.supervisor.recover()
        before = fixture.supervisor.state
        assert before.execution_status is ExecutionStatus.SUSPENDED
        assert amounts(before.obligations)[Resource.INPUT_TOKENS] > 0
        pending_effect = before.effects[-1]
        with pytest.raises(VerificationError):
            fixture.supervisor.accept(StepOutput(RestoreBundle(fixture.bundle, before.active_revision), b"forged"), expected_head=before.head)  # type: ignore[arg-type]
        with pytest.raises(VerificationError, match="migrate"):
            fixture.supervisor.restore(fixture.bundle, controller_state=fixture.pin)
        fixture.supervisor.restore(fixture.bundle)
        after = fixture.supervisor.state
        assert after.active_bundle == fixture.bundle and after.active_bundle != before.active_bundle
        assert after.execution_status is ExecutionStatus.SUSPENDED
        assert after.private_state == before.private_state
        assert after.effects == before.effects and after.effects[-1] == pending_effect
        assert after.measured == before.measured and after.obligations == before.obligations
        assert after.environment == before.environment == environment
        assert (after.pending_command, after.pending_command_id) == (before.pending_command, before.pending_command_id)
        assert after.consumed_results == before.consumed_results
        fixture.restart()
        fixture.supervisor.recover()
        fixture.supervisor.drive()
        assert fixture.provider.calls == 1 and fixture.provider.lookups == 0
        assert fixture.backend.calls[requestor + "_tool"] == 1
        assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
    finally:
        fixture.close()


@pytest.mark.parametrize("requestor", ["agent", "user"])
def test_real_mutation_reconcile_and_operator_restore(tmp_path: Path, requestor: str) -> None:
    recovery_probe(tmp_path, requestor)


def test_forged_facts_guarantee_2(tmp_path: Path) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        fixture.terminate()
        state = fixture.supervisor.state
        fixture.supervisor.accept(StepOutput(Finish('success=true; reward=1; counterfeit tool result'), b'{"success":true}'), expected_head=state.head)
        forged = Measurement(fixture.scope.run_id, fixture.pin, (), fixture.pin, fixture.adapter.scorer.identity,
            (), (), ("0",), ("0",), ("0",), (), fixture.pin, Decimal(1), None, None, None, None, None,
            fixture.task.reward_definition)
        with pytest.raises(VerificationError, match="owner|producer|permitted"):
            fixture.writer.port(ProducerKind.CANDIDATE).append(forged, causal=CausalIdentity(None, None, None, None), epoch=fixture.writer.epoch)
        reward = fixture.driver.score()
        assert reward.status == "scored" and reward.metrics[0].value == 0
        assert fixture.reader.verify().measurements[-1].metric_value == 0
    finally:
        fixture.close()


@pytest.mark.parametrize("point", ["before-commit", "after-commit"])
def test_transaction_crash_and_verified_lookup(tmp_path: Path, point: str) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        before = fixture.operations.head(EpisodeId("episode"))
        def crash(actual: str) -> None:
            if actual == point:
                raise Crash()
        fixture.operations.fault = crash
        with pytest.raises(Crash):
            fixture.tool("agent")
        auth = fixture.supervisor.state.effects[-1].authorization
        fixture.restart()
        found = fixture.adapter.lookup_operation(EpisodeId("episode"), auth.effect_id, auth.exact_request_reference)
        if point == "before-commit":
            assert isinstance(found, ProvenAbsent)
            assert fixture.operations.head(EpisodeId("episode")) == before
        else:
            assert isinstance(found, FoundOperation)
            assert found.receipt.after != before
            assert isinstance(fixture.adapter.lookup_operation(EpisodeId("wrong"), auth.effect_id, auth.exact_request_reference), UnknownOperation)
            assert isinstance(fixture.adapter.lookup_operation(EpisodeId("episode"), auth.effect_id, fixture.pin), UnknownOperation)
        fixture.supervisor.recover()
        assert fixture.backend.calls["agent_tool"] == 1
    finally:
        fixture.close()


def test_store_dedup_fencing_corruption_and_no_rewind(tmp_path: Path) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        fixture.tool("agent")
        receipts = fixture.driver.receipts()
        original = receipts[-1][1]
        auth = fixture.supervisor.state.effects[-1].authorization
        from strive.vnext.benchmarks.api import OperationContext
        context = OperationContext(auth, original.after.episode, original.arguments, original.before)
        assert fixture.operations.commit(context, lambda state: (_ for _ in ()).throw(AssertionError("duplicate mutation"))) == original
        with pytest.raises(VerificationError, match="context"):
            fixture.operations.commit(replace(context, arguments=fixture.pin), lambda state: (b"", b""))
        assert original.before is not None
        with pytest.raises(VerificationError, match="rewind"):
            fixture.operations.open(original.before)
        newer = OperationStore(tmp_path / "operations", fixture.store.objects, fixture.scope.run_id, fixture.adapter_pin, fixture.writer.epoch + 1)
        with pytest.raises(VerificationError, match="epoch"):
            fixture.operations.commit(context, lambda state: (b"", b""))
        newer.close()
        fixture.operations.epoch += 1
        fixture.store.objects.path(original.after.state).unlink()
        assert isinstance(fixture.operations.lookup(original.after.episode, original.effect_id, original.exact_request), UnknownOperation)
    finally:
        fixture.close()


@pytest.mark.parametrize("solved,reason,expected", [(False, "agent_stop", 0), (True, "agent_stop", 1), (True, "budget_exhausted", 0), (True, "max_steps", 0)])
def test_state_supported_scoring(tmp_path: Path, solved: bool, reason: str, expected: int) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        fixture.tool("agent", "mutate_then_error")
        fixture.driver.consume()
        if solved:
            fixture.tool("user")
            fixture.driver.consume()
        fixture.terminate(reason)
        reward = fixture.driver.score()
        assert reward.metrics[0].value == expected
        assert len(fixture.reader.verify().measurements) == 1
    finally:
        fixture.close()


@pytest.mark.parametrize("expected,actual,compare,match", [({"x": 1}, {}, None, True), ({"x": 1}, {"x": 2}, [], True),
    ({"x": 1, "y": 2}, {"x": 1}, None, True), ({"x": 1}, {"x": 2}, None, False), ({}, {}, ["x"], True)])
def test_action_comparator_quirks(expected: dict[str, int], actual: dict[str, int], compare: list[str] | None, match: bool) -> None:
    assert action_matches({"name": "transfer", "arguments": expected, "compare_args": compare, "requestor": "assistant"},
                          {"name": "transfer", "arguments": actual, "requestor": "user"}) is match


def test_dynamic_admission_rejects_forged_scopes_and_protected_reads(tmp_path: Path) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        operation = fixture.operation("snapshot")
        arguments = fixture.store.objects.publish(operation.to_bytes())
        from strive.vnext.runtime.broker import EffectRequest
        from strive.vnext.contracts.commands import ExecuteEffect
        ref = fixture.store.objects.publish(EffectRequest("local://telecom", arguments, fixture.scope).to_bytes())
        command = ExecuteEffect("benchmark.snapshot", "benchmark", ref)
        with pytest.raises(VerificationError, match="provenance"):
            fixture.broker.prepare(fixture.supervisor.state, command)
        assert not fixture.broker.permits_input(fixture.supervisor.state, ScopedArtifact(fixture.task.definition, fixture.scope))
        fixture.driver.perform(operation)
        assert fixture.supervisor.state.effects[-1].authorization.exact_request_reference == ref
        fixture.driver.consume()
        with pytest.raises(VerificationError, match="provenance|current"):
            fixture.broker.prepare(fixture.supervisor.state, command)
        assert ValidatedArguments(fixture.pin).references == ()
    finally:
        fixture.close()


def test_user_batch_restart_uses_captured_generation_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.vnext.benchmarks.api import CapturedGeneration
    from strive.vnext.contracts.harness import GenerationInput
    from strive.vnext.contracts.primitives import ModelRole, ScopedArtifact
    from strive.vnext.runtime.broker import PreparedEffect, EffectRequest, Receipt
    from strive.vnext.contracts.commands import ExecuteEffect
    from strive.vnext.contracts.records import EffectAuthorization
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        message = fixture.store.objects.publish(canonical({"content": "hello"}))
        fixture.driver.perform(fixture.operation("deliver_message", (message,)))
        fixture.driver.consume()
        snapshot = fixture.operations.head(EpisodeId("episode"))
        assert snapshot is not None
        plan = fixture.adapter.plan_user_turn(snapshot, message)
        assert plan is not None and plan.generation_input == fixture.model_plan
        state = fixture.supervisor.state
        assert state.binding is not None
        generation = GenerationInput(ModelRole.USER, (ScopedArtifact(fixture.model_plan, fixture.scope),),
            state.binding.model_bindings[0].binding, fixture.pin, fixture.pin, ())
        envelope = fixture.store.objects.publish(encode(("fixture-user-generation", generation)))
        original_prepare = fixture.provider.prepare
        def prepare(command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
            return replace(original_prepare(command, request), generation=envelope)
        original_perform = fixture.provider._perform
        def perform(auth: EffectAuthorization, request: EffectRequest) -> Receipt:
            receipt = original_perform(auth, request)
            return replace(receipt, output=canonical({"role": "assistant", "tool_calls": [
                {"id": "one", "name": "enable", "arguments": {}}, {"id": "two", "name": "enable", "arguments": {}}]}))
        monkeypatch.setattr(fixture.provider, "prepare", prepare)
        monkeypatch.setattr(fixture.provider, "_perform", perform)
        fixture.model(user=True)
        effect = fixture.supervisor.state.effects[-1]
        assert effect.result is not None and effect.response is not None
        capture = CapturedGeneration(effect.result, plan.generation_input, effect.response)
        fixture.driver.consume()
        with pytest.raises(VerificationError, match="capture"):
            fixture.driver.perform(fixture.operation("user_turn", (plan, replace(capture, response=fixture.pin))))
        fixture.driver.perform(fixture.operation("user_turn", (plan, capture)))
        fixture.driver.consume()
        def crash(point: str) -> None:
            if point == "after-commit":
                raise Crash()
        fixture.operations.fault = crash
        with pytest.raises(Crash):
            fixture.driver.drain_user_tools()
        fixture.restart()
        fixture.driver.drain_user_tools()
        assert fixture.backend.calls["user_turn"] == 1
        assert fixture.backend.calls["user_tool"] == 2
        assert fixture.provider.calls == 1
        fixture.driver.drain_user_tools()
        assert fixture.backend.calls["user_tool"] == 2
    finally:
        fixture.close()


def test_committed_replayed_state_divergence_is_invalid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        original = fixture.backend.call
        def divergent(operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]:
            data, output = original(operation, state, payload)
            if operation == "snapshot":
                value = obj(parse(data)); value["user_db"] = {"enabled": True}
                data = canonical(value)
            return data, output
        monkeypatch.setattr(fixture.backend, "call", divergent)
        fixture.driver.perform(fixture.operation("snapshot"))
        fixture.driver.consume()
        fixture.terminate()
        result = fixture.driver.score()
        assert result.status == "invalid" and result.metrics == ()
        assert not fixture.reader.verify().measurements
    finally:
        fixture.close()


@pytest.mark.parametrize("basis,communication,actions,expected", [
    (["COMMUNICATE"], "You have 1,000 MB", [], 1),
    (["COMMUNICATE"], "You have 999 MB", [], 0),
    (["ACTION"], "", [{"name": "transfer", "arguments": {"ignored": 1}, "compare_args": []}], 1),
    (["ACTION"], "", [{"name": "wrong", "arguments": {}, "compare_args": []}], 0),
    (["DB"], "", [], 1),
])
def test_synthetic_reward_components_preserve_upstream_rules(tmp_path: Path, basis: list[str], communication: str,
                                                           actions: list[dict[str, object]], expected: int) -> None:
    # Clearly synthetic contract fixtures. Live evaluator equivalence remains
    # a separate skipped check until the pinned upstream environment installs.
    fixture = BenchmarkFixture(tmp_path)
    try:
        criteria = {"reward_basis": basis, "actions": actions, "communicate_info": ["1000 mb"]}
        task = {"evaluation_criteria": criteria}
        payload = canonical({"task": task, "identities": {}})
        state, _ = fixture.backend.call("initialize", None, payload)
        state, _ = fixture.backend.call("agent_tool", state, canonical({"id": "a", "name": "transfer", "arguments": {}, "requestor": "assistant"}))
        state, _ = fixture.backend.call("user_tool", state, canonical({"id": "b", "name": "different_path", "arguments": {}, "requestor": "user"}))
        state, _ = fixture.backend.call("deliver_message", state, canonical({"content": communication}))
        state, _ = fixture.backend.call("terminate", state, canonical("agent_stop"))
        _, result = fixture.backend.call("score", state, canonical({"task": task, "termination": "agent_stop"}))
        assert obj(parse(result))["value"] == expected
    finally:
        fixture.close()


def test_corrupt_receipt_and_missing_store_cannot_prove_absence(tmp_path: Path) -> None:
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        ref, receipt = fixture.driver.receipts()[0]
        # Corrupt the adapter's retained receipt, not a candidate-provided log.
        fixture.store.objects.path(ref).write_bytes(b"counterfeit receipt")
        assert isinstance(fixture.operations.lookup(receipt.after.episode, receipt.effect_id, receipt.exact_request), UnknownOperation)
        assert isinstance(fixture.operations.lookup(receipt.after.episode, EffectId("missing-effect"), receipt.exact_request), UnknownOperation)
        with pytest.raises(VerificationError, match="unavailable"):
            OperationStore(tmp_path / "missing", fixture.store.objects, fixture.scope.run_id, fixture.adapter_pin, fixture.writer.epoch)
    finally:
        fixture.close()


@pytest.mark.parametrize("change", ["destination", "operation", "scope", "schema", "bound"])
def test_scoped_admission_checks_every_request_dimension(tmp_path: Path, change: str) -> None:
    from strive.vnext.contracts.commands import ExecuteEffect
    from strive.vnext.contracts.primitives import LineageId, ResourceQuantity
    from strive.vnext.runtime.broker import EffectRequest
    fixture = BenchmarkFixture(tmp_path)
    try:
        fixture.initialize()
        current = fixture.supervisor.state.environment
        assert current is not None
        data = fixture.operation("snapshot").to_bytes() if change != "schema" else b"not a benchmark request"
        arguments = fixture.provenance.publish(data, fixture.scope, fixture.pin, current)
        request = EffectRequest("wrong://destination" if change == "destination" else "local://telecom", arguments,
            replace(fixture.scope, lineage_id=LineageId("protected")) if change == "scope" else fixture.scope)
        command = ExecuteEffect("benchmark.user_tool" if change == "operation" else "benchmark.snapshot", "benchmark",
                                fixture.store.objects.publish(request.to_bytes()))
        if change == "bound":
            fixture.bridge.cost = (ResourceQuantity(Resource.MODEL_CALLS, 1),)
        with pytest.raises(VerificationError):
            fixture.broker.prepare(fixture.supervisor.state, command)
        assert len(fixture.supervisor.state.effects) == 1
    finally:
        fixture.close()


def test_task_reward_bytes_cannot_drift_from_qualified_inventory(tmp_path: Path) -> None:
    from strive_benchmark_tau2.adapter import Tau2Adapter
    fixture = BenchmarkFixture(tmp_path)
    try:
        tasks = (replace(fixture.task, reward_definition=fixture.pin), *fixture.adapter.tasks[1:])
        with pytest.raises(VerificationError, match="qualified source"):
            Tau2Adapter(fixture.store.objects, fixture.backend, tasks, fixture.adapter.qualification, fixture.pin, fixture.operations)
    finally:
        fixture.close()
