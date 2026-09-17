"""Read-only inspection of a complete prefix while a writer keeps appending.

The storage reader remains strict for execution and recovery. Inspection uses
the same frame decoder and pure verifier on the frames already read. A partial
tail is visible in diagnostics, never truncated or treated as committed data.
"""
from collections.abc import Iterator
from pathlib import Path

from ..errors import IncompleteTail, JournalCorruption, VerificationError
from ..store import RunReader
from ..store.journal import FileJournal
from ..verify import VerifiedState, replay
from ..wire import Frame
from .access import authorize


class _Prefix(FileJournal):
    def __init__(self, path: Path, frames: tuple[Frame, ...]) -> None:
        super().__init__(path)
        self._frames = frames

    def frames(self) -> Iterator[Frame]:
        yield from self._frames


class SnapshotReader(RunReader):
    def __init__(self, source: RunReader) -> None:
        authorize(source)
        self.directory, self.objects, self.authority = source.directory, source.objects, source.authority
        frames: list[Frame] = []
        incomplete_tail: int | None = None
        concurrent_change = False
        try:
            frames.extend(source.journal.frames())
        except IncompleteTail as error:
            incomplete_tail = error.offset
        except JournalCorruption as error:
            if str(error) != "journal changed during verification":
                raise
            concurrent_change = True
        self.journal = _Prefix(source.journal.path, tuple(frames))
        self._state = replay(self.journal, self.objects, self.authority)
        if self._state.binding is None:
            raise VerificationError("run setup has not committed")
        self.inspection: dict[str, object] = {"basis": "authenticated complete journal prefix",
            "records": len(self._state.records), "head": self._state.head.digest if self._state.head else None,
            "concurrent_change": concurrent_change, "incomplete_tail_offset": incomplete_tail,
            "tail_note": "partial tail remains on disk; execution requires explicit recovery" if incomplete_tail is not None else None}

    def verify(self) -> VerifiedState:
        return self._state


def snapshot(read: RunReader) -> SnapshotReader:
    return read if isinstance(read, SnapshotReader) else SnapshotReader(read)
