"""Content-addressed storage for strategy sources and large outputs.

Objects are stored at ``objects/<sha256[:2]>/<sha256>`` and verified against
their address on every read, so tampering or corruption is detected loudly
rather than silently served.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


class ObjectCorruption(Exception):
    """Stored bytes no longer match their content address."""


class ObjectMissing(Exception):
    """No object stored under the given address."""


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_text(text: str) -> str:
    """The content address a text WOULD have — pure, no store access. Lets
    read-only planners/verifiers compute expected refs without publishing."""
    return _digest(text.encode("utf-8"))


class ObjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, ref: str) -> Path:
        return self.root / ref[:2] / ref

    def put_text(self, text: str) -> str:
        data = text.encode("utf-8")
        ref = _digest(data)
        path = self._path(ref)
        if path.exists():
            return ref
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)  # atomic publish
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

    def has(self, ref: str) -> bool:
        return self._path(ref).exists()
