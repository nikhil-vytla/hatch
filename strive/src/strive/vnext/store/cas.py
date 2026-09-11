"""Immutable SHA-256 objects. Data and directory entries precede references."""

import os
from pathlib import Path
import tempfile

from ..codec import content_ref
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_directory(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise VerificationError(f"not a directory: {path}")
        return
    durable_directory(path.parent)
    path.mkdir(mode=0o700)
    fsync_directory(path)
    fsync_directory(path.parent)


def atomic_file(path: Path, data: bytes, *, replace: bool = False) -> None:
    """Publish a fully synced inode, then sync its containing directory."""
    descriptor, temporary = tempfile.mkstemp(prefix=".publish-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
        fsync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)
        fsync_directory(path.parent)


class CASReader:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def path(self, reference: ArtifactRef) -> Path:
        return self.directory / reference.digest.removeprefix("sha256:")

    def read(self, reference: ArtifactRef) -> bytes:
        try:
            data = self.path(reference).read_bytes()
        except OSError as error:
            raise VerificationError(f"missing/unreadable artifact {reference.digest}") from error
        if content_ref(data) != reference:
            raise VerificationError(f"corrupted artifact {reference.digest}")
        return data


class CAS(CASReader):
    def publish(self, data: bytes) -> ArtifactRef:
        reference = content_ref(data)
        if self.path(reference).exists():
            self.read(reference)
        else:
            try:
                atomic_file(self.path(reference), data)
            except FileExistsError:
                self.read(reference)
        self.ensure_durable(reference)
        return reference

    def ensure_durable(self, reference: ArtifactRef) -> None:
        self.read(reference)
        with self.path(reference).open("rb") as stream:
            os.fsync(stream.fileno())
        fsync_directory(self.directory)
