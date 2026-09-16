"""Durable, one-dispatch gateway. Its SQLite index is trusted local spool state.

Request/response bytes live in M2 CAS. FULL synchronous transactions publish
references only after CAS fsync. An attempted forward burns the capability before
calling the supervisor and upstream, including when either crashes.
"""
from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from ..codec import encode
from ..contracts.harness import ExecutionContext, PreparedGeneration
from ..contracts.primitives import ArtifactRef, RequestedModelIdentity, WireModelIdentity, ObservedModelIdentity
from ..errors import VerificationError
from ..store.cas import CAS, durable_directory, fsync_directory
from .deadline import upstream_deadline
from .provider import ProviderContract, Upstream, json_object


def no_fault(point: str) -> None:
    pass


@dataclass(frozen=True)
class Spool:
    effect: str
    epoch: int
    state: str
    prepared: ArtifactRef
    wire: ArtifactRef | None
    response: ArtifactRef | None
    returned: ArtifactRef | None
    denied: bool


class ModelGateway:
    def __init__(self, root: Path, objects: CAS, contract: ProviderContract, upstream: Upstream,
                 fault: Callable[[str], None] = no_fault) -> None:
        durable_directory(root)
        self.objects, self.contract, self.upstream, self.fault = objects, contract, upstream, fault
        self.bound = objects.publish(contract.retained())
        implementations = tuple(objects.publish(Path(__file__).with_name(name).read_bytes())
                                for name in ("gateway.py", "provider.py", "http_gateway.py"))
        self.identity = objects.publish(encode(("model-gateway/1", self.bound, implementations)))
        self._lock = threading.RLock()
        self._db = sqlite3.connect(root / "spool.sqlite", check_same_thread=False)
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA journal_mode=DELETE")
        self._db.execute("CREATE TABLE IF NOT EXISTS spool (effect TEXT PRIMARY KEY, epoch INTEGER NOT NULL, state TEXT NOT NULL, prepared TEXT NOT NULL, wire TEXT, response TEXT, returned TEXT, denied INTEGER NOT NULL, token TEXT NOT NULL, expires REAL NOT NULL, gateway TEXT NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS events (effect TEXT, kind TEXT, reference TEXT)")
        self._db.execute("CREATE TABLE IF NOT EXISTS stops (run TEXT PRIMARY KEY, reason TEXT NOT NULL)")
        self._db.commit()
        fsync_directory(root)

    @staticmethod
    def key(context: ExecutionContext) -> str:
        return hashlib.sha256(encode((context.run_id, context.effect_id))).hexdigest()

    def issue(self, prepared: PreparedGeneration) -> str:
        if prepared.reservation_requirements != self.contract.reservation(self.bound):
            raise VerificationError("gateway bound differs from authorized generation")
        context = prepared.execution_context
        token = secrets.token_urlsafe(32)
        reference = self.objects.publish(encode(prepared))
        with self._lock, self._db:
            try:
                self._db.execute("INSERT INTO spool VALUES (?, ?, 'launch', ?, NULL, NULL, NULL, 0, ?, ?, ?)",
                    (self.key(context), context.epoch, reference.digest, hashlib.sha256(token.encode()).hexdigest(),
                     time.time() + min(prepared.deadline_seconds, 300), self.identity.digest))
            except sqlite3.IntegrityError as error:
                raise VerificationError("effect already has a capability; recovery cannot mint another") from error
        return token

    def read(self, context: ExecutionContext) -> Spool | None:
        with self._lock:
            row = self._db.execute("SELECT effect,epoch,state,prepared,wire,response,returned,denied,gateway FROM spool WHERE effect=?", (self.key(context),)).fetchone()
        if row is None:
            return None
        if row[8] != self.identity.digest:
            raise VerificationError("gateway/provider contract changed on recovery")
        return Spool(str(row[0]), int(row[1]), str(row[2]), ArtifactRef(row[3]),
                     ArtifactRef(row[4]) if row[4] else None, ArtifactRef(row[5]) if row[5] else None,
                     ArtifactRef(row[6]) if row[6] else None, bool(row[7]))

    def deny(self, context: ExecutionContext) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE spool SET denied=1,token='',expires=0 WHERE effect=?", (self.key(context),))

    def revoke(self, context: ExecutionContext) -> ArtifactRef:
        with self._lock, self._db:
            self._db.execute("UPDATE spool SET token='',expires=0 WHERE effect=?", (self.key(context),))
        return self.objects.publish(encode(("revoked", context)))

    def prove_no_dispatch(self, context: ExecutionContext, unlaunched: PreparedGeneration | None = None) -> ArtifactRef | None:
        # This check and revocation are atomic with competing attempts, including
        # other gateway connections. Missing index state is not nonexecution proof.
        with self._lock, self._db:
            self._db.execute("BEGIN IMMEDIATE")
            state = self.read(context)
            if state is None and unlaunched is not None:
                if unlaunched.execution_context != context:
                    raise VerificationError("unlaunched proof context mismatch")
                prepared_ref = self.objects.publish(encode(unlaunched))
                self._db.execute("INSERT INTO spool VALUES (?, ?, 'revoked', ?, NULL, NULL, NULL, 0, '', 0, ?)",
                                 (self.key(context), context.epoch, prepared_ref.digest, self.identity.digest))
                state = self.read(context)
            if (state is None or state.epoch != context.epoch or
                    state.state not in ({"launch", "revoked", "wire"} if unlaunched is not None else {"launch", "revoked"})):
                return None
            self._db.execute("UPDATE spool SET token='',state='revoked' WHERE effect=?", (self.key(context),))
        return self.objects.publish(encode(("no-upstream", context, state.prepared)))

    def dispatch(self, context: ExecutionContext, token: str, raw: bytes,
                 forward: Callable[[bytes, Callable[[bytes], bytes]], bytes]) -> bytes:
        validation_error: Exception | None = None
        try:
            self.contract.validate(raw)
        except Exception as error:
            validation_error = error
        reference = self.objects.publish(raw) if validation_error is None else None
        with self._lock, self._db:
            self._db.execute("BEGIN IMMEDIATE")
            row = self._db.execute("SELECT epoch,state,token,expires FROM spool WHERE effect=?", (self.key(context),)).fetchone()
            if (row is None or row[0] != context.epoch or row[1] != "launch" or
                    not secrets.compare_digest(row[2], hashlib.sha256(token.encode()).hexdigest()) or row[3] < time.time()):
                raise VerificationError("stale, expired, revoked or spent capability")
            self._db.execute("UPDATE spool SET token='',state=?,wire=?,denied=? WHERE effect=?",
                ("wire" if reference else "launch", reference.digest if reference else None,
                 int(validation_error is not None), self.key(context)))
        if validation_error is not None:
            raise validation_error
        self.fault("wire-retained")

        def send(request: bytes) -> bytes:
            with self._lock, self._db:
                self._db.execute("BEGIN IMMEDIATE")
                row = self._db.execute("SELECT state,expires FROM spool WHERE effect=?", (self.key(context),)).fetchone()
                if row is None or row[0] != "wire" or row[1] <= time.time():
                    raise VerificationError("cancelled or expired before upstream send")
                self._db.execute("UPDATE spool SET state='forward' WHERE effect=?", (self.key(context),))
            self.fault("upstream-before-send")
            # Include harness startup and counting in the existing generation
            # deadline. The trusted parent owns both this call and the network.
            deadline = time.monotonic() + max(0, row[1] - time.time())
            deadline_token = upstream_deadline.set(deadline)
            try:
                response = self.upstream.generate(request, self.key(context))
            finally:
                upstream_deadline.reset(deadline_token)
            self.fault("upstream-return-before-spool")
            self.capture(context, response)
            self.fault("response-spooled")
            return response
        return forward(raw, send)

    def capture(self, context: ExecutionContext, raw: bytes) -> ArtifactRef:
        if len(raw) > self.contract.max_response_bytes:
            raise VerificationError("provider response quota exceeded")
        reference = self.objects.publish(raw)
        with self._lock, self._db:
            prior = self.read(context)
            if prior is None or prior.epoch != context.epoch or prior.state not in {"forward", "response"}:
                raise VerificationError("response has no upstream dispatch evidence")
            if prior.response is not None and prior.response != reference:
                raise VerificationError("provider lookup changed recorded response")
            self._db.execute("UPDATE spool SET state='response',response=?,token='' WHERE effect=?", (reference.digest, self.key(context)))
        return reference

    def recover_response(self, context: ExecutionContext) -> ArtifactRef | None:
        state = self.read(context)
        if state is None:
            return None
        if state.response is not None:
            self.objects.read(state.response)
            return state.response
        if state.state in {"wire", "forward"} and self.contract.verified_lookup:
            raw = self.upstream.lookup(self.key(context))
            if raw is not None:
                return self.capture(context, raw)
        return None

    def record_return(self, context: ExecutionContext, reference: ArtifactRef) -> None:
        self.objects.read(reference)
        with self._lock, self._db:
            state = self.read(context)
            if state is None or state.response is None:
                raise VerificationError("harness output without durable provider response")
            if state.returned is not None and state.returned != reference:
                raise VerificationError("harness return already recorded")
            self._db.execute("UPDATE spool SET returned=?,token='' WHERE effect=?", (reference.digest, self.key(context)))
        self.fault("harness-return-recorded")

    def identity_evidence(self, context: ExecutionContext, native_identifier: str | None = None) -> bytes:
        state = self.read(context)
        if state is None or state.response is None or state.wire is None:
            raise VerificationError("model identity lacks wire/response evidence")
        response = json_object(self.objects.read(state.response))
        wire_model = json_object(self.objects.read(state.wire)).get("model")
        observed = response.get("model")
        assert isinstance(wire_model, str)
        return encode(("gateway-model-identities/1",
                       RequestedModelIdentity(self.contract.provider, self.contract.model, native_identifier),
                       WireModelIdentity(self.contract.endpoint, wire_model),
                       ObservedModelIdentity(observed, None, "provider.response.model", state.response)
                       if isinstance(observed, str) else None,
                       response.get("id"), state.prepared, state.wire, state.response, self.identity))


    def stop(self, context: ExecutionContext, reason: str) -> None:
        reference = self.objects.publish(encode((context, reason)))
        with self._lock, self._db:
            self._db.execute("INSERT OR IGNORE INTO stops VALUES (?, ?)", (context.run_id, reference.digest))

    def stop_reason(self, run: str) -> str | None:
        from ..codec import decode
        with self._lock:
            row = self._db.execute("SELECT reason FROM stops WHERE run=?", (run,)).fetchone()
        if row is None:
            return None
        value = decode(self.objects.read(ArtifactRef(row[0])))
        if not isinstance(value, tuple) or len(value) != 2 or not isinstance(value[1], str):
            raise VerificationError("invalid durable gateway stop")
        return value[1]

    def event(self, context: ExecutionContext, kind: str, reference: ArtifactRef) -> None:
        self.objects.read(reference)
        with self._lock, self._db:
            self._db.execute("INSERT INTO events VALUES (?, ?, ?)", (self.key(context), kind, reference.digest))

    def events(self, context: ExecutionContext, kind: str) -> tuple[ArtifactRef, ...]:
        with self._lock:
            rows = self._db.execute("SELECT reference FROM events WHERE effect=? AND kind=?", (self.key(context), kind)).fetchall()
        return tuple(ArtifactRef(row[0]) for row in rows)

    def close(self) -> None:
        with self._lock:
            self._db.close()
