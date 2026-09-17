"""Pinned OpenAI text/function transport. Only the container owns credentials.

The broker reserves first. The counting endpoint then bounds the exact input,
including message framing and function schemas, before paid generation. Neither
endpoint retries. Ambiguous calls retain the M3 obligation.
"""
from concurrent.futures import Future
from dataclasses import dataclass, field
import base64
import http.client
import json
import os
from pathlib import Path
from queue import Queue
import sqlite3
import socket
import ssl
import sys
import threading
import time
from collections.abc import Callable
from typing import cast
from urllib.parse import unquote, urlsplit
import urllib.request

from ..contracts.primitives import Resource, ResourceQuantity
from ..errors import VerificationError
from ..store.cas import CAS, fsync_directory
from .deadline import (CONNECT_TIMEOUT_SECONDS, READ_TIMEOUT_SECONDS,
                       RETURN_MARGIN_SECONDS, upstream_deadline)
from .provider import ProviderContract, json_object
from .user_model import UserProviderContract

MODEL = "gpt-5.6-luna"
ENDPOINT = "https://api.openai.com/v1/responses"
CONTROLS: dict[str, object] = {"service_tier": "default", "store": False,
    "prompt_cache_options": {"mode": "explicit"}, "reasoning": {"effort": "low"}}

# typeshed exposes this helper only on Linux, but our no-spend tests also run on
# macOS. Use the environment-only helper, never macOS system proxy discovery.
proxy_bypass_environment = cast(Callable[[str, dict[str, str]], bool],
                               getattr(urllib.request, "proxy_bypass_environment"))


def network_namespace() -> str | None:
    # Network namespaces are per-thread on Linux. Do not confuse the process
    # leader's namespace with a calling thread that has entered a jail.
    try:
        return os.readlink("/proc/thread-self/ns/net")
    except OSError:
        return None


def require_live_container() -> None:
    # Live calls only inside the sanctioned Linux container. Accept both the
    # Docker marker (/.dockerenv) and the podman marker (/run/.containerenv);
    # the host (macOS / no container) is refused so stray runs never spend.
    in_container = Path("/.dockerenv").is_file() or Path("/run/.containerenv").is_file()
    if sys.platform != "linux" or not in_container:
        raise VerificationError("live model calls require the orchestrator's Linux container")


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def integer(value: object) -> int:
    if type(value) is not int or value < 0:
        raise VerificationError("missing or invalid provider token count")
    return value


@dataclass(frozen=True)
class OpenAIContract(UserProviderContract):
    cached_nanodollars: int = 20
    write_nanodollars: int = 250
    user: bool = False

    def request_controls(self) -> dict[str, object]:
        return dict(CONTROLS)

    def validate(self, raw: bytes) -> None:
        value = json_object(raw)
        if any(value.pop(key, None) != expected for key, expected in CONTROLS.items()):
            raise VerificationError("live requests require pinned tier/cache/reasoning controls")
        if len(raw) > self.max_request_bytes:
            raise VerificationError("oversized live request")
        if self.user:
            UserProviderContract.validate(self, canonical(value))
        else:
            ProviderContract.validate(self, canonical(value))

    def _visible(self, raw: bytes) -> bytes:
        value = json_object(raw)
        output = value.get("output")
        if not isinstance(output, list):
            raise VerificationError("missing provider output")
        # Reasoning items are inert. Their tokens remain in output_tokens.
        value["output"] = [item for item in output if not isinstance(item, dict) or item.get("type") != "reasoning"]
        return canonical(value)

    def text(self, raw: bytes) -> str:
        return ProviderContract.text(self, self._visible(raw))

    def proposals(self, raw: bytes) -> bytes:
        return UserProviderContract.proposals(self, self._visible(raw))

    def usage(self, raw: bytes) -> tuple[ResourceQuantity, ...]:
        response = json_object(raw)
        result = [ResourceQuantity(Resource.MODEL_CALLS, 1)]
        try:
            usage = response["usage"]
            if not isinstance(usage, dict):
                return tuple(result)
            incoming, outgoing = integer(usage.get("input_tokens")), integer(usage.get("output_tokens"))
            result.extend((ResourceQuantity(Resource.INPUT_TOKENS, incoming), ResourceQuantity(Resource.OUTPUT_TOKENS, outgoing)))
            details = usage.get("input_tokens_details")
            if (not isinstance(details, dict) or response.get("service_tier") != "default"
                    or response.get("model") != self.model):
                return tuple(result)
            cached = integer(details.get("cached_tokens"))
            writes = integer(details.get("cache_write_tokens", 0))
            if cached + writes > incoming:
                return tuple(result)
            # Long-context receipts are priced at the pinned long rates, even
            # if the provider violated the admitted short-context input bound.
            multiplier = 2 if incoming > 272000 else 1
            output_price = 1800 if incoming > 272000 else self.output_nanodollars
            cost = ((incoming - cached - writes) * self.input_nanodollars +
                    cached * self.cached_nanodollars + writes * self.write_nanodollars) * multiplier + outgoing * output_price
            result.append(ResourceQuantity(Resource.USD_NANODOLLARS, cost))
        except (KeyError, VerificationError):
            pass  # Unknown components retain their reservation, never zero cost.
        return tuple(result)


def load_contract(objects: CAS, price_file: Path, *, input_tokens: int, output_tokens: int,
                  wall_seconds: int, user: bool = False, schemas: bytes = b"[]") -> OpenAIContract:
    raw = price_file.read_bytes()
    price = json_object(raw)
    expected = {"input": 200, "cached_input": 20, "cache_write": 250, "output": 1200}
    if (price.get("schema") != "strive.openai-prices/1" or price.get("model") != MODEL
            or price.get("endpoint") != ENDPOINT or price.get("service_tier") != "default"
            or price.get("short_nanodollars_per_token") != expected
            or price.get("long_nanodollars_per_token") != {"input": 400, "cached_input": 40, "cache_write": 500, "output": 1800}
            or price.get("long_context_above") != 272000 or not price.get("source") or not price.get("retrieved")):
        raise VerificationError("unrecognized price schedule; supply a reviewed, dated Luna schedule; suspend if unbounded")
    if not 0 < input_tokens <= 32768 or not 0 < output_tokens <= 4096:
        raise VerificationError("live input/output limits exceed qualified counting profile")
    return OpenAIContract("openai", MODEL, ENDPOINT, "responses-text/1", "env:OPENAI_API_KEY",
        objects.publish(raw), input_tokens, output_tokens, 262144, 1048576, 200, 1200,
        wall_milliseconds=wall_seconds * 1000, tool_schemas=schemas, user=user)


@dataclass
class HTTPAttempt:
    path: str
    raw: bytes
    connected: Future[None] = field(default_factory=Future)
    result: Future[bytes] = field(default_factory=Future)
    cancelled: threading.Event = field(default_factory=threading.Event)
    phase: str = "boundary"
    status: int | None = None
    netns: str | None = None
    thread: int | None = None
    sock: socket.socket | None = None

    def cancel(self) -> None:
        self.cancelled.set()
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class OpenAIEgress:
    """One worker captured and readied in trusted setup, before any jail entry."""

    def __init__(self) -> None:
        self.pid = os.getpid()
        self.netns = network_namespace()
        if sys.platform == "linux" and self.netns is None:
            raise VerificationError("cannot capture OpenAI egress network namespace; no dispatch")
        self.ready: Future[None] = Future()
        self.stalled = False
        self._closed = False
        self._jobs: Queue[tuple[Callable[[HTTPAttempt], bytes], HTTPAttempt] | None] = Queue()
        self.thread = threading.Thread(target=self._serve, name="openai-egress", daemon=True)
        self.thread.start()
        try:
            # No HTTP probe or spend. Acknowledgement proves the worker has
            # inherited the captured namespace before setup can enter a jail.
            self.ready.result(timeout=CONNECT_TIMEOUT_SECONDS)
        except Exception:
            self.close()
            raise VerificationError("OpenAI egress worker failed readiness; no dispatch") from None

    def check(self) -> None:
        if (os.getpid() != self.pid or threading.current_thread() is not self.thread
                or network_namespace() != self.netns):
            raise VerificationError("upstream transport left its trusted owner process/network namespace/worker")

    def submit(self, exchange: Callable[[HTTPAttempt], bytes], attempt: HTTPAttempt) -> None:
        if (os.getpid() != self.pid or self._closed or self.stalled or not self.thread.is_alive()):
            raise VerificationError("OpenAI egress worker unavailable; no retry; retain reservation")
        self.ready.result(timeout=0)
        self._jobs.put((exchange, attempt))

    def _serve(self) -> None:
        try:
            self.check()
        except Exception as error:
            self.ready.set_exception(error)
            return
        self.ready.set_result(None)
        while (job := self._jobs.get()) is not None:
            exchange, attempt = job
            try:
                if attempt.cancelled.is_set():
                    raise TimeoutError("request cancelled before egress dispatch")
                body = exchange(attempt)
            except Exception as error:
                if not attempt.connected.done():
                    attempt.connected.set_exception(error)
                attempt.result.set_exception(error)
            else:
                attempt.result.set_result(body)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._jobs.put(None)
            # DNS cannot be interrupted portably. Cancelled late connections
            # never send, and the daemon never writes diagnostics or receipts.
            self.thread.join(timeout=1)


class OpenAITransport:
    """Durable dispatch audit; never store headers, credentials, or error bodies."""
    contract: OpenAIContract
    objects: CAS
    db: sqlite3.Connection
    _credential: str

    def __init__(self, contract: OpenAIContract, objects: CAS, directory: Path,
                 *, egress: OpenAIEgress | None = None) -> None:
        require_live_container()
        credential = os.environ.get("OPENAI_API_KEY")
        if not credential:
            raise VerificationError("OPENAI_API_KEY is required in the container")
        if any(ord(character) < 33 or ord(character) > 126 for character in credential):
            # http.client can include an invalid header's value in its error.
            raise VerificationError("OPENAI_API_KEY contains invalid header characters")
        self._credential = credential
        self._egress = egress if egress is not None else OpenAIEgress()
        self._owns_egress = egress is None
        self._worker = self._egress.thread
        self._owner_pid = self._egress.pid
        self._owner_netns = self._egress.netns
        self._operation_key = ""
        self._deadline = 0.0
        self._proxy_secrets: set[str] = set()
        self._proxy_route = "none"
        self._connect_timeout = 0.0
        self._read_timeout = 0.0
        self._lock = threading.Lock()
        self._closed = False
        self._stalled = False
        self._attempt: HTTPAttempt | None = None
        self._caller_netns: str | None = None
        self.contract, self.objects = contract, objects
        directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(directory / "transport.sqlite", check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS calls (operation TEXT PRIMARY KEY, request TEXT, count TEXT, response TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, operation TEXT, detail TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS attempts (operation TEXT PRIMARY KEY)")
        self.db.commit()
        fsync_directory(directory)

    def _failure(self, error: Exception, path: str, raw: bytes, phase: str,
                 started: float, status: int | None) -> VerificationError:
        # Exception messages may echo a header or request. Never retain either.
        secrets = {self._credential, raw.decode(errors="replace"), repr(raw), *self._proxy_secrets}
        def collect(value: object) -> None:
            if isinstance(value, str) and value:
                secrets.update((value, json.dumps(value)[1:-1], repr(value)[1:-1]))
            elif isinstance(value, list):
                for item in value:
                    collect(item)
            elif isinstance(value, dict):
                for item in value.values():
                    collect(item)
        collect(json_object(raw))
        # BadStatusLine.__str__ can contain the server's full status line.
        # Keep its type but never retain arbitrary response bytes as a message.
        message = str(error)
        if isinstance(error, http.client.BadStatusLine) and not isinstance(error, http.client.RemoteDisconnected):
            message = "invalid HTTP status line [redacted]"
        for secret in sorted(secrets, key=len, reverse=True):
            message = message.replace(secret, "[redacted]")
        kind = ("netns" if phase == "boundary" and isinstance(error, VerificationError)
                else "dns" if isinstance(error, socket.gaierror) else "tls" if isinstance(error, ssl.SSLError)
                else phase + "_timeout" if isinstance(error, TimeoutError)
                else "http" if status is not None and status != 200 else "transport")
        detail = {"schema": "strive.openai-transport-error/1", "operation": self._operation_key,
            "endpoint": path, "phase": phase, "exception_type": type(error).__name__, "message": message[:1024],
            "kind": kind, "route": "egress_worker", "proxy_route": self._proxy_route,
            "connect_timeout_seconds": self._connect_timeout,
            "read_timeout_seconds": self._read_timeout, "deadline_exceeded": time.monotonic() >= self._deadline,
            "errno": error.errno if isinstance(error, OSError) else None, "http_status": status,
            "elapsed_seconds": round(time.monotonic() - started, 3), "pid": os.getpid(),
            "owner_pid": self._owner_pid, "netns": self._attempt.netns if self._attempt else network_namespace(),
            "owner_netns": self._owner_netns, "egress_netns": self._egress.netns, "caller_netns": self._caller_netns,
            "upstream_thread": self._attempt.thread if self._attempt else None,
            "action": "no retry; retain reservation"}
        encoded = canonical(detail).decode()
        # Print even if persisting the diagnostic itself fails. FULL sync commit
        # completes before the exception reaches campaign recovery.
        print("OpenAI transport failure: " + encoded, file=sys.stderr, flush=True)
        with self.db:
            self.db.execute("INSERT INTO diagnostics(operation, detail) VALUES (?,?)", (self._operation_key, encoded))
        return VerificationError("OpenAI transport outcome unknown; no retry; retain reservation: " + encoded)

    def _remaining(self) -> float:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("generation deadline exhausted")
        return remaining

    def _connection(self) -> http.client.HTTPSConnection:
        # Match urllib's Linux environment proxy routing, but never follow a
        # redirect or fall back to direct egress. CONNECT carries no API key;
        # the key and prompt are sent only after TLS to api.openai.com.
        self._egress.check()
        proxies = urllib.request.getproxies_environment()
        proxy = proxies.get("https") if not proxy_bypass_environment("api.openai.com", proxies) else None
        self._proxy_route = "http_connect" if proxy else "none"
        if not proxy:
            return http.client.HTTPSConnection("api.openai.com", timeout=self._connect_timeout)
        self._proxy_secrets.add(proxy)
        route = urlsplit(proxy if "://" in proxy else "http://" + proxy)
        if route.scheme != "http" or not route.hostname or route.query or route.fragment or route.path not in {"", "/"}:
            raise VerificationError("HTTPS_PROXY must specify an HTTP CONNECT proxy")
        headers: dict[str, str] = {}
        if route.username is not None:
            username, password = unquote(route.username), unquote(route.password or "")
            authorization = "Basic " + base64.b64encode((username + ":" + password).encode()).decode()
            self._proxy_secrets.update(value for value in (username, password, authorization) if value)
            headers["Proxy-Authorization"] = authorization
        connection = http.client.HTTPSConnection(route.hostname, route.port or 80, timeout=self._connect_timeout)
        connection.set_tunnel("api.openai.com", 443, headers=headers)
        return connection

    def _post(self, path: str, raw: bytes) -> bytes:
        started = time.monotonic()
        attempt = HTTPAttempt(path, raw)
        self._attempt = attempt
        self._connect_timeout = self._read_timeout = 0.0
        self._proxy_route = "none"
        try:
            if os.getpid() != self._owner_pid:
                raise VerificationError("upstream transport left its trusted owner process")
            self._connect_timeout = min(CONNECT_TIMEOUT_SECONDS, self._remaining())
            self._egress.submit(self._exchange, attempt)
            self._wait(attempt.connected, self._connect_timeout, "connect")
            if not attempt.result.done():
                self._wait(attempt.result, min(READ_TIMEOUT_SECONDS, self._remaining()), "read")
            return attempt.result.result()
        except Exception as error:
            # Completion may race the caller's deadline check. Prefer a
            # completed worker's real cause before cancelling its socket.
            if attempt.result.done():
                try:
                    attempt.result.result()
                except Exception as completed_error:
                    error = completed_error
            attempt.cancel()
            raise self._failure(error, path, raw, attempt.phase, started, attempt.status) from None

    def _wait(self, future: Future[None] | Future[bytes], timeout: float, phase: str) -> None:
        try:
            future.result(timeout=timeout)
        except TimeoutError:
            if future.done():
                # Handle a completion racing the waiter timeout, preserving a
                # real socket exception and its errno if the operation failed.
                future.result()
                return
            self._stalled = True
            self._egress.stalled = True
            raise TimeoutError(phase + " timeout waiting for egress worker" +
                               (" (includes DNS, TCP and TLS)" if phase == "connect" else "")) from None

    def _exchange(self, attempt: HTTPAttempt) -> bytes:
        connection: http.client.HTTPSConnection | None = None
        try:
            attempt.netns = network_namespace()
            attempt.thread = threading.get_native_id()
            self._egress.check()
            attempt.phase = "connect"
            connection = self._connection()
            connection.connect()
            # A resolver may return after the caller timed out. Never send a
            # request then. The abandoned daemon owns only this connection and
            # cannot write diagnostics or receipts after transport.close().
            if attempt.cancelled.is_set():
                raise TimeoutError("connect completed after cancellation")
            sock = connection.sock
            assert sock is not None
            attempt.sock = sock
            self._read_timeout = min(READ_TIMEOUT_SECONDS, self._remaining())
            sock.settimeout(self._read_timeout)
            attempt.connected.set_result(None)
            if attempt.cancelled.is_set():
                raise TimeoutError("request cancelled before send")
            attempt.phase = "write"
            connection.request("POST", attempt.path, attempt.raw, {"Content-Type": "application/json", "Authorization": "Bearer " + self._credential})
            attempt.phase = "read_headers"
            sock.settimeout(min(READ_TIMEOUT_SECONDS, self._remaining()))
            response = connection.getresponse()
            attempt.status = response.status
            if response.status != 200:
                raise VerificationError("OpenAI HTTP status " + str(response.status))
            attempt.phase = "read_body"
            sock.settimeout(min(READ_TIMEOUT_SECONDS, self._remaining()))
            body = response.read(self.contract.max_response_bytes + 1)
            self._remaining()
            if len(body) > self.contract.max_response_bytes:
                raise VerificationError("OpenAI response exceeds byte limit")
            return body
        finally:
            if connection is not None:
                connection.close()

    def generate(self, request: bytes, operation_key: str) -> bytes:
        with self._lock:
            if self._closed or self._stalled:
                raise VerificationError("live transport closed or stalled; no retry; retain reservation")
            self._caller_netns = network_namespace()
            return self._generate(request, operation_key)

    def _generate(self, request: bytes, operation_key: str) -> bytes:
        self.contract.validate(request)
        self._operation_key = operation_key
        # Leave one second for the harness to consume the reply and exit, while
        # keeping the existing wall reservation and outer deadline unchanged.
        now = time.monotonic()
        self._deadline = min(upstream_deadline.get() or float("inf"), now + self.contract.wall_milliseconds / 1000) - RETURN_MARGIN_SECONDS
        if (self.db.execute("SELECT 1 FROM calls WHERE operation=?", (operation_key,)).fetchone()
                or self.db.execute("SELECT 1 FROM attempts WHERE operation=?", (operation_key,)).fetchone()):
            raise VerificationError("duplicate live dispatch forbidden")
        with self.db:
            self.db.execute("INSERT INTO attempts VALUES (?)", (operation_key,))
        value = json_object(request)
        count_request = canonical({key: value[key] for key in ("model", "input", "tools", "reasoning", "parallel_tool_calls") if key in value})
        counted = self._post("/v1/responses/input_tokens", count_request)
        count_result = json_object(counted)
        if count_result.get("object") != "response.input_tokens":
            raise VerificationError("unrecognized provider counting receipt; suspend before paid dispatch")
        count = integer(count_result.get("input_tokens"))
        if count > self.contract.input_ceiling:
            raise VerificationError("exact provider input count exceeds reservation; paid generation was not dispatched")
        # Durable evidence precedes the only paid endpoint. Crash here is
        # ambiguous, so neither transport nor broker automatically redispatches.
        with self.db:
            self.db.execute("INSERT INTO calls VALUES (?,?,?,NULL)", (operation_key,
                self.objects.publish(request).digest, self.objects.publish(counted).digest))
        response = self._post("/v1/responses", request)
        with self.db:
            self.db.execute("UPDATE calls SET response=? WHERE operation=?", (self.objects.publish(response).digest, operation_key))
        return response

    def lookup(self, operation_key: str) -> bytes | None:
        # No claim of provider billing deduplication. Local receipts only.
        return None

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                if self._owns_egress:
                    self._egress.close()
                self.db.close()
