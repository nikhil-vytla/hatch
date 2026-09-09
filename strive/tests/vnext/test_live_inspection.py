"""Live inspection tolerates appends without weakening the execution reader."""
from collections.abc import Iterator
from pathlib import Path

import pytest

from strive.vnext.cli import app
from strive.vnext.cli.data import mapping
from strive.vnext.cli.fixture import example
from strive.vnext.cli.runner import reader, run, run_directory
from strive.vnext.contracts.annotations import Annotation
from strive.vnext.contracts.records import CausalIdentity, ProducerKind
from strive.vnext.errors import IncompleteTail, JournalCorruption
from strive.vnext.report.snapshot import snapshot
from strive.vnext.store import ArtifactStore
from strive.vnext.store.journal import FileJournal
from strive.vnext.telemetry.projector import MemoryExporter, Projector
from strive.vnext.wire import Frame


def test_live_follow_and_projector_use_verified_complete_prefix(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "live", dispatch=False, display=lambda _: None)
    read = reader(root, "live")
    previous = read.verify()
    last = previous.records[-1].envelope
    store = ArtifactStore(run_directory(root, "live") / "artifacts")
    with store.writer(read.authority.run_id) as writer:
        class RacingJournal(FileJournal):
            appended = False
            def frames(self) -> Iterator[Frame]:
                for frame in super().frames():
                    yield frame
                    if frame.envelope.sequence == last.sequence and not self.appended:
                        self.appended = True
                        writer.port(ProducerKind.OPERATOR).append(Annotation("test.concurrent", b"{}"),
                            causal=CausalIdentity(last.record_id, None, None, None), epoch=writer.epoch)
        read.journal = RacingJournal(read.journal.path)
        monkeypatch.setattr(app, "reader", lambda _root, _run_id: read)
        follow = app.status(root, "live", follow=True, interval=0, updates=2)
        first = next(follow)
        assert mapping(first["inspection"])["concurrent_change"] is True
        assert mapping(first["inspection"])["records"] == len(previous.records)
        second = next(follow)
        assert mapping(second["inspection"])["concurrent_change"] is False
        assert mapping(second["inspection"])["records"] == len(previous.records) + 1
        exporter = MemoryExporter()
        projector = Projector(read, tmp_path / "cursor.json", exporter)
        last = read.verify().records[-1].envelope
        read.journal = RacingJournal(read.journal.path)
        projection = projector.flush()
        assert projection["cursor"] == len(previous.records) + 1
        assert reader(root, "live").verify().head != previous.head
        journal = read.journal.path.read_bytes()
        assert projector.flush()["cursor"] == len(previous.records) + 2
        assert read.journal.path.read_bytes() == journal
        assert reader(root, "live").verify().head == read.verify().head


def test_partial_tail_visible_but_committed_corruption_rejected(tmp_path: Path) -> None:
    path = example(tmp_path)
    root = tmp_path / "state"
    run(root, path, "live", dispatch=False, display=lambda _: None)
    read = reader(root, "live")
    previous = read.verify()
    complete = read.journal.path.read_bytes()
    read.journal.path.write_bytes(complete + b"partial")
    with pytest.raises(IncompleteTail):
        read.verify()
    captured = snapshot(read)
    assert captured.verify().head == previous.head
    assert captured.inspection["incomplete_tail_offset"] == len(complete)
    assert read.journal.path.read_bytes() == complete + b"partial"
    damaged = bytearray(complete)
    damaged[-40] ^= 1
    read.journal.path.write_bytes(damaged)
    with pytest.raises(JournalCorruption, match="damaged committed frame"):
        snapshot(read)
