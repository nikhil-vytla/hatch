"""Dataset revisions (ADR-0003): append-friendly, fully reconstructable
evaluation data, persisted per task in ``ledger/<task>.datasets.jsonl``.

Each revision pins per-split CAS manifests (every split's exact case list
is content-addressed, so any historical evaluation re-materializes
exactly), a parent revision, a reason, per-split counts, and the dataset
fingerprint. Growing a split creates a NEW DatasetRevision and a
re-evaluation requirement — never a task-drift acknowledgement: the
incumbent must be re-baselined under the new revision before candidates
are compared on it, which the activation-evidence gate enforces by
refusing evidence whose manifest pins an outdated dataset fingerprint.

The journal is append-only and strictly parsed: a corrupt line refuses
every dataset read (fail closed), and revisions must be monotonically
numbered with exact parent linkage. Creation is LOCKED (an advisory flock
serializes concurrent writers), expected-head checked (a caller that
decided against a stale view refuses), crash-safe (a torn final line —
the write-then-crash case — is detected on load and repaired only under
the lock, with the torn bytes quarantined first), idempotent, and
CAS-closure verified (every split manifest and the revision object itself
must round-trip from CAS before the append is durable).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import time
from dataclasses import dataclass

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing
from strive.codec import register
from strive.contracts import AUDIT, TaskCase
from strive.evidence import DatasetRevision
from strive.tasks import Task


class DatasetError(Exception):
    """A dataset journal or manifest failure (corruption, lineage, refs)."""


@register("case-split-manifest", 1)
@dataclass(frozen=True)
class CaseSplitManifest:
    """One split's exact, ordered case list — the CAS-addressable unit a
    DatasetRevision pins per split."""

    dataset_id: str
    split: str
    cases: tuple[TaskCase, ...]


def _cases_by_split(task: Task) -> dict[str, tuple[TaskCase, ...]]:
    splits: dict[str, list[TaskCase]] = {}
    for case in task.cases:
        splits.setdefault(case.split, []).append(case)
    return {split: tuple(cases) for split, cases in sorted(splits.items())}


def dataset_fingerprint(task: Task) -> str:
    """Content hash of the task's CASES only (split-partitioned) — dataset
    identity, deliberately excluding spec fields so data growth and spec
    drift are distinct events."""
    canonical = json.dumps(
        {
            split: [[c.case_id, c.input_text, c.expected] for c in cases]
            for split, cases in _cases_by_split(task).items()
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _journal_path(store: object) -> str:
    ledger_path = getattr(store, "ledger_path")
    return str(ledger_path.with_name(f"{getattr(store, 'task_id')}.datasets.jsonl"))


def _lock_path(store: object) -> str:
    ledger_path = getattr(store, "ledger_path")
    return str(ledger_path.with_name(f"{getattr(store, 'task_id')}.datasets.lock"))


class _Locked:
    """Advisory exclusive lock serializing dataset-journal writers."""

    def __init__(self, store: object) -> None:
        self._path = _lock_path(store)

    def __enter__(self) -> "_Locked":
        self._handle = open(self._path, "a+")
        fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc: object) -> None:
        fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        self._handle.close()


def _torn_tail(path: str) -> int | None:
    """Byte offset of a torn final line (crash mid-append), or None. A torn
    tail is a final line that is NOT newline-terminated — an interrupted
    write; interior corruption is NOT a torn tail and never auto-repairs."""
    if not os.path.exists(path):
        return None
    data = pathlib_read_bytes(path)
    if not data or data.endswith(b"\n"):
        return None
    return data.rfind(b"\n") + 1  # 0 when no complete line exists


def pathlib_read_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def repair_torn_tail(store: object) -> str | None:
    """Under the writer lock: quarantine the torn bytes and truncate the
    journal to its last complete line. Returns the quarantine path, or None
    when the journal has no torn tail. Interior corruption is untouched —
    that stays a loud DatasetError."""
    path = _journal_path(store)
    with _Locked(store):
        offset = _torn_tail(path)
        if offset is None:
            return None
        data = pathlib_read_bytes(path)
        quarantine = f"{path}.quarantine-{time.strftime('%Y%m%dT%H%M%S')}"
        with open(quarantine, "wb") as handle:
            handle.write(data[offset:])
            handle.flush()
            os.fsync(handle.fileno())
        with open(path, "r+b") as handle:
            handle.truncate(offset)
            handle.flush()
            os.fsync(handle.fileno())
        return quarantine


def load_dataset_revisions(store: object) -> tuple[DatasetRevision, ...]:
    """Every persisted dataset revision, strictly parsed and lineage-checked.
    A corrupt or out-of-order journal refuses ALL dataset reads."""
    path = _journal_path(store)
    if not os.path.exists(path):
        return ()
    if _torn_tail(path) is not None:
        raise DatasetError(
            "dataset journal has a torn final line (crash mid-append); "
            "repair it via ensure_dataset_revision/repair_torn_tail before "
            "reading"
        )
    revisions: list[DatasetRevision] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                revision = codec.loads(line, DatasetRevision)
            except codec.SchemaError as exc:
                raise DatasetError(
                    f"dataset journal line {line_number} is corrupt: {exc}"
                ) from None
            expected_revision = len(revisions) + 1
            expected_parent = len(revisions) if revisions else None
            if revision.revision != expected_revision or (
                revision.parent_revision != expected_parent
            ):
                raise DatasetError(
                    f"dataset journal line {line_number} breaks lineage: "
                    f"revision {revision.revision} (parent "
                    f"{revision.parent_revision}), expected {expected_revision} "
                    f"(parent {expected_parent})"
                )
            revisions.append(revision)
    return tuple(revisions)


def current_dataset_revision(store: object) -> DatasetRevision | None:
    revisions = load_dataset_revisions(store)
    return revisions[-1] if revisions else None


def _build_revision(
    store: object, task: Task, *, revision: int, parent: int | None, reason: str
) -> DatasetRevision:
    objects = getattr(store, "objects")
    split_manifest_refs: dict[str, str] = {}
    split_counts: dict[str, int] = {}
    for split, cases in _cases_by_split(task).items():
        manifest = CaseSplitManifest(
            dataset_id=task.task_id, split=split, cases=cases
        )
        split_manifest_refs[split] = objects.put_text(codec.dumps(manifest))
        split_counts[split] = len(cases)
    return DatasetRevision(
        dataset_id=task.task_id,
        revision=revision,
        parent_revision=parent,
        reason=reason,
        split_manifest_refs=split_manifest_refs,
        split_counts=split_counts,
        fingerprint=dataset_fingerprint(task),
    )


def dataset_head(revisions: tuple[DatasetRevision, ...]) -> str:
    """The journal head a writer decided against: revision count + latest
    fingerprint (empty journal -> "0:")."""
    if not revisions:
        return "0:"
    return f"{len(revisions)}:{revisions[-1].fingerprint}"


def dataset_revision_ref(store: object, revision: DatasetRevision) -> str:
    """CAS-publish the exact DatasetRevision and return its ref."""
    objects = getattr(store, "objects")
    ref: str = objects.put_text(codec.dumps(revision))
    return ref


def ensure_dataset_revision(
    store: object,
    task: Task,
    *,
    reason: str | None = None,
    expected_head: str | None = None,
) -> DatasetRevision:
    """Idempotent, LOCKED dataset-revision creation: return the current
    revision, appending a new one only when the task's case data differs
    from the latest persisted fingerprint.

    - the advisory lock serializes concurrent writers (the fingerprint is
      re-checked under the lock, so two racers append at most one revision);
    - ``expected_head`` refuses a write decided against a stale view;
    - a torn final line (crash mid-append) is quarantined and truncated
      under the lock before proceeding — interior corruption never
      auto-repairs;
    - the append is durable only after the revision object and every
      split manifest verifiably round-trip from CAS (closure check)."""
    with _Locked(store):
        path = _journal_path(store)
        if _torn_tail(path) is not None:
            offset = _torn_tail(path)
            assert offset is not None
            data = pathlib_read_bytes(path)
            quarantine = f"{path}.quarantine-{time.strftime('%Y%m%dT%H%M%S')}"
            with open(quarantine, "wb") as qh:
                qh.write(data[offset:])
                qh.flush()
                os.fsync(qh.fileno())
            with open(path, "r+b") as th:
                th.truncate(offset)
                th.flush()
                os.fsync(th.fileno())
        revisions = load_dataset_revisions(store)
        if expected_head is not None and dataset_head(revisions) != expected_head:
            raise DatasetError(
                f"stale dataset head: writer decided at {expected_head!r} but "
                f"the journal is at {dataset_head(revisions)!r}"
            )
        fingerprint = dataset_fingerprint(task)
        if revisions and revisions[-1].fingerprint == fingerprint:
            dataset_revision_ref(store, revisions[-1])  # closure convergence
            return revisions[-1]
        revision = _build_revision(
            store,
            task,
            revision=len(revisions) + 1,
            parent=revisions[-1].revision if revisions else None,
            reason=reason
            or ("initial" if not revisions else "dataset change detected"),
        )
        # CAS closure BEFORE the journal append becomes durable: the exact
        # revision object and every split manifest must round-trip
        objects = getattr(store, "objects")
        revision_ref = objects.put_text(codec.dumps(revision))
        decoded: DatasetRevision = codec.loads(
            objects.get_text(revision_ref), DatasetRevision
        )
        if decoded != revision:
            raise DatasetError("dataset revision failed CAS round-trip")
        for split in revision.split_manifest_refs:
            materialize_split(store, revision, split)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(codec.dumps(revision) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return revision


def materialize_split(
    store: object, revision: DatasetRevision, split: str
) -> tuple[TaskCase, ...]:
    """Re-materialize one split's exact historical case list from CAS."""
    ref = revision.split_manifest_refs.get(split)
    if ref is None:
        raise DatasetError(
            f"dataset {revision.dataset_id} r{revision.revision} has no "
            f"{split!r} split"
        )
    objects = getattr(store, "objects")
    try:
        manifest = codec.loads(objects.get_text(ref), CaseSplitManifest)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        raise DatasetError(
            f"split manifest for {split!r} unavailable/corrupt: {exc}"
        ) from None
    return manifest.cases


def selection_fingerprint_note(task: Task) -> str:
    """Human note for inspection: which splits participate in selection."""
    splits = [s for s in _cases_by_split(task) if s != AUDIT]
    return f"selection splits: {', '.join(splits)} (audit excluded)"


__all__ = [
    "CaseSplitManifest",
    "DatasetError",
    "current_dataset_revision",
    "dataset_head",
    "dataset_revision_ref",
    "repair_torn_tail",
    "dataset_fingerprint",
    "ensure_dataset_revision",
    "load_dataset_revisions",
    "materialize_split",
    "selection_fingerprint_note",
]
