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
numbered with exact parent linkage.
"""

from __future__ import annotations

import hashlib
import json
import os
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


def load_dataset_revisions(store: object) -> tuple[DatasetRevision, ...]:
    """Every persisted dataset revision, strictly parsed and lineage-checked.
    A corrupt or out-of-order journal refuses ALL dataset reads."""
    path = _journal_path(store)
    if not os.path.exists(path):
        return ()
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


def ensure_dataset_revision(
    store: object, task: Task, *, reason: str | None = None
) -> DatasetRevision:
    """Idempotent: return the current dataset revision, appending a new one
    only when the task's case data differs from the latest persisted
    fingerprint. The first revision's reason is "initial"."""
    revisions = load_dataset_revisions(store)
    fingerprint = dataset_fingerprint(task)
    if revisions and revisions[-1].fingerprint == fingerprint:
        return revisions[-1]
    revision = _build_revision(
        store,
        task,
        revision=len(revisions) + 1,
        parent=revisions[-1].revision if revisions else None,
        reason=reason
        or ("initial" if not revisions else "dataset change detected"),
    )
    path = _journal_path(store)
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
    "dataset_fingerprint",
    "ensure_dataset_revision",
    "load_dataset_revisions",
    "materialize_split",
    "selection_fingerprint_note",
]
