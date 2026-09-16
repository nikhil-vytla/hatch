"""Local vNext layout, read-only journal handles, and leased producer append ports."""

from dataclasses import replace
import fcntl
import hashlib
import os
from pathlib import Path
import re
import threading
from typing import Iterator, Mapping, Self

from ..codec import content_ref, decode, encode, references
from ..contracts.annotations import Annotation
from ..contracts.primitives import AccessScope, ArtifactRef, RecordId, RunId
from ..contracts.records import CausalIdentity, Envelope, IntegrityLinkage, ProducerIdentity, ProducerKind, RecordClass, RecordPayload
from ..errors import IncompleteTail, JournalCorruption, LeaseError, VerificationError
from ..verify import VerifiedState, preflight, replay
from ..wire import Authority, COMMIT_MAGIC, FORMAT, FRAME_MAGIC, Frame, MAX_FRAME_BYTES, ZERO_REF, pack_frame, record_digest
from .cas import CAS, CASReader, atomic_file, durable_directory, fsync_directory

DEFAULT_ARTIFACT_ROOT = Path("artifacts-vnext")


def _run_name(run_id: RunId) -> str:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", run_id) is None:
        raise VerificationError("invalid local run ID")
    return run_id


def _read_authority(path: Path) -> Authority:
    try:
        value = decode(path.read_bytes())
    except OSError as error:
        raise VerificationError("missing local authority root") from error
    if not isinstance(value, tuple) or len(value) != 3:
        raise VerificationError("invalid local authority root")
    run_id, scope, entries = value
    if type(run_id) is not str or not isinstance(scope, AccessScope) or not isinstance(entries, tuple):
        raise VerificationError("invalid local authority fields")
    producers: dict[ProducerKind, ProducerIdentity] = {}
    keys: dict[ProducerKind, bytes] = {}
    for entry in entries:
        if not isinstance(entry, tuple) or len(entry) != 2:
            raise VerificationError("invalid append grant")
        producer, key = entry
        if not isinstance(producer, ProducerIdentity) or type(key) is not bytes or producer.kind in producers:
            raise VerificationError("invalid/duplicate append grant")
        producers[producer.kind], keys[producer.kind] = producer, key
    return Authority(RunId(run_id), scope, producers, keys)


class FileJournal:
    def __init__(self, path: Path) -> None:
        self.path = path

    def frames(self) -> Iterator[Frame]:
        try:
            with self.path.open("rb") as stream:
                original = os.fstat(stream.fileno())
                while stream.tell() < original.st_size:
                    offset = stream.tell()
                    header = stream.read(12)
                    if len(header) != 12:
                        raise IncompleteTail(offset)
                    if header[:4] != FRAME_MAGIC:
                        raise JournalCorruption(f"invalid frame header at byte {offset}")
                    length = int.from_bytes(header[4:], "big")
                    if not 0 < length <= MAX_FRAME_BYTES:
                        raise JournalCorruption(f"invalid frame length at byte {offset}")
                    if original.st_size - stream.tell() < length + 40:
                        raise IncompleteTail(offset)
                    body, trailer = stream.read(length), stream.read(40)
                    if len(body) != length or len(trailer) != 40:
                        raise IncompleteTail(offset)
                    if trailer[:32] != hashlib.sha256(body).digest() or trailer[32:] != COMMIT_MAGIC:
                        raise JournalCorruption(f"damaged committed frame at byte {offset}; explicit recovery required")
                    yield Frame.from_bytes(body)
                current = os.fstat(stream.fileno())
                if (original.st_size, original.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
                    raise JournalCorruption("journal changed during verification")
        except OSError as error:
            raise JournalCorruption("missing/unreadable journal") from error


class RunReader:
    """Opening/verifying a run creates no files and acquires no writer lease."""

    def __init__(self, root: Path, run_id: RunId) -> None:
        try:
            if (root / "FORMAT").read_bytes() != FORMAT:
                raise VerificationError("not a vNext artifact root")
        except OSError as error:
            raise VerificationError("missing vNext artifact root") from error
        self.directory = root / "runs" / _run_name(run_id)
        self.objects = CASReader(root / "objects")
        self.authority = _read_authority(self.directory / "authority")
        if self.authority.run_id != run_id:
            raise VerificationError("run directory identity mismatch")
        self.journal = FileJournal(self.directory / "journal")

    def verify(self) -> VerifiedState:
        return replay(self.journal, self.objects, self.authority)


class ArtifactStore:
    def __init__(self, root: Path = DEFAULT_ARTIFACT_ROOT) -> None:
        self.root = root
        if not (root / "FORMAT").exists():
            if root.exists() and any(root.iterdir()):
                raise VerificationError("refusing to reuse a populated/legacy artifact root")
            durable_directory(root)
            durable_directory(root / "objects")
            durable_directory(root / "runs")
            atomic_file(root / "FORMAT", FORMAT)
        if (root / "FORMAT").read_bytes() != FORMAT:
            raise VerificationError("unsupported artifact root format")
        self.objects = CAS(root / "objects")

    def create_run(self, run_id: RunId, scope: AccessScope, producers: Mapping[ProducerKind, ArtifactRef]) -> RunReader:
        identities = {kind: ProducerIdentity(kind, implementation) for kind, implementation in producers.items()}
        authority = Authority(run_id, scope, identities, {kind: os.urandom(32) for kind in producers})
        for reference in {scope.grant, *producers.values()}:
            self.objects.ensure_durable(reference)
        directory = self.root / "runs" / _run_name(run_id)
        directory.mkdir(mode=0o700)  # Exclusive creation; never adopt a partially created run.
        fsync_directory(directory.parent)
        atomic_file(directory / "authority", encode((run_id, scope, tuple((identities[kind], authority.keys[kind]) for kind in sorted(identities)))))
        atomic_file(directory / "epoch", b"0\n")
        atomic_file(directory / "lease", b"")
        atomic_file(directory / "journal", b"")
        return self.reader(run_id)

    def reader(self, run_id: RunId) -> RunReader:
        return RunReader(self.root, run_id)

    def writer(self, run_id: RunId) -> "RunWriter":
        return RunWriter(self.reader(run_id), self.objects)


class _Overlay:
    def __init__(self, objects: CASReader, reference: ArtifactRef, data: bytes) -> None:
        self.objects, self.reference, self.data = objects, reference, data
        self.reads: set[ArtifactRef] = set()

    def read(self, reference: ArtifactRef) -> bytes:
        self.reads.add(reference)
        return self.data if reference == self.reference else self.objects.read(reference)


class ProducerPort:
    """Capability handed only to the pinned producer by trusted setup.

    No producer identity argument is accepted on append. Candidate ports can only
    append annotations; constructing a dataclass confers no authority.
    """

    def __init__(self, writer: "RunWriter", kind: ProducerKind) -> None:
        self._writer, self._kind = writer, kind

    def append(self, payload: RecordPayload, *, causal: CausalIdentity, epoch: int) -> Frame:
        return self._writer._append(self._kind, payload, causal, epoch)


class RunWriter:
    def __init__(self, reader: RunReader, objects: CAS) -> None:
        self.reader, self.objects = reader, objects
        self._closed = True
        self._pid = os.getpid()
        self._mutex = threading.RLock()
        try:
            self._lease = (reader.directory / "lease").open("r+b")
        except OSError as error:
            raise LeaseError("missing writer lease") from error
        try:
            fcntl.flock(self._lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self._lease.close()
            raise LeaseError("run already has a writer") from error
        try:
            state = reader.verify()  # A corrupt history cannot even advance the epoch.
            previous = self._read_epoch()
            if previous < state.epoch:
                raise LeaseError("epoch metadata is older than committed history")
            self.epoch = previous + 1
            atomic_file(reader.directory / "epoch", f"{self.epoch}\n".encode("ascii"), replace=True)
            self._closed = False
        except BaseException:
            self._lease.close()
            raise

    def _read_epoch(self) -> int:
        try:
            data = (self.reader.directory / "epoch").read_bytes()
            if re.fullmatch(rb"(?:0|[1-9][0-9]*)\n", data) is None:
                raise LeaseError("malformed execution epoch")
            return int(data)
        except OSError as error:
            raise LeaseError("missing execution epoch") from error

    def _check_lease(self, epoch: int) -> None:
        if self._closed or self._pid != os.getpid() or epoch != self.epoch or self._read_epoch() != self.epoch:
            raise LeaseError("closed writer or stale execution epoch")
        stat, held = (self.reader.directory / "lease").stat(), os.fstat(self._lease.fileno())
        if (stat.st_dev, stat.st_ino) != (held.st_dev, held.st_ino):
            raise LeaseError("writer lease was replaced")

    def port(self, kind: ProducerKind) -> ProducerPort:
        self._check_lease(self.epoch)
        if kind not in self.reader.authority.producers:
            raise VerificationError("unregistered producer")
        return ProducerPort(self, kind)

    def _append(self, kind: ProducerKind, payload: RecordPayload, causal: CausalIdentity, epoch: int) -> Frame:
        with self._mutex:
            self._check_lease(epoch)
            authority = self.reader.authority
            record_class = RecordClass.ANNOTATION if isinstance(payload, Annotation) else payload.record_class
            authority.check_owner(kind, record_class)
            state = self.reader.verify()  # Fail closed on changed/missing old artifacts too.
            data = encode(payload)
            reference = content_ref(data)
            sequence = len(state.records)
            envelope = Envelope(authority.run_id, sequence, RecordId(f"{authority.run_id}:r{sequence}"), record_class,
                                causal, authority.producers[kind], authority.scope, reference, IntegrityLinkage(state.head, ZERO_REF))
            envelope = replace(envelope, integrity_linkage=IntegrityLinkage(state.head, record_digest(envelope, epoch, kind)))
            frame = authority.sign(epoch, kind, envelope)
            overlay = _Overlay(self.objects, reference, data)
            preflight(state, frame, overlay, authority)  # No writes on validation failure.
            packed = pack_frame(frame)
            self.objects.publish(data)
            for needed in overlay.reads | references(payload):
                self.objects.ensure_durable(needed)
            self._check_lease(epoch)
            try:
                self._commit(packed)
            except BaseException:
                self.close()  # A possibly interrupted append cannot reuse this epoch.
                raise
            return frame

    def _commit(self, packed: bytes) -> None:
        # O_APPEND plus the held lease preserves ordering. Short writes remain a
        # visible incomplete frame. fsync completes before append returns.
        with (self.reader.directory / "journal").open("ab", buffering=0) as stream:
            remaining = memoryview(packed)
            while remaining:
                count = stream.write(remaining)
                if count is None or count <= 0:
                    raise OSError("journal append made no progress")
                remaining = remaining[count:]
            os.fsync(stream.fileno())

    def close(self) -> None:
        with self._mutex:
            if not self._closed:
                self._closed = True
                self._lease.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
