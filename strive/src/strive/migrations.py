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
