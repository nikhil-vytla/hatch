"""Content-addressed storage.

Objects live at ``objects/<sha256[:2]>/<sha256>`` and are verified against
their address on every read, so tampering or corruption is detected loudly
rather than silently served. Refs are validated as canonical sha256 digests
(64 lowercase hex chars) before they ever touch the filesystem, so a ref can
never traverse out of the store. Publication is concurrent-writer safe: each
writer stages into its OWN unique temp file, fsyncs the bytes, then does one
atomic ``os.replace`` and fsyncs the shard directory.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path

_REF_RE = re.compile(r"^[0-9a-f]{64}$")


class ObjectCorruption(Exception):
    """Stored bytes no longer match their content address."""


class ObjectMissing(Exception):
    """No object stored under the given address."""


class InvalidRef(Exception):
    """A ref is not a canonical sha256 digest (traversal-safe rejection)."""


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_text(text: str) -> str:
    """The content address a text WOULD have — pure, no store access. Lets
    read-only planners/verifiers compute expected refs without publishing."""
    return _digest(text.encode("utf-8"))


def is_valid_ref(ref: str) -> bool:
    return bool(_REF_RE.match(ref))


def require_valid_ref(ref: str) -> str:
    if not is_valid_ref(ref):
        raise InvalidRef(
            f"{ref[:32]!r} is not a canonical sha256 ref (64 lowercase hex)"
        )
    return ref


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


class ObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, ref: str) -> Path:
        require_valid_ref(ref)  # traversal-safe: only 64-hex refs reach the FS
        return self.root / ref[:2] / ref

    def put_text(self, text: str) -> str:
        data = text.encode("utf-8")
        ref = _digest(data)
        path = self._path(ref)
        if path.exists():
            return ref
        path.parent.mkdir(parents=True, exist_ok=True)
        # a UNIQUE temp file per writer (concurrent-writer safe), fsynced,
        # then one atomic replace; a racing writer that already published the
        # identical content just wins the replace — content is identical.
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        _fsync_dir(path.parent)
        return ref

    def get_text(self, ref: str) -> str:
        path = self._path(ref)
        if not path.exists():
            raise ObjectMissing(f"object {ref} not found in store")
        data = path.read_bytes()
        actual = _digest(data)
        if actual != ref:
            raise ObjectCorruption(
                f"object {ref} failed verification (content hashes to {actual})"
            )
        return data.decode("utf-8")

    def has(self, ref: str, *, verify: bool = False) -> bool:
        """Whether `ref` is present. With `verify=True`, also confirm the
        stored bytes still hash to the ref (a present-but-corrupt object
        returns False)."""
        if not is_valid_ref(ref):
            return False
        path = self._path(ref)
        if not path.exists():
            return False
        if not verify:
            return True
        try:
            return _digest(path.read_bytes()) == ref
        except OSError:
            return False
