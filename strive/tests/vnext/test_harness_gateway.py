"""Gateway admission and recovery checks without any external network."""
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
from pathlib import Path
from typing import Iterator

import pytest

from strive.vnext.codec import decode, encode
from strive.vnext.contracts.harness import ExecutionContext, PreparedGeneration, Unsupported
from strive.vnext.contracts.primitives import EffectId, InvocationId
from strive.vnext.errors import VerificationError
from strive.vnext.harness.gateway import ModelGateway
from strive.vnext.harness.http_gateway import GatewayHTTPServer
from strive.vnext.runtime import Boundary

from .harness_support import HarnessFixture, ProcessCrash


@pytest.fixture
def fixture(tmp_path: Path) -> Iterator[HarnessFixture]:
    value = HarnessFixture(tmp_path)
    try:
        yield value
    finally:
        value.close()


def prepare(fixture: HarnessFixture) -> PreparedGeneration:
    context = ExecutionContext(fixture.scope.run_id, InvocationId("gateway-test"), EffectId("gateway-test"),
                               fixture.bundle, fixture.writer.epoch, fixture.scope)
    prepared = fixture.adapter.prepare(fixture.model, fixture.generation, context)
    assert isinstance(prepared, PreparedGeneration)
    return prepared


def request(fixture: HarnessFixture) -> bytes:
    return json.dumps({"model": fixture.model.model, "input": "context", "max_output_tokens": 64}).encode()


def forward(raw: bytes, send: Callable[[bytes], bytes]) -> bytes:
    return send(raw)


def test_capability_stale_epoch_expiry_and_revocation(fixture: HarnessFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    stale = replace(prepared.execution_context, epoch=prepared.execution_context.epoch + 1)
    with pytest.raises(VerificationError, match="stale"):
        fixture.gateway.dispatch(stale, token, request(fixture), forward)
    with pytest.raises(VerificationError, match="stale"):
        fixture.gateway.dispatch(prepared.execution_context, "wrong-token", request(fixture), forward)
    monkeypatch.setattr("strive.vnext.harness.gateway.time.time", lambda: 10**12)
    with pytest.raises(VerificationError, match="expired"):
        fixture.gateway.dispatch(prepared.execution_context, token, request(fixture), forward)
    fixture.gateway.revoke(prepared.execution_context)
    assert not fixture.upstream.requests


def test_atomic_single_dispatch_across_gateway_connections(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    other = ModelGateway(fixture.root / "gateway", fixture.store.objects, fixture.contract, fixture.upstream)
    def attempt(gateway: ModelGateway) -> bool:
        try:
            gateway.dispatch(prepared.execution_context, token, request(fixture), forward)
        except VerificationError:
            return False
        return True
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, (fixture.gateway, other)))
        assert sorted(results) == [False, True]
        assert len(fixture.upstream.requests) == 1
        state = other.read(prepared.execution_context)
        assert state is not None and state.wire is not None and state.response is not None
        assert fixture.store.objects.read(state.response) == fixture.upstream.response
        assert fixture.store.objects.read(state.wire) == request(fixture)
    finally:
        other.close()


def test_no_dispatch_proof_revokes_and_is_repeatable(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    proof = fixture.gateway.prove_no_dispatch(prepared.execution_context)
    assert proof is not None
    assert fixture.gateway.prove_no_dispatch(prepared.execution_context) == proof
    with pytest.raises(VerificationError):
        fixture.gateway.dispatch(prepared.execution_context, token, request(fixture), forward)
    with pytest.raises(VerificationError, match="already"):
        fixture.gateway.issue(prepared)
    assert not fixture.upstream.requests


def test_denied_request_burns_capability_before_replacement(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    raw = b'{"model":"wrong","input":"x","max_output_tokens":64}'
    with pytest.raises(VerificationError, match="unapproved"):
        fixture.gateway.dispatch(prepared.execution_context, token, raw, forward)
    with pytest.raises(VerificationError, match="revoked"):
        fixture.gateway.dispatch(prepared.execution_context, token, request(fixture), forward)
    assert not fixture.upstream.requests


@pytest.mark.parametrize("raw", [b'{"model":"a","model":"b"}', b'{"model":NaN}', b'[]', b'{"model":"recorded-model","max_output_tokens":true,"input":"text"}', b'{"model":"recorded-model","max_output_tokens":64,"input":[{"role":"user","content":[{"type":"input_image","image_url":"https://example.com"}]}]}'])
def test_strict_wire_protocol(fixture: HarnessFixture, raw: bytes) -> None:
    with pytest.raises(VerificationError):
        fixture.contract.validate(raw)
    assert not fixture.upstream.requests


def test_prepare_rejects_unbounded_profile_settings_and_scope(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    changed = replace(fixture.model, max_output_tokens=65)
    assert isinstance(fixture.adapter.prepare(changed, replace(fixture.generation, requested_model_binding=changed),
                                              prepared.execution_context), Unsupported)
    with pytest.raises(ValueError, match="bound"):
        replace(fixture.contract, inclusive_reasoning_bound=False)
    bad_settings = fixture.store.objects.publish(b'{"service_tier":"priority"}')
    generation = replace(fixture.generation, generation_settings=bad_settings)
    assert isinstance(fixture.adapter.prepare(fixture.model, generation, prepared.execution_context), Unsupported)
    scope = replace(fixture.scope, grant=fixture.input_ref)
    assert isinstance(fixture.adapter.prepare(fixture.model, fixture.generation,
                      replace(prepared.execution_context, evidence_scope=scope)), Unsupported)
    with pytest.raises(ValueError, match="one request"):
        replace(fixture.harness_binding, max_provider_requests=2)  # type: ignore[arg-type]


def test_request_and_response_evidence_distinguishes_context(fixture: HarnessFixture) -> None:
    fixture.run()
    effect = fixture.supervisor.state.effects[0]
    context = fixture.bridge._context(effect.authorization)
    state = fixture.gateway.read(context)
    assert state is not None and state.response is not None and state.wire is not None
    prepared = decode(fixture.store.objects.read(state.prepared))
    assert isinstance(prepared, PreparedGeneration)
    assert prepared.input_bytes == b"authorized user context"
    wire = fixture.store.objects.read(state.wire)
    assert b"Fixture harness added context" in wire
    assert wire != prepared.input_bytes
    assert effect.authorization.actual_provider_request_reference == state.wire
    assert fixture.gateway.events(context, "identity")


def test_stale_receipt_and_duplicate_settlement_cannot_consume_again(fixture: HarnessFixture) -> None:
    fixture.run()
    effect = fixture.supervisor.state.effects[0]
    receipt = fixture.bridge.reconcile(effect.authorization, fixture.writer.epoch)
    assert receipt is not None
    fixture.consume()
    with pytest.raises(VerificationError, match="duplicate settlement"):
        fixture.supervisor.late_receipt(effect.authorization.effect_id, receipt)
    fixture.restart()
    with pytest.raises(VerificationError, match="stale"):
        fixture.supervisor.late_receipt(effect.authorization.effect_id, receipt)
    assert len(fixture.supervisor.state.consumed_results) == 1
    assert len(fixture.upstream.requests) == 1


def test_no_launch_restart_requires_new_epoch_and_effect(fixture: HarnessFixture) -> None:
    def crash(boundary: Boundary) -> None:
        if boundary is Boundary.AUTHORIZED:
            raise ProcessCrash()
    fixture.supervisor.fault = crash
    with pytest.raises(ProcessCrash):
        fixture.run()
    old = fixture.supervisor.state.effects[0].authorization
    fixture.restart()
    fixture.execution.recover()
    assert not fixture.upstream.requests
    fixture.consume()
    fixture.run()
    new = fixture.supervisor.state.effects[-1].authorization
    assert old.effect_id != new.effect_id and old.execution_epoch < new.execution_epoch
    assert len(fixture.upstream.requests) == 1


def test_native_admission_fails_before_process_or_capability(fixture: HarnessFixture) -> None:
    from strive.vnext.harness.process import ProcessServices
    profile = replace(fixture.profile, fixture_script=None)
    services = ProcessServices(fixture.gateway, profile, fixture.root / "scratch", forward)
    try:
        with pytest.raises(VerificationError, match="OS process-tree jail"):
            services.launch_confined(prepare(fixture))
        assert fixture.gateway.read(prepare(fixture).execution_context) is None
    finally:
        services.close()


def test_http_gateway_local_transport_when_socket_bind_permitted(fixture: HarnessFixture) -> None:
    import http.client
    from threading import Thread
    from urllib.parse import urlsplit
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    try:
        server = GatewayHTTPServer(fixture.gateway, prepared.execution_context, forward)
    except PermissionError as error:
        pytest.skip(f"host denies localhost TCP bind: {error}; pipe gateway is exercised by real-process tests")
    worker = Thread(target=server.serve_one)
    worker.start()
    route = urlsplit(server.url)
    connection = http.client.HTTPConnection(route.hostname or "", route.port, timeout=10)
    try:
        connection.request("POST", route.path, request(fixture), {"Authorization": "Bearer " + token})
        response = connection.getresponse()
        assert response.status == 200 and response.read() == fixture.upstream.response
    finally:
        connection.close()
        worker.join(timeout=12)
        server.close()


def test_harness_history_replays_in_fresh_pure_interpreter(fixture: HarnessFixture) -> None:
    import subprocess
    import sys
    fixture.run()
    fixture.consume()
    program = r'''
import sys, os, importlib.abc
from pathlib import Path
sys.path.insert(0, sys.argv[1])
class Guard(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(("strive.vnext.harness", "strive.vnext.runtime", "subprocess", "socket", "openai", "anthropic")):
            raise AssertionError("forbidden runtime import: " + fullname)
sys.meta_path.insert(0, Guard())
def audit(event, args):
    if event.startswith(("subprocess.", "socket.")):
        raise AssertionError(event)
    if event == "open" and isinstance(args[2], int) and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        raise AssertionError("write")
sys.addaudithook(audit)
from strive.vnext.store import RunReader
from strive.vnext.contracts.primitives import RunId
state = RunReader(Path(sys.argv[2]), RunId("runtime")).verify()
assert len(state.consumed_results) == 1
assert not any(name.startswith(("strive.vnext.harness", "strive.vnext.runtime")) for name in sys.modules)
print("PURE_HARNESS_REPLAY")
'''
    result = subprocess.run([sys.executable, "-I", "-B", "-c", program,
        str(Path(__file__).resolve().parents[2] / "src"), str(fixture.root)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "PURE_HARNESS_REPLAY"


def test_http_provider_owns_credentials_fixed_route_and_never_retries(fixture: HarnessFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.vnext.harness.provider import HTTPProvider
    calls: list[tuple[str, str, bytes, dict[str, str]]] = []
    class Response:
        status = 200
        def read(self, maximum: int) -> bytes:
            return fixture.upstream.response
    class Connection:
        def __init__(self, host: str, port: int | None, timeout: int) -> None:
            assert host == "127.0.0.1" and port == 1
        def request(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> None:
            calls.append((method, path, body, headers))
        def getresponse(self) -> Response:
            return Response()
        def close(self) -> None:
            pass
    monkeypatch.setattr("strive.vnext.harness.provider.http.client.HTTPConnection", Connection)
    provider = HTTPProvider(fixture.contract, "gateway-only-secret", fixture.upstream.lookup)
    assert provider.generate(request(fixture), "operation") == fixture.upstream.response
    assert calls[0][3]["Authorization"] == "Bearer gateway-only-secret"
    assert calls[0][3]["X-Fixture-Operation"] == "operation"
    assert "gateway-only-secret" not in calls[0][2].decode()
    Response.status = 307
    with pytest.raises(VerificationError, match="no retry"):
        provider.generate(request(fixture), "another-operation")
    assert len(calls) == 2


def test_recovery_revokes_then_terminates_identified_old_process(fixture: HarnessFixture) -> None:
    import os
    from strive.vnext.harness.process import ProcessServices
    from strive.vnext.harness.process_identity import birth, terminate_recorded
    prepared = prepare(fixture)
    services = ProcessServices(fixture.gateway, fixture.profile, fixture.root / "scratch", forward, mode="hang")
    other = ModelGateway(fixture.root / "gateway", fixture.store.objects, fixture.contract, fixture.upstream)
    try:
        handle = services.launch_confined(prepared)
        assert birth(int(handle.handle)) is not None
        terminate_recorded(other, prepared.execution_context)
        services.cancel(handle)  # Reap the terminated child in its actual parent.
        assert birth(int(handle.handle)) is None
        with pytest.raises(ProcessLookupError):
            os.kill(int(handle.handle), 0)
        assert other.prove_no_dispatch(prepared.execution_context) is not None
        assert not fixture.upstream.requests
    finally:
        services.close()
        other.close()


def test_recovery_never_signals_a_reused_process_id(fixture: HarnessFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    from strive.vnext.harness.process_identity import terminate_recorded
    prepared = prepare(fixture)
    fixture.gateway.issue(prepared)
    fixture.gateway.event(prepared.execution_context, "pid",
                          fixture.store.objects.publish(encode(("process-identity/1", 12345, "old-birth"))))
    monkeypatch.setattr("strive.vnext.harness.process_identity.birth", lambda pid: "new-birth")
    def fail(pid: int, sig: int) -> None:
        raise AssertionError("must not signal a different process incarnation")
    monkeypatch.setattr("strive.vnext.harness.process_identity.os.killpg", fail)
    terminate_recorded(fixture.gateway, prepared.execution_context)


def test_revocation_between_admission_and_send_prevents_upstream(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    token = fixture.gateway.issue(prepared)
    def cancelled(raw: bytes, send: Callable[[bytes], bytes]) -> bytes:
        state = fixture.gateway.read(prepared.execution_context)
        assert state is not None and state.state == "wire" and state.wire is not None
        assert fixture.store.objects.read(state.wire) == raw and not fixture.upstream.requests
        fixture.gateway.revoke(prepared.execution_context)
        return send(raw)
    with pytest.raises(VerificationError, match="cancelled"):
        fixture.gateway.dispatch(prepared.execution_context, token, request(fixture), cancelled)
    assert not fixture.upstream.requests


def test_gateway_contract_change_cannot_resume_old_capability(fixture: HarnessFixture) -> None:
    prepared = prepare(fixture)
    fixture.gateway.issue(prepared)
    changed = ModelGateway(fixture.root / "gateway", fixture.store.objects,
                           replace(fixture.contract, output_ceiling=65), fixture.upstream)
    try:
        with pytest.raises(VerificationError, match="changed on recovery"):
            changed.read(prepared.execution_context)
    finally:
        changed.close()


def test_registered_implementation_source_is_part_of_adapter_pin(fixture: HarnessFixture) -> None:
    from strive.vnext.harness.adapters.base import TextHarnessAdapter
    class InstalledAdapter(TextHarnessAdapter):
        pass
    installed = InstalledAdapter(fixture.store.objects, fixture.profile, fixture.contract)
    assert installed.identity != fixture.adapter.identity
    retained = decode(fixture.store.objects.read(installed.identity))
    assert isinstance(retained, tuple)
    assert retained[0] == fixture.store.objects.publish(Path(__file__).read_bytes())


def test_profile_cannot_weaken_mechanical_deno_permissions(fixture: HarnessFixture) -> None:
    from strive.vnext.harness.process import ProcessServices
    weak = replace(fixture.profile, arguments=tuple(a for a in fixture.profile.arguments if a != "--deny-net"))
    services = ProcessServices(fixture.gateway, weak, fixture.root / "scratch", forward)
    try:
        with pytest.raises(VerificationError, match="permission arguments"):
            services.launch_confined(prepare(fixture))
        assert fixture.gateway.read(prepare(fixture).execution_context) is None
    finally:
        services.close()


def test_frozen_effect_scoped_gateway_interface_uses_same_single_dispatch(fixture: HarnessFixture) -> None:
    from strive.vnext.harness.process import ProcessServices
    services = ProcessServices(fixture.gateway, fixture.profile, fixture.root / "scratch", forward, mode="hang")
    try:
        prepared = prepare(fixture)
        services.launch_confined(prepared)
        reference = fixture.store.objects.publish(request(fixture))
        result = services.model_gateway.forward(reference)
        assert fixture.store.objects.read(result) == fixture.upstream.response
        with pytest.raises(VerificationError, match="spent"):
            services.model_gateway.forward(reference)
        assert len(fixture.upstream.requests) == 1
    finally:
        services.close()
