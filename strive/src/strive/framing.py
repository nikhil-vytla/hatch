"""Shared crash-framed, hash-chained append-only journal.

Both the Stage-3B.2 reader control/evidence stream and the Stage-3B.3 native
revision lifecycle need the same durability and tamper-evidence guarantees:

- one write syscall per batch (payload lines + a closing frame), fsynced;
- a ``FramedBatch`` frame closes each batch with the sha256 of its exact
  serialized payload bytes and the hash of the previous frame line, forming a
  hash chain from a fixed genesis — deletion, reordering, truncation, and
  unframed appended forgeries all break verification;
- only correctly framed, correctly chained, task-bound entries are honored;
  everything after the first broken frame is untrusted, and complete lines
  with no closing frame (a crash artifact or a forged append) are counted as
  errors and never honored;
- entry payloads are type-validated BEFORE writing, and ``append_batch``
  REFUSES to write over an unverified region (errors, unframed lines, or a
  torn tail): recovery goes through ``repair_to_verified``, which preserves
  the full original bytes at a quarantine path (the durable intent) and then
  truncates the journal to the last verified frame boundary — idempotent
  across a crash between the two steps;
- ``append_batch`` takes an optional ``expected_head`` so a caller can refuse
  to write when the journal advanced since it read.

The hash chain is **tamper-evident, not tamper-proof**: any same-UID process
(including sandboxed candidate code under the current subprocess sandbox)
can read the journal and recompute a full forged chain. The chain detects
naive tampering, deletion, reordering, and crash damage; it is not a
security boundary against a reader-aware attacker — that requires host
confinement or a mediating process, which is why lifecycle/canary authority
is refused for unsafe model-generated code.

A single frame record (``framed-batch@1``) is shared by every framed journal;
each journal supplies its own genesis label so streams cannot be confused.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

from strive import codec
from strive.codec import register


class FramingError(Exception):
    """A framed-journal read/write failure (unreadable, stale head, dirty
    unverified region, invalid entry type, or empty batch)."""


class LegacyFramingError(FramingError):
    """The journal was written by an earlier framing format and must be
    migrated before it can be read or appended to."""


@register("framed-batch", 1)
@dataclass(frozen=True)
class FramedBatch:
    """The crash-framing + hash-chain record closing one appended batch."""

    task_id: str
    stream: str  # the journal's genesis label — streams never cross
    seq: int
    prev: str  # hash of the previous frame line (genesis for the first)
    payload_hash: str  # sha256 of the batch's serialized entry lines
    count: int
    at: str


@dataclass(frozen=True)
class FramedView:
    """One verified parse: only correctly framed, chained, task/stream-bound
    entries are honored. ``verified_offset`` is the byte offset just past the
    last valid frame line — everything after it is the unverified region."""

    entries: tuple[object, ...]
    frames: int
    head: str  # f"{frames}:{last_frame_hash}"
    errors: int  # undecodable, misframed, chain-broken, or unframed lines
    error_detail: tuple[str, ...]
    torn_tail: bool  # a partial final line (crash artifact)
    verified_offset: int  # bytes through the last verified frame boundary

    @property
    def clean(self) -> bool:
        return self.errors == 0 and not self.torn_tail


def _now_iso() -> str:
    from strive.events import now_iso

    return now_iso()


class FramedJournal:
    """Locked, fsynced, append-only, crash-framed hash-chained stream."""

    # subclasses list frame schemas from earlier formats so a pre-migration
    # journal fails LOUDLY with migration guidance instead of parsing as
    # generic corruption
    legacy_frame_schemas: tuple[str, ...] = ()

    def __init__(
        self,
        path: Path,
        task_id: str,
        stream: str,
        entry_types: tuple[type, ...],
    ) -> None:
        self.path = path
        self.task_id = task_id
        self.stream = stream
        self._entry_types = entry_types
        self._genesis = hashlib.sha256(
            f"strive-framed-genesis:{stream}".encode("utf-8")
        ).hexdigest()
        self._lock_path = path.with_suffix(".lock")
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def genesis_head(self) -> str:
        return f"0:{self._genesis}"

    @contextmanager
    def locked(self) -> Iterator[None]:
        with self._lock_path.open("a") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def read(self) -> FramedView:
        if not self.path.exists():
            return FramedView((), 0, self.genesis_head, 0, (), False, 0)
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise FramingError(f"{self.path}: unreadable journal: {exc}") from None
        torn_tail = bool(raw) and not raw.endswith(b"\n")
        lines = raw.split(b"\n")
        complete = lines[:-1]  # the final element is "" or a torn fragment
        entries: list[object] = []
        errors = 0
        detail: list[str] = []
        buffer_bytes = b""
        buffer_entries: list[object | None] = []
        frames = 0
        last_hash = self._genesis
        chain_ok = True
        offset = 0  # bytes consumed through the current line
        verified_offset = 0
        for line in complete:
            offset += len(line) + 1  # the line plus its newline
            if not line.strip():
                continue
            decoded: object | None
            try:
                decoded = codec.loads(line.decode("utf-8"))
            except (codec.SchemaError, UnicodeDecodeError):
                decoded = None
                self._check_legacy_line(line)
            if isinstance(decoded, FramedBatch):
                expected = hashlib.sha256(buffer_bytes).hexdigest()
                if (
                    not chain_ok
                    or decoded.task_id != self.task_id
                    or decoded.stream != self.stream
                    or decoded.seq != frames + 1
                    or decoded.prev != last_hash
                    or decoded.payload_hash != expected
                    or decoded.count != len(buffer_entries)
                    or any(e is None for e in buffer_entries)
                ):
                    errors += 1 + len(buffer_entries)
                    detail.append(
                        f"frame seq {decoded.seq} failed verification "
                        "(chain/payload/task/stream mismatch)"
                    )
                    chain_ok = False  # everything after a break is untrusted
                else:
                    entries.extend(e for e in buffer_entries if e is not None)
                    frames += 1
                    last_hash = hashlib.sha256(line).hexdigest()
                    verified_offset = offset
                buffer_bytes = b""
                buffer_entries = []
            else:
                buffer_bytes += line + b"\n"
                buffer_entries.append(
                    decoded if isinstance(decoded, self._entry_types) else None
                )
        if buffer_entries:
            # complete lines with no closing frame: a crash artifact or a
            # forged append — never honored, always counted (fail closed)
            errors += len(buffer_entries)
            detail.append(f"{len(buffer_entries)} unframed trailing line(s)")
        return FramedView(
            entries=tuple(entries),
            frames=frames,
            head=f"{frames}:{last_hash}",
            errors=errors,
            error_detail=tuple(detail),
            torn_tail=torn_tail,
            verified_offset=verified_offset,
        )

    def _check_legacy_line(self, line: bytes) -> None:
        if not self.legacy_frame_schemas:
            return
        import json

        try:
            parsed = json.loads(line.decode("utf-8", errors="replace"))
        except ValueError:
            return
        if isinstance(parsed, dict) and parsed.get("schema") in self.legacy_frame_schemas:
            raise LegacyFramingError(
                f"{self.path}: journal uses the legacy frame schema "
                f"{parsed.get('schema')!r}; migrate it (run `strive migrate`) "
                "before reading or appending"
            )

    def append_batch(
        self, batch: Sequence[object], expected_head: str | None = None
    ) -> str:
        """Append one crash-framed batch (payload + frame in a single write)
        under the journal lock. Refuses to write when any entry is not a
        registered entry type for this stream, when ``expected_head`` does
        not match, or when the journal has an UNVERIFIED region (errors,
        unframed lines, or a torn tail) — recover with ``repair_to_verified``
        first. Returns the new head."""
        if not batch:
            raise FramingError("refusing to append an empty batch")
        for entry in batch:  # validate entry types BEFORE writing
            if not isinstance(entry, self._entry_types):
                raise FramingError(
                    f"{type(entry).__name__} is not a valid entry type for "
                    f"stream {self.stream!r}"
                )
        with self.locked():
            view = self.read()
            if not view.clean:
                raise FramingError(
                    f"{self.path}: refusing to append over an unverified "
                    f"region ({view.errors} bad line(s)"
                    + (", torn tail" if view.torn_tail else "")
                    + "); run repair_to_verified to quarantine and truncate "
                    "to the last verified boundary"
                )
            if expected_head is not None and view.head != expected_head:
                raise FramingError(
                    f"journal advanced: write authorized at head "
                    f"{expected_head.split(':')[0]} but the journal is at "
                    f"{view.head.split(':')[0]}; re-read and retry"
                )
            payload = "".join(codec.dumps(e) + "\n" for e in batch).encode("utf-8")
            frame = FramedBatch(
                task_id=self.task_id,
                stream=self.stream,
                seq=view.frames + 1,
                prev=view.head.split(":", 1)[1],
                payload_hash=hashlib.sha256(payload).hexdigest(),
                count=len(batch),
                at=_now_iso(),
            )
            frame_bytes = codec.dumps(frame).encode("utf-8")
            with self.path.open("ab") as handle:
                handle.write(payload + frame_bytes + b"\n")  # one write: framed
                handle.flush()
                os.fsync(handle.fileno())
            # the head hashes the frame line WITHOUT its trailing newline, so
            # a writer's returned head equals a subsequent reader's head
            return f"{frame.seq}:{hashlib.sha256(frame_bytes).hexdigest()}"

    def repair_to_verified(self, reason: str) -> str | None:
        """Recover a journal with an unverified region: preserve the FULL
        original bytes at a quarantine path (the durable intent — written and
        fsynced before anything is removed), then truncate the journal to the
        last verified frame boundary. Idempotent: a crash between quarantine
        and truncation just repeats both steps; a clean journal is a no-op.
        Returns the quarantine path, or None when nothing needed repair."""
        with self.locked():
            view = self.read()
            if view.clean:
                return None
            raw = self.path.read_bytes()
            quarantine = self.path.with_name(
                self.path.name + f".quarantine-{_now_iso().replace(':', '')}"
            )
            quarantine.write_bytes(raw)  # byte-for-byte preservation FIRST
            with quarantine.open("rb") as handle:
                os.fsync(handle.fileno())
            with self.path.open("r+b") as handle:
                handle.truncate(view.verified_offset)
                handle.flush()
                os.fsync(handle.fileno())
            return str(quarantine)
