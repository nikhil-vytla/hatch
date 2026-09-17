"""Run real process launches and durable gateway recovery behind M1's driver."""
from dataclasses import replace
from decimal import Decimal

from strive.contracts.commands import Finish
from strive.contracts.lifecycle import EffectState
from strive.contracts.primitives import ExecutionStatus
from strive.runtime import Boundary
from strive.runtime.confined_sandbox import DenoSandbox

from .harness_support import HarnessFixture, ProcessCrash
from .test_acceptance_contracts import RuntimeEvidence, StorageRuntimeDriver
from .test_runtime_sandbox import RETURN_FINISH, view


class HarnessRuntimeDriver(StorageRuntimeDriver):
    @staticmethod
    def evidence() -> RuntimeEvidence:
        return RuntimeEvidence(False, False, False, False, False, 0, 0, Decimal(0), Decimal(0), False, False, False)

    def exercise(self, scenario: str) -> RuntimeEvidence:
        if scenario == "candidate_and_harness_attempt_credentials_network_storage_and_tool_access":
            from .test_linux_jail import assert_native_denials, require_jail
            require_jail()
            assert_native_denials(self.root / "candidate-native")
            assert_native_denials(self.root / "harness-native")
            return self.exercise("candidate_and_fixture_harness_enforced_permissions")
        if scenario == "candidate_and_fixture_harness_enforced_permissions":
            sandbox = DenoSandbox(self.root / "candidate")
            source = '''async function step() {
                for (const operation of [() => Deno.env.get("API_KEY"), () => Deno.readTextFile("/etc/passwd"),
                     () => fetch("http://192.0.2.1"), () => new Deno.Command("/usr/bin/true").output()]) {
                    let denied = false;
                    try { await operation(); } catch(e) { denied = String(e).includes("NotCapable") || String(e).includes("Requires"); }
                    if (!denied) throw Error("escape succeeded");
                }
            ''' + RETURN_FINISH + "}"
            assert isinstance(sandbox.run(source.encode(), view(), b"", None, {}).command, Finish)
            fixture = HarnessFixture(self.root / "harness", mode="escape")
            try:
                fixture.run()
                assert fixture.supervisor.state.effects[0].response is not None
                assert len(fixture.upstream.requests) == 1
                if sandbox.profile().production_floor:
                    context = fixture.bridge._context(fixture.supervisor.state.effects[0].authorization)
                    assert fixture.gateway.events(context, "os-jail")
                    assert fixture.gateway.events(context, "os-jail-exit")
                    assert "memory.events.oom_kill" in sandbox.jail_events
            finally:
                fixture.close()
            return replace(self.evidence(), candidate_escape_denied=True, harness_escape_denied=True)
        if scenario != "crash_before_and_after_launch_forward_return_settlement_and_continuation":
            return super().exercise(scenario)
        # Each successful generation consumes exactly once; genuinely ambiguous
        # pre-outcome generations suspend with zero consumption. No re-dispatch.
        consumptions: list[int] = []
        for point in ("authorized", "dispatch", "launch-retained", "process-started", "upstream-before-send", "upstream-return-before-spool",
                      "response-spooled", "harness-return-recorded", "return_recorded", "settled", "continuation"):
            fixture = HarnessFixture(self.root / point)
            def crash(actual: str) -> None:
                if actual == point:
                    raise ProcessCrash(point)
            try:
                if point in {"authorized", "dispatch", "return_recorded", "settled"}:
                    fixture.supervisor.fault = lambda actual: crash(str(actual))
                elif point != "continuation":
                    fixture.gateway.fault = crash
                try:
                    fixture.run()
                    if point == "continuation":
                        fixture.supervisor.fault = lambda actual: crash(str(actual))
                        fixture.consume()
                except ProcessCrash:
                    pass
                else:
                    raise AssertionError("crash injection did not fire")
                state = fixture.reader.verify()
                effect = state.effects[0]
                assert fixture.store.objects.read(effect.authorization.exact_request_reference)
                assert effect.authorization.generation_envelope is not None
                assert fixture.store.objects.read(effect.authorization.generation_envelope)
                context = fixture.bridge._context(effect.authorization)
                if point not in {"authorized", "dispatch"}:
                    assert fixture.gateway.events(context, "launch")
                calls = len(fixture.upstream.requests)
                spool = fixture.gateway.read(context)
                if point not in {"authorized", "dispatch"}:
                    assert spool is not None
                if calls:
                    assert spool is not None
                    assert spool.wire is not None and fixture.store.objects.read(spool.wire) == fixture.upstream.requests[0]
                    assert effect.authorization.actual_provider_request_reference == spool.wire
                fixture.restart()
                fixture.execution.recover()
                if fixture.supervisor.state.effects[0].state is EffectState.SETTLED:
                    fixture.consume()
                fixture.restart()
                fixture.execution.recover()
                assert len(fixture.upstream.requests) == calls
                count = len(fixture.supervisor.state.consumed_results)
                if point == "upstream-before-send":
                    assert fixture.supervisor.state.execution_status is ExecutionStatus.SUSPENDED
                    assert fixture.supervisor.state.obligations and count == 0
                else:
                    assert count == 1
                consumptions.append(count)
            finally:
                fixture.close()
        return replace(self.evidence(), request_retained_before_dispatch=True, result_consumptions=max(consumptions))
