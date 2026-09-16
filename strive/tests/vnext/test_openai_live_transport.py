"""Actual live transport code with scripted sockets only; no network or spend."""
from concurrent.futures import Future
from dataclasses import dataclass, field
import errno
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import ssl
import sys
import threading
from typing import Iterator

import pytest

from strive.codec import decode
from strive.contracts.primitives import ExecutionStatus, Resource
from strive.errors import VerificationError
from strive.harness import openai_live
from strive.harness.deadline import upstream_deadline
from strive.harness.openai_live import CONTROLS, OpenAIEgress, OpenAITransport, canonical, load_contract
from strive.runtime.ledger import amounts
from strive.store.cas import CAS
from .test_live_campaign import PRICE, Setup

KEY = "test-secret-openai-key"
PROMPT = 'private prompt with "quotes" and\na newline'
COUNT = canonical({"object": "response.input_tokens", "input_tokens": 10})
REPLY = canonical({"id": "resp-scripted", "model": "gpt-5.6-luna", "status": "completed", "service_tier": "default",
    "usage": {"input_tokens": 10, "output_tokens": 10, "input_tokens_details": {"cached_tokens": 0}},
    "output": [{"type": "message", "content": [{"type": "output_text", "text": '{"message":"hello"}'}]}]})


@dataclass
class Step:
    body: bytes = COUNT
    phase: str = "read_headers"
    error: Exception | None = None
    status: int = 200
    delay: float = 0
    reads: int = 0


@dataclass
class ScriptedSocket:
    timeout: float = 0

    def settimeout(self, value: float) -> None:
        self.timeout = value

    def shutdown(self, how: int) -> None:
        pass


@dataclass
class Wire:
    steps: list[Step] = field(default_factory=lambda: [Step(), Step(REPLY)])
    connections: list["ScriptedConnection"] = field(default_factory=list)
    now: float = 100
    pids: list[int] = field(default_factory=list)
    threads: list[int] = field(default_factory=list)
    namespaces: list[str | None] = field(default_factory=list)


class ScriptedConnection:
    def __init__(self, wire: Wire, host: str, port: int | None, timeout: float) -> None:
        self.wire, self.host, self.port, self.timeout = wire, host, port, timeout
        self.step = wire.steps[len(wire.connections)]
        self.sock = ScriptedSocket(timeout)
        self.tunnel: tuple[str, int, dict[str, str]] | None = None
        self.path: str | None = None
        self.headers: dict[str, str] = {}
        self.closed = False
        wire.connections.append(self)

    def set_tunnel(self, host: str, port: int, headers: dict[str, str]) -> None:
        self.tunnel = host, port, headers

    def check(self, phase: str) -> None:
        if phase == self.step.phase and self.step.error is not None:
            raise self.step.error

    def connect(self) -> None:
        self.wire.pids.append(os.getpid())
        self.wire.threads.append(threading.get_ident())
        self.wire.namespaces.append(openai_live.network_namespace())
        self.check("connect")

    def request(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> None:
        assert method == "POST"
        self.path, self.headers = path, headers
        self.check("write")

    def getresponse(self) -> "ScriptedConnection":
        self.check("read_headers")
        if self.step.delay >= self.sock.timeout:
            self.wire.now += self.sock.timeout
            raise TimeoutError("timed out waiting for response headers")
        self.wire.now += self.step.delay
        return self

    @property
    def status(self) -> int:
        return self.step.status

    def read(self, maximum: int) -> bytes:
        self.step.reads += 1
        self.check("read_body")
        return self.step.body[:maximum]

    def close(self) -> None:
        self.closed = True


def install_wire(monkeypatch: pytest.MonkeyPatch, wire: Wire, *, clock: bool = True) -> None:
    monkeypatch.setattr(openai_live, "require_live_container", lambda: None)
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    def connection(host: str, port: int | None = None, *, timeout: float) -> ScriptedConnection:
        return ScriptedConnection(wire, host, port, timeout)
    monkeypatch.setattr("strive.harness.openai_live.http.client.HTTPSConnection", connection)
    if clock:
        monkeypatch.setattr("strive.harness.openai_live.time.monotonic", lambda: wire.now)


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[OpenAITransport, Wire, bytes]]:
    wire = Wire()
    install_wire(monkeypatch, wire)
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    transport = OpenAITransport(contract, objects, tmp_path / "transport")
    request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
    try:
        yield transport, wire, request
    finally:
        transport.close()


def diagnostic(transport: OpenAITransport) -> dict[str, object]:
    row = transport.db.execute("SELECT detail FROM diagnostics ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    value: object = json.loads(row[0])
    assert isinstance(value, dict)
    return value


@pytest.fixture
def namespace(monkeypatch: pytest.MonkeyPatch) -> threading.local:
    namespace = threading.local()
    namespace.name = "net:[egress]"
    monkeypatch.setattr(openai_live, "network_namespace", lambda: getattr(namespace, "name", "net:[egress]"))
    start = threading.Thread.start
    def inherit_namespace(thread: threading.Thread) -> None:
        inherited, run = namespace.name, thread.run
        def run_in_namespace() -> None:
            namespace.name = inherited
            run()
        thread.run = run_in_namespace  # type: ignore[method-assign]
        start(thread)
    monkeypatch.setattr(threading.Thread, "start", inherit_namespace)
    return namespace


def test_counting_and_generation_share_ready_egress_for_late_transport(tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch, namespace: threading.local) -> None:
    wire = Wire(steps=[Step(), Step(REPLY), Step(), Step(REPLY)])
    install_wire(monkeypatch, wire)
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    egress = OpenAIEgress()
    try:
        assert egress.ready.done() and egress.ready.result() is None
        assert not wire.connections  # Readiness performs no upstream probe.
        namespace.name = "net:[gateway-only]"
        # Both transports are created AFTER jail entry. Neither may capture
        # this caller's namespace or start a replacement egress worker.
        for role in ("actor", "user"):
            transport = OpenAITransport(contract, objects, tmp_path / role, egress=egress)
            try:
                assert transport._worker is egress.thread
                request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
                assert transport.generate(request, role) == REPLY
                assert namespace.name == "net:[gateway-only]"
            finally:
                transport.close()
            assert egress.thread.is_alive()  # One transport cannot close it.
        assert [connection.path for connection in wire.connections] == [
            "/v1/responses/input_tokens", "/v1/responses",
            "/v1/responses/input_tokens", "/v1/responses"]
        assert wire.threads == [egress.thread.ident] * 4
        assert wire.threads[0] != threading.get_ident()
        assert wire.namespaces == [egress.netns] * 4 == ["net:[egress]"] * 4
        assert [connection.timeout for connection in wire.connections] == [10] * 4
    finally:
        namespace.name = "net:[egress]"
        egress.close()


def test_egress_constructor_waits_for_namespace_readiness(monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release = threading.Event(), threading.Event()
    def namespace() -> str:
        if threading.current_thread().name == "openai-egress":
            entered.set()
            assert release.wait(5), "test must release worker startup"
        return "net:[egress]"
    monkeypatch.setattr(openai_live, "network_namespace", namespace)
    result: Future[OpenAIEgress] = Future()
    def construct() -> None:
        try:
            result.set_result(OpenAIEgress())
        except BaseException as error:
            result.set_exception(error)
    caller = threading.Thread(target=construct, daemon=True)
    caller.start()
    try:
        assert entered.wait(5)
        assert not result.done()  # start() alone must not count as readiness.
    finally:
        release.set()
        caller.join(timeout=5)
    egress = result.result(timeout=5)
    try:
        assert egress.ready.done() and egress.ready.result() is None
    finally:
        egress.close()


def test_egress_rejects_wrong_namespace_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(openai_live, "network_namespace", lambda:
                        "net:[wrong]" if threading.current_thread().name == "openai-egress" else "net:[egress]")
    with pytest.raises(VerificationError, match="failed readiness; no dispatch"):
        OpenAIEgress()


def test_upstream_connection_cannot_bypass_worker(rig: tuple[OpenAITransport, Wire, bytes]) -> None:
    transport, wire, _ = rig
    # Even a caller still in the original namespace cannot open upstream HTTP.
    with pytest.raises(VerificationError, match="trusted owner"):
        transport._connection()
    assert not wire.connections


def test_worker_namespace_is_checked_again_for_generation(tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch, namespace: threading.local) -> None:
    wire = Wire()
    install_wire(monkeypatch, wire)
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    transport = OpenAITransport(contract, objects, tmp_path / "transport")
    original = ScriptedConnection.close
    def change_namespace(connection: ScriptedConnection) -> None:
        original(connection)
        namespace.name = "net:[unexpected-worker-jail]"
    monkeypatch.setattr(ScriptedConnection, "close", change_namespace)
    try:
        request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
        with pytest.raises(VerificationError, match="trusted owner"):
            transport.generate(request, "worker-moved")
        assert [connection.path for connection in wire.connections] == ["/v1/responses/input_tokens"]
        assert diagnostic(transport)["endpoint"] == "/v1/responses"
        assert diagnostic(transport)["phase"] == "boundary"
        assert diagnostic(transport)["netns"] == "net:[unexpected-worker-jail]"
        assert diagnostic(transport)["egress_netns"] == "net:[egress]"
    finally:
        transport.close()


@pytest.mark.parametrize("phase,error,kind", [
    ("connect", socket.gaierror(socket.EAI_NONAME, "Name or service not known"), "dns"),
    ("connect", OSError(errno.ENETUNREACH, "Network is unreachable"), "transport"),
    ("connect", TimeoutError("connect timed out"), "connect_timeout"),
    ("connect", ssl.SSLError("certificate verify failed"), "tls"),
    ("write", BrokenPipeError(errno.EPIPE, "Broken pipe"), "transport"),
    ("read_headers", TimeoutError("read timed out"), "read_headers_timeout"),
    ("read_headers", http.client.RemoteDisconnected("peer closed without response"), "transport"),
    ("read_body", http.client.IncompleteRead(b"secret response bytes", 100), "transport"),
])
@pytest.mark.parametrize("counting", [True, False])
def test_real_cause_is_durable_and_visible_without_retry(rig: tuple[OpenAITransport, Wire, bytes],
        capsys: pytest.CaptureFixture[str], tmp_path: Path, phase: str, error: Exception, kind: str, counting: bool) -> None:
    transport, wire, request = rig
    wire.steps[0 if counting else 1] = Step(phase=phase, error=error)
    with pytest.raises(VerificationError, match="no retry; retain reservation") as caught:
        transport.generate(request, "operation-1")
    detail = diagnostic(transport)
    assert detail["exception_type"] == type(error).__name__
    assert detail["message"] == str(error)
    assert detail["kind"] == kind and detail["phase"] == phase
    assert detail["endpoint"] == ("/v1/responses/input_tokens" if counting else "/v1/responses")
    assert detail["route"] == "egress_worker" and detail["proxy_route"] == "none"
    assert detail["errno"] == (error.errno if isinstance(error, OSError) else None)
    assert detail["pid"] == detail["owner_pid"] == os.getpid()
    assert detail["netns"] == detail["owner_netns"]
    assert len(wire.connections) == (1 if counting else 2)
    assert all(c.closed for c in wire.connections)
    assert type(error).__name__ in capsys.readouterr().err
    assert type(error).__name__ in str(caught.value)
    # Reopen independently to verify this is durable, not an in-memory log.
    with sqlite3.connect(tmp_path / "transport/transport.sqlite") as db:
        assert db.execute("SELECT operation FROM diagnostics").fetchall() == [("operation-1",)]
    with pytest.raises(VerificationError, match="duplicate"):
        transport.generate(request, "operation-1")
    assert len(wire.connections) == (1 if counting else 2)
    if not counting:
        assert transport.db.execute("SELECT response FROM calls").fetchall() == [(None,)]


@pytest.mark.parametrize("status", [302, 401, 429, 500])
def test_http_status_without_error_body_or_redirect(rig: tuple[OpenAITransport, Wire, bytes], status: int) -> None:
    transport, wire, request = rig
    wire.steps[1] = Step(body=(KEY + PROMPT).encode(), status=status)
    with pytest.raises(VerificationError):
        transport.generate(request, "http-error")
    detail = diagnostic(transport)
    assert detail["http_status"] == status and detail["message"] == f"OpenAI HTTP status {status}"
    assert wire.steps[1].reads == 0 and len(wire.connections) == 2


def test_exception_redaction(rig: tuple[OpenAITransport, Wire, bytes], capsys: pytest.CaptureFixture[str]) -> None:
    transport, wire, request = rig
    wire.steps[1].error = OSError(errno.ECONNRESET, f"reset {KEY} {PROMPT} {request!r}")
    with pytest.raises(VerificationError) as caught:
        transport.generate(request, "redacted")
    recorded = canonical(diagnostic(transport)).decode() + str(caught.value) + capsys.readouterr().err
    assert KEY not in recorded and "private prompt" not in recorded and "a newline" not in recorded
    assert "ConnectionResetError" in recorded and "[redacted]" in recorded


def test_bad_status_line_cannot_log_response_bytes(rig: tuple[OpenAITransport, Wire, bytes],
        capsys: pytest.CaptureFixture[str]) -> None:
    transport, wire, request = rig
    wire.steps[1].error = http.client.BadStatusLine("private response text")
    with pytest.raises(VerificationError) as caught:
        transport.generate(request, "bad-status")
    recorded = str(diagnostic(transport)) + str(caught.value) + capsys.readouterr().err
    assert "private response text" not in recorded
    assert "BadStatusLine" in recorded


def test_read_stall_is_capped_even_with_long_generation_budget(rig: tuple[OpenAITransport, Wire, bytes]) -> None:
    transport, wire, request = rig
    wire.steps[0].delay = 5
    wire.steps[1].delay = 90
    with pytest.raises(VerificationError, match="timed out waiting for response headers"):
        transport.generate(request, "slow-generation")
    assert wire.now == 165
    assert [c.timeout for c in wire.connections] == [10, 10]
    assert wire.connections[1].sock.timeout == 60
    assert diagnostic(transport)["read_timeout_seconds"] == 60


def test_count_and_generation_share_harness_deadline(rig: tuple[OpenAITransport, Wire, bytes]) -> None:
    transport, wire, request = rig
    wire.steps[0].delay, wire.steps[1].delay = 5, 90
    token = upstream_deadline.set(wire.now + 40)
    try:
        with pytest.raises(VerificationError, match="TimeoutError"):
            transport.generate(request, "remaining-harness-budget")
    finally:
        upstream_deadline.reset(token)
    assert wire.now == 139
    detail = diagnostic(transport)
    assert detail["read_timeout_seconds"] == 34 and detail["deadline_exceeded"] is True
    assert detail["message"] == "timed out waiting for response headers"
    assert transport.db.execute("SELECT response FROM calls").fetchall() == [(None,)]


@pytest.mark.parametrize("bypass", [False, True])
def test_proxy_is_used_only_in_trusted_parent_and_no_proxy_is_honored(rig: tuple[OpenAITransport, Wire, bytes],
        monkeypatch: pytest.MonkeyPatch, bypass: bool) -> None:
    transport, wire, request = rig
    monkeypatch.setenv("https_proxy", "http://proxy-user:proxy-password@egress.example:3128")
    if bypass:
        monkeypatch.setenv("no_proxy", ".openai.com")
    assert transport.generate(request, "proxy-route") == REPLY
    for connection in wire.connections:
        assert connection.host == ("api.openai.com" if bypass else "egress.example")
        if not bypass:
            assert connection.tunnel is not None and connection.tunnel[:2] == ("api.openai.com", 443)
            assert "Proxy-Authorization" in connection.tunnel[2]
            assert KEY not in str(connection.tunnel)
        assert connection.headers["Authorization"] == "Bearer " + KEY
        assert "Proxy-Authorization" not in connection.headers
    assert wire.pids == [os.getpid(), os.getpid()]


@pytest.mark.parametrize("change", ["pid", "netns"])
def test_transport_refuses_a_move_into_child_or_other_netns(rig: tuple[OpenAITransport, Wire, bytes],
        monkeypatch: pytest.MonkeyPatch, change: str) -> None:
    transport, wire, request = rig
    if change == "pid":
        monkeypatch.setattr("strive.harness.openai_live.os.getpid", lambda: transport._owner_pid + 1)
    else:
        monkeypatch.setattr(openai_live, "network_namespace", lambda: "net:[confined]")
    with pytest.raises(VerificationError, match="trusted owner"):
        transport.generate(request, "wrong-boundary")
    assert not wire.connections
    assert diagnostic(transport)["phase"] == "boundary"


@pytest.mark.parametrize("counting", [True, False])
def test_campaign_pipe_attempts_upstream_in_parent_and_suspends_with_real_cause(tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], namespace: threading.local,
        counting: bool) -> None:
    wire = Wire()
    wire.steps[0 if counting else 1] = Step(error=TimeoutError("scripted read timeout after request send"))
    install_wire(monkeypatch, wire, clock=False)
    setup = Setup(tmp_path)
    try:
        campaign = setup.open()
        gateway = campaign.gateways["actor"]
        transport = OpenAITransport(campaign.contracts["actor"], campaign.objects, campaign.directory / "transport/actor")
        campaign.resources.callback(transport.close)
        gateway.upstream = transport
        assert transport._worker.is_alive()
        # Reproduce the reported per-thread contamination at the actual gateway
        # dispatch edge. A worker created lazily here would inherit the jail in
        # Linux; the eager worker must keep its trusted namespace.
        def enter_jail(point: str) -> None:
            if point == "upstream-before-send":
                namespace.name = "net:[gateway-only]"
        gateway.fault = enter_jail
        with pytest.raises(VerificationError, match="scripted read timeout"):
            campaign.drive()
        state = campaign.reader.verify()
        assert state.execution_status is ExecutionStatus.SUSPENDED
        assert amounts(state.obligations)[Resource.USD_NANODOLLARS] == 7_782_400
        assert amounts(state.measured).get(Resource.USD_NANODOLLARS, 0) == 0
        context = campaign.actor._context(state.effects[-1].authorization)
        pid_ref, = gateway.events(context, "pid")
        identity = decode(campaign.objects.read(pid_ref))
        assert isinstance(identity, tuple) and identity[0] == "process-identity/1"
        assert identity[1] != os.getpid()
        calls = 1 if counting else 2
        assert [connection.path for connection in wire.connections] == [
            "/v1/responses/input_tokens", "/v1/responses"][:calls]
        assert wire.pids == [os.getpid()] * calls
        assert wire.threads == [transport._worker.ident] * calls
        assert wire.threads[0] != threading.get_ident()
        assert wire.namespaces == ["net:[egress]"] * calls
        assert namespace.name == "net:[gateway-only]"  # Caller was not unjailed.
        assert diagnostic(transport)["caller_netns"] == "net:[gateway-only]"
        assert diagnostic(transport)["netns"] == "net:[egress]"
        assert diagnostic(transport)["egress_netns"] == "net:[egress]"
        assert diagnostic(transport)["route"] == "egress_worker"
        assert diagnostic(transport)["message"] == "scripted read timeout after request send"
        assert "TimeoutError" in capsys.readouterr().err
        campaign.drive()
        assert len(wire.connections) == calls
        setup.close()
        campaign = setup.open(resume=True)
        campaign.drive()
        assert campaign.reader.verify().execution_status is ExecutionStatus.SUSPENDED
        assert len(wire.connections) == calls and not setup.calls
        assert amounts(campaign.reader.verify().obligations)[Resource.USD_NANODOLLARS] == 7_782_400
    finally:
        namespace.name = "net:[egress]"
        setup.close()


@pytest.mark.parametrize("phase", ["connect", "read_headers"])
def test_worker_wait_is_bounded_and_late_connect_never_sends(tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch, phase: str) -> None:
    from concurrent.futures import Future

    wire = Wire()
    install_wire(monkeypatch, wire, clock=False)
    entered, release = threading.Event(), threading.Event()
    original = ScriptedConnection.check
    def block(connection: ScriptedConnection, stage: str) -> None:
        if stage == phase:
            entered.set()
            assert release.wait(5), "test must release scripted resolver/read"
        original(connection, stage)
    monkeypatch.setattr(ScriptedConnection, "check", block)
    wait = OpenAITransport._wait
    def bounded_wait(self: OpenAITransport, future: Future[None] | Future[bytes], timeout: float, stage: str) -> None:
        if stage == ("connect" if phase == "connect" else "read"):
            assert entered.wait(5)
            # Synchronize first, then force expiry without a clock race/sleep.
            timeout = 0
        wait(self, future, timeout, stage)
    monkeypatch.setattr(OpenAITransport, "_wait", bounded_wait)
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    transport = OpenAITransport(contract, objects, tmp_path / "transport")
    request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
    try:
        with pytest.raises(VerificationError, match="timeout waiting for egress worker"):
            transport.generate(request, "blocked-worker")
        detail = diagnostic(transport)
        assert detail["phase"] == phase
        assert detail["kind"] == phase + "_timeout"
        assert detail["exception_type"] == "TimeoutError"
        assert detail["action"] == "no retry; retain reservation"
        with pytest.raises(VerificationError, match="stalled"):
            transport.generate(request, "another-operation")
        assert len(wire.connections) == 1
        # Close the DB before unblocking DNS. The late worker must never write
        # a diagnostic/receipt or send a request after campaign recovery.
        transport.close()
        release.set()
        transport._worker.join(timeout=5)
        assert not transport._worker.is_alive()
        assert wire.connections[0].closed
        if phase == "connect":
            assert wire.connections[0].path is None
    finally:
        release.set()
        transport.close()


@pytest.mark.skipif(sys.platform != "linux", reason="real per-thread netns requires Linux")
def test_real_thread_netns_change_keeps_upstream_in_original_namespace(tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    import ctypes
    from concurrent.futures import Future
    from .test_linux_jail import require_jail

    require_jail()
    wire = Wire()
    install_wire(monkeypatch, wire, clock=False)
    objects = CAS(tmp_path / "cas")
    objects.directory.mkdir()
    contract = load_contract(objects, PRICE, input_tokens=32768, output_tokens=1024, wall_seconds=150)
    transport = OpenAITransport(contract, objects, tmp_path / "transport")
    result: Future[tuple[str | None, str | None]] = Future()
    def jailed_dispatch() -> None:
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.unshare(0x40000000) != 0:  # CLONE_NEWNET, calling thread only
                raise OSError(ctypes.get_errno(), "test gateway thread could not unshare netns")
            before = openai_live.network_namespace()
            assert before is not None and before != transport._owner_netns
            request = canonical({**CONTROLS, "model": contract.model, "input": PROMPT, "max_output_tokens": 1024})
            assert transport.generate(request, "real-jailed-thread") == REPLY
            result.set_result((before, openai_live.network_namespace()))
        except BaseException as error:
            result.set_exception(error)
    caller = threading.Thread(target=jailed_dispatch, daemon=True)
    try:
        caller.start()
        before, after = result.result(timeout=10)
        assert before == after  # Never give the gateway-serving thread egress.
        assert wire.namespaces == [transport._owner_netns, transport._owner_netns]
        assert wire.threads == [transport._worker.ident, transport._worker.ident]
        assert openai_live.network_namespace() == transport._owner_netns
    finally:
        caller.join(timeout=1)
        transport.close()


def test_proxy_failure_is_redacted_and_never_falls_back(rig: tuple[OpenAITransport, Wire, bytes],
        monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    transport, wire, request = rig
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy-user:proxy-password@egress.example:3128")
    wire.steps[0].phase = "connect"
    wire.steps[0].error = OSError("proxy refused proxy-user proxy-password")
    with pytest.raises(VerificationError):
        transport.generate(request, "proxy-failure")
    detail = diagnostic(transport)
    assert detail["route"] == "egress_worker" and detail["proxy_route"] == "http_connect"
    assert detail["phase"] == "connect"
    assert len(wire.connections) == 1
    assert "proxy-password" not in capsys.readouterr().err + str(detail)
    assert "proxy-user" not in str(detail)


def test_upstream_error_survives_child_broken_pipe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from collections.abc import Callable
    import io
    import subprocess
    from typing import cast
    from strive.contracts.harness import ExecutionContext
    from strive.harness.process import ProcessServices
    from .harness_support import HarnessFixture
    from .test_harness_gateway import prepare

    cause = VerificationError("original upstream read timeout")
    class ClosedInput(io.BytesIO):
        def write(self, data: object) -> int:
            raise BrokenPipeError(errno.EPIPE, "child exited")
    class Child:
        stdin = ClosedInput()
    def fail(context: ExecutionContext, token: str, raw: bytes,
             forward: Callable[[bytes, Callable[[bytes], bytes]], bytes]) -> bytes:
        raise cause
    fixture = HarnessFixture(tmp_path)
    try:
        services = ProcessServices(fixture.gateway, fixture.adapter.profile, tmp_path, lambda raw, send: send(raw))
        services._prepared = prepare(fixture)
        monkeypatch.setattr(fixture.gateway, "dispatch", fail)
        with pytest.raises(VerificationError) as caught:
            services._pipe_request(canonical({"gateway_request": "{}", "token": "test", "path": "/generation"}),
                                   cast(subprocess.Popen[bytes], Child()))
        assert caught.value is cause
    finally:
        fixture.close()
