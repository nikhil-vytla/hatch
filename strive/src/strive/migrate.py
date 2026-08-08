"""Migration of a stage-2a legacy ledger to the task-scoped v2 format.

The stage-2a store wrote one task-agnostic journal at ``ledger/ledger.jsonl``
with ``generation@1`` (no task identity) and ``activation@1`` entries. This
module converts that history into ``ledger/<task_id>.jsonl`` while preserving:

- every generation (with decisions) and its lineage,
- every activation in order — so the active generation, rollback state, and
  provisional history are exactly what they were,
- every cycle record and intervention verbatim,
- the original ``ledger.jsonl`` file, untouched, for audit.

Task identity is attached during migration: generations gain the bound task's
id and the task fingerprint recorded in the legacy cycle records (falling back
to the current task fingerprint when the legacy ledger holds no cycles); if
that recorded fingerprint differs from the current task definition, the drift
guard will require explicit acknowledgement on the next mutating run — that is
intended, not a defect. A ledger whose cycle records reference any *other*
task is refused: legacy generations carry no task identity of their own, so
mixed-task legacy history cannot be attributed safely.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strive import codec
from strive.contracts import (
    Activation,
    CycleRecord,
    Generation,
    Intervention,
    INTERVENTION_LEGACY_MIGRATION,
)
from strive.events import now_iso
from strive.store import LEGACY_LEDGER_NAME, LedgerError, Store, StoreError
from strive.tasks import Task


@dataclass(frozen=True)
class MigrationReport:
    migrated_entries: int
    generations: int
    activations: int
    cycles: int
    interventions: int
    legacy_sha256: str
    task_fingerprint_used: str
    fingerprint_drifted: bool


def _decode_legacy_line(
    line: str, line_no: int, task: Task, fingerprint: str
) -> Generation | Activation | CycleRecord | Intervention:
    try:
        raw: Any = json.loads(line)
    except json.JSONDecodeError as exc:
        raise LedgerError(f"legacy ledger line {line_no}: invalid JSON: {exc}") from None
    if not isinstance(raw, dict) or not isinstance(raw.get("schema"), str):
        raise LedgerError(f"legacy ledger line {line_no}: missing schema tag")
    schema = raw["schema"]
    if schema == "generation@1":
        upgraded = dict(raw)
        upgraded["schema"] = "generation@2"
        upgraded["task_id"] = task.task_id
        upgraded["task_fingerprint"] = fingerprint
        return codec.decode(upgraded, Generation)
    if schema == "activation@1":
        upgraded = dict(raw)
        upgraded["schema"] = "activation@2"
        upgraded["task_id"] = task.task_id
        return codec.decode(upgraded, Activation)
    # cycle@1 and intervention@1 are unchanged shapes — decode strictly
    decoded: object = codec.decode(raw)
    if isinstance(decoded, (CycleRecord, Intervention)):
        return decoded
    raise LedgerError(
        f"legacy ledger line {line_no}: {type(decoded).__name__} is not a "
        "ledger entry kind"
    )


def migrate_legacy_ledger(root: Path, task: Task) -> MigrationReport:
    """Convert ``ledger/ledger.jsonl`` into the task-scoped journal for `task`.

    Refuses (loudly, changing nothing) when: no legacy ledger exists, the
    task-scoped ledger already exists, or the legacy cycles reference another
    task.
    """
    legacy_path = root / "ledger" / LEGACY_LEDGER_NAME
    target_path = root / "ledger" / f"{task.task_id}.jsonl"
    if not legacy_path.exists():
        raise StoreError(f"no legacy ledger at {legacy_path}; nothing to migrate")
    if target_path.exists():
        raise StoreError(
            f"task ledger {target_path} already exists; refusing to overwrite. "
            "If it is a partial migration, move it aside and re-run."
        )

    raw_bytes = legacy_path.read_bytes()
    lines = [line for line in raw_bytes.decode("utf-8").split("\n") if line.strip()]

    # attribute task identity: legacy cycles carry task ids; they must all be
    # this task's (legacy generations have no identity of their own)
    cycle_task_ids: set[str] = set()
    recorded_fingerprints: list[str] = []
    for line in lines:
        try:
            raw: Any = json.loads(line)
        except json.JSONDecodeError:
            continue  # strict handling happens during decoding below
        if isinstance(raw, dict) and raw.get("schema") == "cycle@1":
            cycle_task_ids.add(str(raw.get("task_id")))
            recorded_fingerprints.append(str(raw.get("task_fingerprint")))
    foreign = cycle_task_ids - {task.task_id}
    if foreign:
        raise StoreError(
            f"legacy ledger contains cycle records for other tasks {sorted(foreign)}; "
            "legacy generations carry no task identity, so mixed or foreign "
            "history cannot be attributed safely. Migrate manually."
        )

    fingerprint = recorded_fingerprints[-1] if recorded_fingerprints else task.fingerprint()
    entries = [
        _decode_legacy_line(line, line_no, task, fingerprint)
        for line_no, line in enumerate(lines, start=1)
    ]

    legacy_sha = hashlib.sha256(raw_bytes).hexdigest()
    counts = {kind: 0 for kind in ("generation", "activation", "cycle", "intervention")}
    tmp_path = target_path.with_suffix(".migrating")
    with tmp_path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            if isinstance(entry, Generation):
                counts["generation"] += 1
            elif isinstance(entry, Activation):
                counts["activation"] += 1
            elif isinstance(entry, CycleRecord):
                counts["cycle"] += 1
            else:
                counts["intervention"] += 1
            handle.write(codec.dumps(entry) + "\n")
        marker = Intervention(
            kind=INTERVENTION_LEGACY_MIGRATION,
            reason=(
                f"migrated {len(entries)} entries from {LEGACY_LEDGER_NAME} "
                f"(sha256 {legacy_sha}); original preserved"
            ),
            at=now_iso(),
        )
        handle.write(codec.dumps(marker) + "\n")
    tmp_path.replace(target_path)  # atomic publish; original legacy file untouched

    # validate the result end to end before declaring success
    store = Store(root, task.task_id)
    store.entries()
    if store.active_generation() is None and counts["activation"]:
        raise StoreError("migration produced no active generation; investigate")

    return MigrationReport(
        migrated_entries=len(entries),
        generations=counts["generation"],
        activations=counts["activation"],
        cycles=counts["cycle"],
        interventions=counts["intervention"],
        legacy_sha256=legacy_sha,
        task_fingerprint_used=fingerprint,
        fingerprint_drifted=fingerprint != task.fingerprint(),
    )
