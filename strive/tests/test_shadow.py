"""Derived integrity: prefix pinning, intent exclusivity, fail-closed
planning, artifact closure, quarantine/rebuild, stage-3B journal upgrades —
and the ONE verified revision snapshot (parity-grade) that all revision
reads use.
"""

import hashlib
import json
from pathlib import Path

import pytest

from strive import codec
from strive.dualwrite import (
    MigrationCompleted,
    MigrationIntent,
    MirrorError,
    PROJECTOR_REF,
    ParityError,
    capture_snapshot,
    open_intent,
    parity_status,
    plan_projection,
    rebuild_mirror,
    run_backfill_operation,
)
from strive.evaluate import evaluate
from strive.loop import run_cycle
from strive.reader import verify_revision_snapshot
from strive.sandbox import run_strategy
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def _evolved_store(tmp_path: Path, name: str = "artifacts") -> Store:
    store = Store(tmp_path / name, SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted
    return store


def _mirror_lines(store: Store) -> list[str]:
    return [l for l in store.mirror.path.read_text().splitlines() if l.strip()]


def _strip_all_mirrors(store: Store) -> None:
    kept = [
        l for l in _mirror_lines(store)
        if json.loads(l)["schema"] not in ("revision-mirror@1", "activation-mirror@1")
    ]
    store.mirror.path.write_text("\n".join(kept) + "\n" if kept else "")


def _intent_at_head(store: Store, migration_id: str, op_id: str) -> MigrationIntent:
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    return MigrationIntent(
        op_id=op_id, migration_id=migration_id,
        source_head=snapshot.head, source_hash=snapshot.journal_hash,
        prefix_digest=snapshot.prefix_digest(snapshot.head),
        projector_ref=PROJECTOR_REF, started_at=now_iso(),
    )


# -- 1. migration/repair hardening ---------------------------------------------------------


def test_altered_source_prefix_after_intent_is_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    store.mirror.append(_intent_at_head(store, "0002-revision-backfill", "op-pin"))
    # ALTER a prefix record (canonical ledger tampering)
    lines = store.ledger_path.read_text().splitlines()
    record = json.loads(lines[0])
    record["origin"] = "manual"
    lines[0] = json.dumps(record, sort_keys=True, separators=(",", ":"))
    store.ledger_path.write_text("\n".join(lines) + "\n")

    with pytest.raises(ParityError, match="prefix .*altered|has been altered"):
        run_backfill_operation(store, "0002-revision-backfill")


def test_appended_records_after_intent_are_allowed(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    store.mirror.append(_intent_at_head(store, "0002-revision-backfill", "op-append"))
    run_cycle(store, SUM_INTEGERS_TASK)  # append-only growth is fine
    report = run_backfill_operation(store, "0002-revision-backfill")
    assert report.complete
    assert open_intent(store.mirror) is None


def test_multiple_open_intents_are_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    for op_id in ("op-a", "op-b"):
        store.mirror.append(_intent_at_head(store, "0002-revision-backfill", op_id))
    with pytest.raises(ParityError, match="2 unfinished migration intents"):
        run_backfill_operation(store, "0002-revision-backfill")


def test_resume_validates_migration_id_and_projector(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    store.mirror.append(_intent_at_head(store, "0002-revision-backfill", "op-x"))
    with pytest.raises(ParityError, match="refusing to resume it as"):
        run_backfill_operation(store, "parity-repair")

    _strip_all_mirrors(store)  # reset
    store.mirror.path.write_text("")
    store.mirror.append(
        MigrationIntent(
            op_id="op-y", migration_id="parity-repair",
            source_head=snapshot.head, source_hash=snapshot.journal_hash,
            prefix_digest=snapshot.prefix_digest(snapshot.head),
            projector_ref="generation-to-revision@9",  # unsupported
            started_at=now_iso(),
        )
    )
    with pytest.raises(ParityError, match="refusing to resume"):
        run_backfill_operation(store, "parity-repair")


def test_plan_projection_fails_before_publishing_on_bad_mirrors(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    doctored = lines[0].replace(PROJECTOR_REF, "generation-to-revision@9")
    store.mirror.path.write_text("\n".join([doctored] + lines[1:]) + "\n")

    snapshot = capture_snapshot(store)
    objects_before = sorted(
        p.name for p in store.objects.root.rglob("*") if p.is_file()
    )
    with pytest.raises(ParityError, match="refusing to plan"):
        plan_projection(snapshot, store.mirror.entries())
    objects_after = sorted(
        p.name for p in store.objects.root.rglob("*") if p.is_file()
    )
    assert objects_after == objects_before


def test_mismatched_mirror_plus_missing_records_fails_closed(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    record = json.loads(lines[0])
    record["revision"]["summary"] = "tampered"
    mangled = [json.dumps(record, sort_keys=True, separators=(",", ":"))] + lines[2:]
    store.mirror.path.write_text("\n".join(mangled) + "\n")

    report = parity_status(store)
    assert not report.complete
    assert report.mismatched and report.missing_source_ordinals
    with pytest.raises(ParityError):
        run_backfill_operation(store, "parity-repair")


def test_open_intent_permits_later_activation_mirrors(tmp_path: Path) -> None:
    """Prefix-scoped completion: an intent is open, then a rollback creates a
    LATER activation + live mirror before resume."""
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    revision_indexes = [
        i for i, l in enumerate(lines)
        if json.loads(l)["schema"] == "revision-mirror@1"
    ]
    del lines[revision_indexes[0]]
    store.mirror.path.write_text("\n".join(lines) + "\n")
    store.mirror.append(_intent_at_head(store, "parity-repair", "op-open"))

    store.rollback()  # appends a later activation record + live mirror
    later_mirrors = [
        l for l in _mirror_lines(store)
        if json.loads(l)["schema"] == "activation-mirror@1"
    ]

    report = run_backfill_operation(store, "parity-repair")  # resume
    assert report.complete
    assert open_intent(store.mirror) is None
    survivors = [
        l for l in _mirror_lines(store)
        if json.loads(l)["schema"] == "activation-mirror@1"
    ]
    assert sorted(survivors) == sorted(set(later_mirrors))
    snapshot = verify_revision_snapshot(store)
    assert snapshot.available, snapshot.reason
    assert snapshot.active_revision_id() == "rev-0000"  # post-rollback


# -- 2. artifact closure --------------------------------------------------------------------


def _object_path(store: Store, ref: str) -> Path:
    return store.objects.root / ref[:2] / ref


def test_missing_derived_objects_are_detected_and_repaired(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    revision = store.revisions()[-1]
    assert revision.provenance_ref is not None
    _object_path(store, revision.scope_manifest_ref).unlink()
    _object_path(store, revision.provenance_ref).unlink()

    report = parity_status(store)
    assert not report.complete
    assert len(report.missing_objects) == 2
    assert not report.closure_issues
    # closure is an availability requirement of the verified snapshot
    assert not verify_revision_snapshot(store).available

    repaired = run_backfill_operation(store, "parity-repair")
    assert repaired.complete
    assert verify_revision_snapshot(store).available


def test_corrupt_derived_objects_fail_closed_never_overwritten(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    revision = store.revisions()[-1]
    manifest_path = _object_path(store, revision.scope_manifest_ref)
    manifest_path.write_text("corrupted bytes")

    report = parity_status(store)
    assert any("corrupt" in issue for issue in report.closure_issues)
    with pytest.raises(ParityError):
        run_backfill_operation(store, "parity-repair")
    assert manifest_path.read_text() == "corrupted bytes"


def test_corrupt_decision_and_source_objects_are_closure_issues(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    revision = store.revisions()[-1]
    assert revision.provenance_ref is not None
    from strive.revisions import MigrationProvenance

    provenance: MigrationProvenance = codec.loads(
        store.objects.get_text(revision.provenance_ref), MigrationProvenance
    )
    assert provenance.decision_ref is not None
    _object_path(store, provenance.decision_ref).write_text("junk")
    report = parity_status(store)
    assert any("decision" in i and "corrupt" in i for i in report.closure_issues)

    generation = store.generations()["gen-0001"]
    _object_path(store, generation.source_ref).unlink()
    report = parity_status(store)
    assert any("canonical data loss" in i for i in report.closure_issues)


# -- 3. quarantine + rebuild ------------------------------------------------------------------


def test_corrupt_mirror_quarantine_and_rebuild(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    store.rollback()
    corrupt_bytes = b'{"schema":"revision-mirror@1","garbage":true}\nnot json\n'
    store.mirror.path.write_bytes(corrupt_bytes)
    ledger_before = store.ledger_path.read_bytes()

    with pytest.raises(MirrorError):
        parity_status(store)
    snapshot = verify_revision_snapshot(store)
    assert not snapshot.available and snapshot.active_revision_id() is None

    rebuilt = rebuild_mirror(store)
    assert rebuilt.report.complete
    assert rebuilt.quarantine_path is not None
    assert Path(rebuilt.quarantine_path).read_bytes() == corrupt_bytes
    assert rebuilt.prior_mirror_sha256 == hashlib.sha256(corrupt_bytes).hexdigest()
    assert store.ledger_path.read_bytes() == ledger_before
    kinds = [type(e).__name__ for e in store.mirror.entries()]
    assert kinds[0] == "MigrationIntent" and kinds[-1] == "MigrationCompleted"
    completed = store.mirror.entries()[-1]
    assert isinstance(completed, MigrationCompleted)
    assert rebuilt.prior_mirror_sha256 in completed.detail
    snapshot = verify_revision_snapshot(store)
    assert snapshot.available
    assert snapshot.active_revision_id() == "rev-0000"  # post-rollback


def test_stage3b_intent_journal_is_detected_with_rebuild_guidance(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    snapshot = capture_snapshot(store)
    legacy_intent = json.dumps(
        {
            "schema": "migration-intent@1",
            "op_id": "op-3b", "migration_id": "0002-revision-backfill",
            "source_head": snapshot.head, "source_hash": snapshot.journal_hash,
            "projector_ref": PROJECTOR_REF, "started_at": "2026-08-01T00:00:00Z",
        },
        sort_keys=True, separators=(",", ":"),
    )
    prior = store.mirror.path.read_bytes()
    store.mirror.path.write_bytes(prior + (legacy_intent + "\n").encode())

    with pytest.raises(MirrorError, match="parity --rebuild"):
        store.mirror.entries()
    assert not verify_revision_snapshot(store).available  # degraded, not crashed

    rebuilt = rebuild_mirror(store)
    assert rebuilt.report.complete
    assert rebuilt.quarantine_path is not None
    assert legacy_intent in Path(rebuilt.quarantine_path).read_text()
    assert verify_revision_snapshot(store).available


# -- 4. the verified revision snapshot ----------------------------------------------------------


def test_tampered_source_identity_is_unavailable(tmp_path: Path) -> None:
    """A mirror whose SourceRecordRef journal or schema identity is wrong —
    even with a matching ordinal and digest — must make the snapshot
    unavailable (complete-ref comparison, not positional)."""
    store = _evolved_store(tmp_path)
    for tamper_field, value in (("journal", "task:other"), ("source_schema", "activation@2")):
        lines = _mirror_lines(store)
        for index, line in enumerate(lines):
            record = json.loads(line)
            if record["schema"] == "revision-mirror@1":
                record["source"][tamper_field] = value
                lines[index] = json.dumps(record, sort_keys=True, separators=(",", ":"))
                break
        tampered = "\n".join(lines) + "\n"
        original = store.mirror.path.read_bytes()
        store.mirror.path.write_bytes(tampered.encode())
        snapshot = verify_revision_snapshot(store)
        assert not snapshot.available, tamper_field
        assert snapshot.active_revision_id() is None
        store.mirror.path.write_bytes(original)  # restore for the next case
    assert verify_revision_snapshot(store).available


def test_doctored_mirror_content_is_unavailable_via_recomputed_projection(
    tmp_path: Path,
) -> None:
    """The verified snapshot recomputes projections: mirror content edits
    that would pass a structural check (e.g. a doctored base_parent) fail
    projection equality and make the snapshot unavailable."""
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    for index, line in enumerate(lines):
        record = json.loads(line)
        if (
            record["schema"] == "revision-mirror@1"
            and record["revision"]["ref"]["revision_id"] == "rev-0000"
        ):
            record["revision"]["base_parent"] = {
                "schema": "revision-ref@1",
                "scope": record["revision"]["ref"]["scope"],
                "revision_id": "rev-0001",
            }
            lines[index] = json.dumps(record, sort_keys=True, separators=(",", ":"))
            break
    store.mirror.path.write_text("\n".join(lines) + "\n")

    snapshot = verify_revision_snapshot(store)
    assert not snapshot.available
    assert "mirror verification failed" in snapshot.reason


def test_verified_snapshot_source_evaluates_identically(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = verify_revision_snapshot(store)
    active_id = snapshot.active_revision_id()
    assert snapshot.available and active_id is not None
    _, derived_source = snapshot.sources[active_id]

    active = store.active_generation()
    assert active is not None
    native_report = run_strategy(
        store.source_of(active), SUM_INTEGERS_TASK.selection_cases(),
        generation_id=active.generation_id,
    )
    derived_report = run_strategy(
        derived_source, SUM_INTEGERS_TASK.selection_cases(), generation_id="derived"
    )
    native_eval = evaluate(SUM_INTEGERS_TASK, native_report)
    derived_eval = evaluate(SUM_INTEGERS_TASK, derived_report)
    assert native_eval.overall_score == derived_eval.overall_score == 1.0
    assert native_eval.split_scores == derived_eval.split_scores


def test_lineage_and_parents_from_verified_snapshot(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = verify_revision_snapshot(store)
    assert snapshot.available
    assert snapshot.active_revision_id() == "rev-0001"
    assert snapshot.lineage_of("rev-0001") == ("rev-0001", "rev-0000")
    assert snapshot.parent_of("rev-0001") == "rev-0000"
    assert snapshot.parent_of("rev-0000") is None
