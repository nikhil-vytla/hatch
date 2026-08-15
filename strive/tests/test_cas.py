"""Hardened content-addressed store: canonical-ref validation (traversal
safety), verified reads (corrupt-but-present detection), and concurrent-writer
safe atomic publication."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from strive.cas import (
    InvalidRef,
    ObjectCorruption,
    ObjectMissing,
    ObjectStore,
    hash_text,
    is_valid_ref,
)


def test_ref_shape() -> None:
    assert is_valid_ref("a" * 64)
    assert not is_valid_ref("A" * 64)  # uppercase is not canonical
    assert not is_valid_ref("a" * 63)  # too short
    assert not is_valid_ref("a" * 65)  # too long
    assert not is_valid_ref("../../etc/passwd")
    assert not is_valid_ref("")


@pytest.mark.parametrize(
    "bad", ["../../etc/passwd", "..", "a/../../b", "sub/dir", "\\evil", "g" * 64]
)
def test_traversal_refs_are_rejected(tmp_path: Path, bad: str) -> None:
    store = ObjectStore(tmp_path)
    with pytest.raises(InvalidRef):
        store.get_text(bad)  # _path validates before any filesystem access
    assert store.has(bad) is False  # has() never raises but rejects the ref


def test_put_get_roundtrip_and_corruption_detection(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path)
    ref = store.put_text("hello world")
    assert ref == hash_text("hello world")
    assert store.get_text(ref) == "hello world"
    # corrupt the stored bytes in place
    store._path(ref).write_bytes(b"tampered")
    assert store.has(ref) is True            # present…
    assert store.has(ref, verify=True) is False  # …but no longer hashes to its ref
    with pytest.raises(ObjectCorruption):
        store.get_text(ref)


def test_missing_object_raises(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path)
    with pytest.raises(ObjectMissing):
        store.get_text("a" * 64)


def test_put_text_detects_preexisting_corrupt_object(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path)
    ref = store.put_text("hello")
    store._path(ref).write_bytes(b"corrupted")  # tamper in place
    # a later put of the SAME logical content must not silently trust the
    # corrupt preexisting object — it is surfaced as corruption
    with pytest.raises(ObjectCorruption):
        store.put_text("hello")


def test_invalid_utf8_is_corruption(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path)
    raw = b"\xff\xfe not utf-8"
    import hashlib

    ref = hashlib.sha256(raw).hexdigest()  # a valid ref for invalid-UTF-8 bytes
    path = store._path(ref)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    with pytest.raises(ObjectCorruption):
        store.get_text(ref)


def test_concurrent_writers_of_identical_content(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path)
    text = "concurrent-content-" * 500
    ref = hash_text(text)
    errors: list[BaseException] = []

    def writer() -> None:
        try:
            assert store.put_text(text) == ref
        except BaseException as exc:  # noqa: BLE001 — collect for the assert
            errors.append(exc)

    threads = [threading.Thread(target=writer) for _ in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert store.get_text(ref) == text
    # no orphaned temp files from the losing racers
    shard = store._path(ref).parent
    assert list(shard.glob("*.tmp")) == []
