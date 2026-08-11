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
- ``append_batch`` takes an optional ``expected_head`` so a caller can refuse
  to write when the journal advanced since it read.

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
    """A framed-journal read/write failure (unreadable, stale head, empty)."""


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
    entries are honored."""

    entries: tuple[object, ...]
    frames: int
    head: str  # f"{frames}:{last_frame_hash}"
    errors: int  # undecodable, misframed, chain-broken, or unframed lines
    error_detail: tuple[str, ...]
    torn_tail: bool  # a partial final line (crash artifact; tolerated)


def _now_iso() -> str:
    from strive.events import now_iso

    return now_iso()


class FramedJournal:
    """Locked, fsynced, append-only, crash-framed hash-chained stream."""

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
            return FramedView((), 0, self.genesis_head, 0, (), False)
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
        for line in complete:
            if not line.strip():
                continue
            decoded: object | None
            try:
                decoded = codec.loads(line.decode("utf-8"))
            except (codec.SchemaError, UnicodeDecodeError):
                decoded = None
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
        )

    def append_batch(
        self, batch: Sequence[object], expected_head: str | None = None
    ) -> str:
        """Append one crash-framed batch (payload + frame in a single write)
        under the journal lock. ``expected_head`` refuses the append when the
        journal advanced since the caller read it. Returns the new head."""
        if not batch:
            raise FramingError("refusing to append an empty batch")
        with self.locked():
            view = self.read()
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
