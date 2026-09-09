"""Reproduce a legitimate append racing with a read-only M2 journal fold."""
from pathlib import Path
from collections.abc import Iterator

from strive.vnext.cli.fixture import example
from strive.vnext.cli.runner import run, reader, run_directory
from strive.vnext.contracts.annotations import Annotation
from strive.vnext.contracts.records import CausalIdentity, ProducerKind
from strive.vnext.errors import JournalCorruption
from strive.vnext.store import ArtifactStore
from strive.vnext.store.journal import FileJournal
from strive.vnext.wire import Frame


def main() -> None:
    folder = Path(__file__).resolve().parent / ".smoke-reader"
    path = example(folder)
    root = folder / "state"
    run(root, path, "probe", dispatch=False, display=lambda _: None)
    read = reader(root, "probe")
    last = read.verify().records[-1].envelope
    store = ArtifactStore(run_directory(root, "probe") / "artifacts")
    with store.writer(read.authority.run_id) as writer:
        class RacingJournal(FileJournal):
            def frames(self) -> Iterator[Frame]:
                for frame in super().frames():
                    yield frame
                    if frame.envelope.sequence == last.sequence:
                        writer.port(ProducerKind.OPERATOR).append(Annotation("probe.concurrent", b"{}"),
                            causal=CausalIdentity(last.record_id, None, None, None), epoch=writer.epoch)
        read.journal = RacingJournal(read.journal.path)
        try:
            read.verify()
        except JournalCorruption as error:
            assert "changed during verification" in str(error)
            print("Confirmed: a legitimate concurrent append rejects an ordinary file-backed fold.")
        else:
            raise AssertionError("expected the immutable-read guard")


if __name__ == "__main__":
    main()
