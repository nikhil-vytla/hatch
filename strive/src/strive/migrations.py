"""The sequential migration registry (ADR-0006).

One ordered registry instead of accumulating one-off scripts. Every
migration: detects loudly (an unmigrated layout refuses normal operation
with the exact command), preserves original files byte-for-byte (entry 0002
is append-only — no source record is touched), records source hashes in a
journaled marker, validates its output before declaring success, and safely
no-ops or refuses when already applied.

Registry:
- ``0001-legacy-unscoped-ledger`` — the phase-4.6 stage-2a migration,
  unchanged (`strive.migrate.migrate_legacy_ledger`).
- ``0002-revision-backfill`` — mirrors generation/activation history into
  revision/revision-activation records (Stage-3B dual-write backfill),
  built on the deterministic parity-repair path.
- ``0003-lifecycle-backfill`` — backfills the native revision lifecycle
  (`<task>.revisions.jsonl`) from generation history: an identity for every
  generation, compatibility links, and the full activation history replayed
  so the ACTUAL active revision is preserved — never just the seed.
- ``0004-reader-journal-upgrade`` — migrates a PR#43-format reader journal
  (frame schema `reader-frame@1`, old genesis) to the shared framing,
  preserving original bytes (quarantined + hashed), mode, breaker, epoch,
  checks, summaries, and ordering; fails loudly on ambiguity.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from strive.dualwrite import open_intent, parity_status, run_backfill_operation
from strive.migrate import migrate_legacy_ledger
from strive.store import LEGACY_LEDGER_NAME, LegacyLedgerError, Store, StoreError
from strive.tasks import Task


@dataclass(frozen=True)
class MigrationReport:
    migration_id: str
    applied: bool
    detail: str


@dataclass(frozen=True)
class Migration:
    migration_id: str
    description: str
    is_needed: Callable[[Path, Task], bool]
    apply: Callable[[Path, Task], MigrationReport]


# -- 0001: legacy unscoped ledger ------------------------------------------------------


def _legacy_needed(root: Path, task: Task) -> bool:
    legacy = root / "ledger" / LEGACY_LEDGER_NAME
    target = root / "ledger" / f"{task.task_id}.jsonl"
    return legacy.exists() and not target.exists()


def _legacy_apply(root: Path, task: Task) -> MigrationReport:
    report = migrate_legacy_ledger(root, task)
    return MigrationReport(
        migration_id="0001-legacy-unscoped-ledger",
        applied=True,
        detail=(
            f"migrated {report.migrated_entries} entries "
            f"(sha256 {report.legacy_sha256[:12]}…); original preserved"
        ),
    )


# -- 0002: revision backfill -----------------------------------------------------------


def _backfill_needed(root: Path, task: Task) -> bool:
    """Read-only discovery. Pending status rests on COMPLETION, not parity
    alone: an open (uncompleted) intent keeps the migration pending even if
    parity already looks complete — the crash-after-parity-before-completion
    case resumes here and journals its completion record."""
    ledger = root / "ledger" / f"{task.task_id}.jsonl"
    if not ledger.exists():
        return False
    store = Store(root, task.task_id)
    if open_intent(store.mirror) is not None:
        return True
    return not parity_status(store).complete


def _backfill_apply(root: Path, task: Task) -> MigrationReport:
    store = Store(root, task.task_id)
    before = parity_status(store)
    resumed = open_intent(store.mirror) is not None
    report = run_backfill_operation(store, "0002-revision-backfill")
    if not report.complete:
        raise StoreError("backfill did not reach parity; investigate before retrying")
    return MigrationReport(
        migration_id="0002-revision-backfill",
        applied=True,
        detail=(
            f"{'resumed and ' if resumed else ''}mirrored "
            f"{len(before.missing_source_ordinals)} source records "
            "(intent/progress/completed journaled in the mirror journal; "
            "source ledger untouched)"
        ),
    )


# -- 0003: native lifecycle backfill ----------------------------------------------------


def _lifecycle_needed(root: Path, task: Task) -> bool:
    from strive import lifecycle

    ledger = root / "ledger" / f"{task.task_id}.jsonl"
    if not ledger.exists():
        return False
    store = Store(root, task.task_id)
    if lifecycle.state(store).open_intents:
        return True
    return lifecycle.sync_needed(store)


def _lifecycle_apply(root: Path, task: Task) -> MigrationReport:
    from strive import lifecycle

    store = Store(root, task.task_id)
    before = lifecycle.state(store)
    outcomes = lifecycle.reconcile(store)
    lifecycle.sync_from_generations(store)
    after = lifecycle.state(store)
    parity = lifecycle.compat_parity(store)
    if not parity.ok:
        raise StoreError(
            f"lifecycle backfill did not reach compatibility parity: {parity.reason}"
        )
    return MigrationReport(
        migration_id="0003-lifecycle-backfill",
        applied=True,
        detail=(
            f"backfilled {len(after.retained) - len(before.retained)} revision "
            f"identit(ies), replayed "
            f"{len(after.activation_order) - len(before.activation_order)} "
            f"activation(s); active revision {after.active_revision_id}"
            + (f"; reconciled: {', '.join(outcomes)}" if outcomes else "")
        ),
    )


# -- 0005: evidence-envelope backfill -----------------------------------------------------


def _evidence_needed(root: Path, task: Task) -> bool:
    from strive import lifecycle

    ledger = root / "ledger" / f"{task.task_id}.jsonl"
    if not ledger.exists():
        return False
    return lifecycle.evidence_links_needed(Store(root, task.task_id))


def _evidence_apply(root: Path, task: Task) -> MigrationReport:
    from strive import lifecycle
    from strive.datasets import ensure_dataset_revision

    store = Store(root, task.task_id)
    dataset = ensure_dataset_revision(store, task)
    appended = lifecycle.ensure_evidence_links(store, task)
    return MigrationReport(
        migration_id="0005-evidence-backfill",
        applied=True,
        detail=(
            f"linked {appended} assessment record(s) to synthetic-but-lossless "
            f"evidence envelopes (originals untouched); dataset revision "
            f"r{dataset.revision} ({dataset.fingerprint[:12]}…)"
        ),
    )


# -- 0004: reader journal upgrade --------------------------------------------------------


def _reader_upgrade_needed(root: Path, task: Task) -> bool:
    from strive.reader import reader_journal_needs_upgrade

    ledger = root / "ledger" / f"{task.task_id}.jsonl"
    if not ledger.exists():
        return False
    return reader_journal_needs_upgrade(Store(root, task.task_id))


def _reader_upgrade_apply(root: Path, task: Task) -> MigrationReport:
    from strive.reader import upgrade_reader_journal

    report = upgrade_reader_journal(Store(root, task.task_id))
    return MigrationReport(
        migration_id="0004-reader-journal-upgrade",
        applied=True,
        detail=(
            f"re-framed {report.batches} batch(es) / {report.entries} entr(ies); "
            f"original preserved at {report.quarantine_path} "
            f"(sha256 {report.original_sha256[:12]}…)"
        ),
    )


MIGRATIONS: tuple[Migration, ...] = (
    Migration(
        migration_id="0001-legacy-unscoped-ledger",
        description="stage-2a ledger/ledger.jsonl -> task-scoped v2 ledger",
        is_needed=_legacy_needed,
        apply=_legacy_apply,
    ),
    Migration(
        migration_id="0002-revision-backfill",
        description="generation/activation history -> revision mirrors (dual-write backfill)",
        is_needed=_backfill_needed,
        apply=_backfill_apply,
    ),
    Migration(
        migration_id="0003-lifecycle-backfill",
        description="generation history -> native revision lifecycle (identities, "
        "links, activation replay; preserves the actual active revision)",
        is_needed=_lifecycle_needed,
        apply=_lifecycle_apply,
    ),
    Migration(
        migration_id="0004-reader-journal-upgrade",
        description="PR#43 reader-frame@1 journal -> shared framed-batch format "
        "(bytes preserved; mode/breaker/epoch/evidence carried over exactly)",
        is_needed=_reader_upgrade_needed,
        apply=_reader_upgrade_apply,
    ),
    Migration(
        migration_id="0005-evidence-backfill",
        description="pre-envelope evaluations/selections/surface evidence -> "
        "EvidenceLinks to synthetic-but-lossless ValidationBundles / "
        "SelectionDecisions (originals preserved byte-for-byte)",
        is_needed=_evidence_needed,
        apply=_evidence_apply,
    ),
)


def pending_migrations(root: Path, task: Task) -> list[Migration]:
    return [m for m in MIGRATIONS if m.is_needed(root, task)]


def apply_pending(root: Path, task: Task) -> list[MigrationReport]:
    """Apply pending migrations sequentially, in registry order."""
    reports: list[MigrationReport] = []
    for migration in MIGRATIONS:
        if migration.is_needed(root, task):
            reports.append(migration.apply(root, task))
    return reports


__all__ = [
    "Migration",
    "MigrationReport",
    "MIGRATIONS",
    "pending_migrations",
    "apply_pending",
    "LegacyLedgerError",
]
