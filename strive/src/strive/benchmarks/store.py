"""Local transactional operations. Mutation functions operate on private copies.

CAS publication precedes the one SQLite receipt/head commit. Reopening requires
an existing complete store; a missing database cannot establish nonexecution.
"""
from collections.abc import Callable
from pathlib import Path
import sqlite3
import threading

from ..codec import encode, references
from ..contracts.primitives import ArtifactRef, EffectId, EnvironmentId, EpisodeId, RunId
from ..errors import VerificationError
from ..store.cas import CAS, durable_directory, fsync_directory
from .api import (EpisodeSnapshot, FoundOperation, LookupResult, OperationContext,
                  OperationReceipt, ProvenAbsent, UnknownOperation)
from .payloads import dumps, loads


def no_fault(point: str) -> None:
    pass


class OperationStore:
    def __init__(self, root: Path, objects: CAS, run: RunId, adapter: ArtifactRef,
                 epoch: int, *, create: bool = False, fault: Callable[[str], None] = no_fault) -> None:
        self.objects, self.run, self.adapter, self.epoch, self.fault = objects, run, adapter, epoch, fault
        self._lock = threading.RLock()
        path = root / "operations.sqlite"
        if not create and not path.is_file():
            raise VerificationError("operation store unavailable; lookup unknown")
        durable_directory(root)
        self.db = sqlite3.connect(path, check_same_thread=False)
        if not create:
            tables = {str(row[0]) for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"identity", "heads", "operations", "absent"} <= tables:
                self.db.close()
                raise VerificationError("incomplete operation store; lookup unknown")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA journal_mode=DELETE")
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), run TEXT, adapter TEXT, epoch INTEGER)")
            self.db.execute("CREATE TABLE IF NOT EXISTS heads (episode TEXT PRIMARY KEY, environment TEXT UNIQUE, version INTEGER, snapshot TEXT)")
            self.db.execute("CREATE TABLE IF NOT EXISTS operations (effect TEXT PRIMARY KEY, episode TEXT, request TEXT, receipt TEXT, authorization TEXT, version INTEGER, UNIQUE(episode,version))")
            self.db.execute("CREATE TABLE IF NOT EXISTS absent (effect TEXT PRIMARY KEY, episode TEXT, request TEXT)")
            row = self.db.execute("SELECT run,adapter,epoch FROM identity WHERE singleton=1").fetchone()
            if row is None:
                if not create:
                    raise VerificationError("incomplete operation store")
                self.db.execute("INSERT INTO identity VALUES(1,?,?,?)", (run, adapter.digest, epoch))
            elif row[0] != run or row[1] != adapter.digest or epoch < row[2]:
                raise VerificationError("operation store identity or epoch mismatch")
            else:
                self.db.execute("UPDATE identity SET epoch=? WHERE singleton=1", (epoch,))
        fsync_directory(root)

    def _fence(self) -> None:
        row = self.db.execute("SELECT run,adapter,epoch FROM identity WHERE singleton=1").fetchone()
        if row != (self.run, self.adapter.digest, self.epoch):
            raise VerificationError("stale operation-store epoch")

    def _verify(self, receipt: OperationReceipt, episode: EpisodeId, effect: EffectId,
                request: ArtifactRef) -> None:
        if (receipt.effect_id != effect or receipt.exact_request != request
                or receipt.after.episode != episode or receipt.original_epoch > self.epoch):
            raise VerificationError("operation receipt identity mismatch")
        for ref in references(receipt):
            self.objects.read(ref)
        rows = self.db.execute("SELECT receipt,authorization,version FROM operations WHERE episode=? ORDER BY version", (episode,)).fetchall()
        previous: EpisodeSnapshot | None = None
        matched = False
        for row in rows:
            current = loads(self.objects.read(ArtifactRef(str(row[0]))), OperationReceipt)
            from ..codec import decode
            from ..contracts.records import EffectAuthorization
            auth = decode(self.objects.read(ArtifactRef(str(row[1]))))
            if (not isinstance(auth, EffectAuthorization) or auth.adapter != self.adapter
                    or auth.permitted_scope.run_id != self.run or auth.effect_id != current.effect_id
                    or auth.execution_epoch != current.original_epoch or auth.target_environment != current.after.environment
                    or auth.exact_request_reference != current.exact_request or current.after.episode != episode
                    or current.before != previous or current.after.version != int(row[2])
                    or current.after.version != (previous.version + 1 if previous else 0)
                    or previous is not None and previous.environment != current.after.environment):
                raise VerificationError("operation state chain/authorization mismatch")
            for ref in references(current):
                self.objects.read(ref)
            previous = current.after
            if current == receipt:
                matched = True
        head = self.head(episode)
        if not matched or previous != head:
            raise VerificationError("receipt detached from committed environment head")

    def head(self, episode: EpisodeId) -> EpisodeSnapshot | None:
        row = self.db.execute("SELECT environment,version,snapshot FROM heads WHERE episode=?", (episode,)).fetchone()
        if row is None:
            return None
        snapshot = loads(self.objects.read(ArtifactRef(str(row[2]))), EpisodeSnapshot)
        if snapshot.episode != episode or snapshot.environment != row[0] or snapshot.version != row[1]:
            raise VerificationError("environment head identity mismatch")
        self.objects.read(snapshot.state)
        return snapshot

    def open(self, snapshot: EpisodeSnapshot) -> bytes:
        with self._lock:
            self._fence()
            if self.head(snapshot.episode) != snapshot:
                raise VerificationError("snapshot is not the committed head; rewind forbidden")
            return self.objects.read(snapshot.state)

    def commit(self, context: OperationContext, mutate: Callable[[bytes | None], tuple[bytes, bytes]]) -> OperationReceipt:
        auth = context.authorization
        if (auth.adapter != self.adapter or auth.permitted_scope.run_id != self.run
                or auth.execution_epoch != self.epoch):
            raise VerificationError("unauthorized operation or stale epoch")
        with self._lock, self.db:
            self.db.execute("BEGIN IMMEDIATE")
            self._fence()
            row = self.db.execute("SELECT episode,request,receipt FROM operations WHERE effect=?", (auth.effect_id,)).fetchone()
            if row is not None:
                if row[:2] != (context.episode, auth.exact_request_reference.digest):
                    raise VerificationError("operation identity reused with different request/episode")
                result = loads(self.objects.read(ArtifactRef(str(row[2]))), OperationReceipt)
                if result.arguments != context.arguments or result.before != context.expected_snapshot:
                    raise VerificationError("operation context differs from original")
                self._verify(result, context.episode, auth.effect_id, auth.exact_request_reference)
                return result
            if self.db.execute("SELECT 1 FROM absent WHERE effect=?", (auth.effect_id,)).fetchone():
                raise VerificationError("operation fenced by absence proof")
            before = self.head(context.episode)
            if before != context.expected_snapshot or before is not None and before.environment != auth.target_environment:
                raise VerificationError("stale/wrong expected environment")
            state, output = mutate(self.objects.read(before.state) if before else None)
            after = EpisodeSnapshot(context.episode, EnvironmentId(auth.target_environment),
                                    before.version + 1 if before else 0, self.objects.publish(state))
            evidence = self.objects.publish(encode(("operation-commit/1", self.run, self.adapter, auth,
                                                    context.episode, context.arguments)))
            result = OperationReceipt(auth.effect_id, auth.execution_epoch, auth.exact_request_reference,
                                      context.arguments, before, after, self.objects.publish(output), evidence)
            for ref in references(result):
                self.objects.ensure_durable(ref)
            receipt_ref = self.objects.publish(dumps(result))
            snapshot_ref = self.objects.publish(dumps(after))
            auth_ref = self.objects.publish(encode(auth))
            self.fault("before-commit")
            self.db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?)", (auth.effect_id, context.episode,
                            auth.exact_request_reference.digest, receipt_ref.digest, auth_ref.digest, after.version))
            self.db.execute("INSERT INTO heads VALUES(?,?,?,?) ON CONFLICT(episode) DO UPDATE SET version=excluded.version,snapshot=excluded.snapshot",
                            (context.episode, after.environment, after.version, snapshot_ref.digest))
        self.fault("after-commit")
        return result

    def lookup(self, episode: EpisodeId, effect: EffectId, request: ArtifactRef) -> LookupResult:
        try:
            with self._lock, self.db:
                self.db.execute("BEGIN IMMEDIATE")
                self._fence()
                row = self.db.execute("SELECT episode,request,receipt FROM operations WHERE effect=?", (effect,)).fetchone()
                if row is None:
                    for head_row in self.db.execute("SELECT episode FROM heads").fetchall():
                        last = self.db.execute("SELECT receipt FROM operations WHERE episode=? ORDER BY version DESC LIMIT 1", (head_row[0],)).fetchone()
                        if last is None:
                            raise VerificationError("incomplete operation history")
                        last_receipt = loads(self.objects.read(ArtifactRef(str(last[0]))), OperationReceipt)
                        self._verify(last_receipt, EpisodeId(str(head_row[0])), last_receipt.effect_id, last_receipt.exact_request)
                    prior = self.db.execute("SELECT episode,request FROM absent WHERE effect=?", (effect,)).fetchone()
                    if prior is not None and prior != (episode, request.digest):
                        raise VerificationError("absence identity mismatch")
                    self.objects.read(request)
                    self.db.execute("INSERT OR IGNORE INTO absent VALUES(?,?,?)", (effect, episode, request.digest))
                    proof = self.objects.publish(encode(("fenced-absence/1", self.run, self.adapter, self.epoch, episode, effect, request)))
                    return ProvenAbsent(proof)
                if row[:2] != (episode, request.digest):
                    raise VerificationError("lookup request/episode mismatch")
                result = loads(self.objects.read(ArtifactRef(str(row[2]))), OperationReceipt)
                self._verify(result, episode, effect, request)
                return FoundOperation(result)
        except (VerificationError, sqlite3.Error, OSError) as error:
            return UnknownOperation(self.objects.publish(encode(("lookup-unknown/1", str(error)))))

    def close(self) -> None:
        self.db.close()
