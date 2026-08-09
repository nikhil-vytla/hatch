"""Stage-3B dual-write: separated journals, source-ref matching, durable ops,
pure projection plans, fail-closed projection, and failure injection.

Generation-native records in the task ledger stay authoritative; mirrors
live in a separate journal and can never block generation-native behavior.
"""

import json
from pathlib import Path

import pytest

from strive import codec
from strive.dualwrite import (
    ActivationMirror,
    MigrationCompleted,
    MigrationIntent,
    MirrorError,
    PROJECTOR_REF,
    ParityError,
    RevisionMirror,
    active_revision_id,
    apply_projection,
    capture_snapshot,
    open_intent,
    parity_status,
    plan_projection,
    run_backfill_operation,
    validate_source_history,
)
from strive.loop import promote_generation, replay_run, run_cycle
from strive.migrations import MIGRATIONS, apply_pending, pending_migrations
from strive.revisions import MigrationProvenance
from strive.store import Store
from strive.tasks import MAX_INTEGERS_TASK, SUM_INTEGERS_TASK


def _evolved_store(tmp_path: Path, **kwargs: bool) -> Store:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id, **kwargs)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted
    return store


def _mirror_lines(store: Store) -> list[str]:
    return [l for l in store.mirror.path.read_text().splitlines() if l.strip()]


def _drop_mirror_lines(store: Store, drop: set[int]) -> None:
    """Failure injection: remove specific mirror-journal lines (0-based
    among RevisionMirror/ActivationMirror lines only)."""
    kept: list[str] = []
    mirror_index = 0
    for line in _mirror_lines(store):
        schema = json.loads(line)["schema"]
        if schema in ("revision-mirror@1", "activation-mirror@1"):
            if mirror_index in drop:
                mirror_index += 1
                continue
            mirror_index += 1
        kept.append(line)
    store.mirror.path.write_text("\n".join(kept) + "\n" if kept else "")


# -- 1. separated journals + source-ref matching -----------------------------------------


def test_task_ledger_holds_only_generation_native_records(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    ledger_schemas = {
        json.loads(l)["schema"]
        for l in store.ledger_path.read_text().splitlines()
        if l.strip()
    }
    assert ledger_schemas <= {"generation@2", "activation@2", "cycle@1", "intervention@1"}
    mirror_schemas = {json.loads(l)["schema"] for l in _mirror_lines(store)}
    assert "revision-mirror@1" in mirror_schemas
    assert "activation-mirror@1" in mirror_schemas


def test_mirrors_carry_source_refs_and_parity_is_complete(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    report = parity_status(store)
    assert report.complete
    assert report.generations == 2 and report.activations == 2
    assert report.revision_mirrors == 2 and report.activation_mirrors == 2

    snapshot = capture_snapshot(store)
    by_ordinal = {r.ref.ordinal: r for r in snapshot.records}
    for entry in store.mirror.entries():
        if isinstance(entry, (RevisionMirror, ActivationMirror)):
            assert entry.projector_ref == PROJECTOR_REF
            source = by_ordinal[entry.source.ordinal]
            assert entry.source == source.ref  # schema, journal, ordinal, digest
            assert entry.source.journal == f"task:{SUM_INTEGERS_TASK.task_id}"


def test_corrupt_mirror_journal_never_blocks_generation_native_ops(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    store.mirror.path.write_text('{"schema":"revision-mirror@1","garbage":true}\n')

    fresh = Store(store.root, SUM_INTEGERS_TASK.task_id)
    # run, activation, rollback, replay, inspection all work
    report = run_cycle(fresh, SUM_INTEGERS_TASK)
    assert report.run_id
    fresh.rollback()
    promote_generation(fresh, SUM_INTEGERS_TASK, "gen-0001")
    assert fresh.active_generation() is not None
    assert len(fresh.entries()) > 0  # ledger inspection unaffected
    replay = replay_run(fresh, SUM_INTEGERS_TASK, report.run_id)
    assert replay.matches  # replay unaffected too
    # while parity reports the mirror corruption cleanly
    with pytest.raises(MirrorError):
        parity_status(fresh)
    # live mirror publication failures during those ops surfaced as the
    # explicit condition — the operations themselves succeeded
    assert any("source-committed-parity-incomplete" in d for d in fresh.diagnostics)


def test_missing_middle_activation_mirror_repaired_by_source_ref(
    tmp_path: Path,
) -> None:
    """A gap in the MIDDLE of activation mirrors (later mirrors present) is
    found and filled by source ref — position-based matching would misalign
    every later mirror."""
    store = _evolved_store(tmp_path)
    store.rollback()
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")
    assert parity_status(store).complete

    # mirrors (in journal order): gen0, act0, gen1, act1, act2(rollback), act3(promote)
    _drop_mirror_lines(store, drop={3})  # the 'evolved' activation mirror, mid-history
    report = parity_status(store)
    assert not report.complete
    assert len(report.missing_source_ordinals) == 1
    assert not report.mismatched  # later mirrors still match their own refs

    repaired = run_backfill_operation(store, "parity-repair")
    assert repaired.complete
    # active derivation follows SOURCE order even though the repaired mirror
    # was appended last in the mirror journal
    assert active_revision_id(store) == "rev-0001"
    activations = store.revision_activations()
    assert [a.reason for a in activations] == ["seed", "evolved", "rollback", "promote"]


def test_active_revision_follows_source_order_not_append_order(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    store.rollback()  # active = gen-0000
    _drop_mirror_lines(store, drop={1})  # drop the SEED activation mirror
    run_backfill_operation(store, "parity-repair")  # re-appends seed mirror LAST
    # append order now ends with the seed mirror; source order ends with rollback
    assert active_revision_id(store) == "rev-0000"
    mirrors = [
        m for m in store.mirror.entries() if isinstance(m, ActivationMirror)
    ]
    assert mirrors[-1].activation.reason == "seed"  # appended last…
    assert max(mirrors, key=lambda m: m.source.ordinal).activation.reason == "rollback"


# -- 2. durable operation state machine ---------------------------------------------------


def _strip_all_mirrors(store: Store) -> None:
    kept = [
        l for l in _mirror_lines(store)
        if json.loads(l)["schema"] not in ("revision-mirror@1", "activation-mirror@1")
    ]
    store.mirror.path.write_text("\n".join(kept) + "\n" if kept else "")


def test_backfill_journals_intent_progress_completed(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    report = run_backfill_operation(store, "0002-revision-backfill")
    assert report.complete
    kinds = [type(e).__name__ for e in store.mirror.entries()]
    assert kinds.index("MigrationIntent") < kinds.index("RevisionMirror")
    assert "MigrationProgress" in kinds
    assert kinds[-1] == "MigrationCompleted"
    intent = next(e for e in store.mirror.entries() if isinstance(e, MigrationIntent))
    assert intent.projector_ref == PROJECTOR_REF
    assert intent.source_head == len(store.entries())
    assert open_intent(store.mirror) is None  # completed


def test_backfill_resumes_at_every_crash_point(tmp_path: Path) -> None:
    """Crash before first mirror, midway, after parity, before completion —
    resume finishes the SAME intent, preserving its source head/hash."""
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)

    # crash point 1: intent persisted, no mirrors yet
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    intent = MigrationIntent(
        op_id="op-crash", migration_id="0002-revision-backfill",
        source_head=snapshot.head, source_hash=snapshot.journal_hash,
        projector_ref=PROJECTOR_REF, started_at=now_iso(),
    )
    store.mirror.append(intent)
    assert open_intent(store.mirror) == intent
    assert [m.migration_id for m in pending_migrations(store.root, SUM_INTEGERS_TASK)] == [
        "0002-revision-backfill"
    ]

    # crash point 2: midway — publish a strict subset of the plan
    plan = plan_projection(snapshot, store.mirror.entries())
    partial = plan.mirrors[:1]
    for text, _ in plan.payloads:
        store.objects.put_text(text)
    for mirror in partial:
        store.mirror.append(mirror)
    assert not parity_status(store).complete
    assert open_intent(store.mirror) == intent  # same op, same head/hash

    # resume: completes the same intent
    report = run_backfill_operation(store, "0002-revision-backfill")
    assert report.complete
    completed = [e for e in store.mirror.entries() if isinstance(e, MigrationCompleted)]
    assert [c.op_id for c in completed] == ["op-crash"]
    assert snapshot.journal_hash[:12] in completed[0].detail

    # crash point 3/4: parity complete but no completion record → still pending
    store2 = _evolved_store(tmp_path / "second")
    _strip_all_mirrors(store2)
    run_backfill_operation(store2, "0002-revision-backfill")
    # simulate: remove ONLY the completion record
    lines = [
        l for l in _mirror_lines(store2)
        if json.loads(l)["schema"] != "migration-completed@1"
    ]
    store2.mirror.path.write_text("\n".join(lines) + "\n")
    assert parity_status(store2).complete  # parity alone says done…
    assert open_intent(store2.mirror) is not None  # …but the op is not
    assert [m.migration_id for m in pending_migrations(store2.root, SUM_INTEGERS_TASK)] == [
        "0002-revision-backfill"
    ]
    reports = apply_pending(store2.root, SUM_INTEGERS_TASK)
    assert len(reports) == 1 and "resumed" in reports[0].detail
    assert open_intent(store2.mirror) is None


def test_pending_is_by_completion_not_parity(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    assert pending_migrations(store.root, SUM_INTEGERS_TASK) == []  # live dual-write
    assert apply_pending(store.root, SUM_INTEGERS_TASK) == []


# -- 3. plan/apply split -------------------------------------------------------------------


def test_projection_planning_is_pure_and_parity_is_read_only(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    objects_before = sorted(p.name for p in store.objects.root.rglob("*") if p.is_file())
    mirror_before = store.mirror.path.read_text()

    snapshot = capture_snapshot(store)
    plan = plan_projection(snapshot, store.mirror.entries())
    assert plan.mirrors and plan.payloads
    report = parity_status(store)
    assert not report.complete

    # neither planning nor parity published anything
    objects_after = sorted(p.name for p in store.objects.root.rglob("*") if p.is_file())
    assert objects_after == objects_before
    assert store.mirror.path.read_text() == mirror_before


def test_stale_projection_plan_is_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    plan = plan_projection(capture_snapshot(store), store.mirror.entries())
    run_cycle(store, SUM_INTEGERS_TASK)  # source advances under the plan
    with pytest.raises(ParityError, match="stale projection plan"):
        apply_projection(store, store.mirror, plan)


def test_source_committed_parity_incomplete_condition(tmp_path: Path) -> None:
    """If a source record commits but mirror publication fails, the operation
    succeeds and reports the explicit condition — never 'uncommitted'."""
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    # break the mirror journal path to force publication failure
    store.mirror.path.mkdir(parents=True)  # a directory: appends will fail
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted  # committed
    assert store.active_generation() is not None
    assert any(
        "source-committed-parity-incomplete" in d for d in store.diagnostics
    )


# -- 4/5. operation-specific evidence + fail-closed projector ------------------------------


def test_legacy_activation_mirrors_carry_no_decision_ref(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    for activation in store.revision_activations():
        assert activation.decision_ref is None  # evidence is operation-specific
    # the generation's original decision survives ONLY in provenance
    accepted = next(r for r in store.revisions() if r.ref.revision_id == "rev-0001")
    assert accepted.provenance_ref is not None
    provenance: MigrationProvenance = codec.loads(
        store.objects.get_text(accepted.provenance_ref), MigrationProvenance
    )
    assert provenance.decision_ref is not None
    assert provenance.surface == "strategy-code"  # Generation.surface preserved
    decision: object = codec.loads(store.objects.get_text(provenance.decision_ref))
    from strive.contracts import Decision

    assert isinstance(decision, Decision) and decision.accepted


def test_unsupported_projector_ref_is_flagged_and_repair_refuses(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    doctored = lines[0].replace(PROJECTOR_REF, "generation-to-revision@9")
    store.mirror.path.write_text("\n".join([doctored] + lines[1:]) + "\n")

    report = parity_status(store)
    assert any("unsupported projector" in issue for issue in report.mismatched)
    with pytest.raises(ParityError):
        run_backfill_operation(store, "parity-repair")


def test_source_validation_fails_closed_with_structured_errors(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = capture_snapshot(store)
    validate_source_history(snapshot)  # sane history passes

    import dataclasses

    # unsupported surface
    seed_generation = snapshot.records[0].generation
    assert seed_generation is not None
    bad_surface = dataclasses.replace(seed_generation, surface="prompt")
    doctored = dataclasses.replace(
        snapshot,
        records=(dataclasses.replace(snapshot.records[0], generation=bad_surface),)
        + snapshot.records[1:],
    )
    with pytest.raises(ParityError, match="supports 'strategy-code' only"):
        validate_source_history(doctored)

    # activation targeting a missing generation
    seed_activation = snapshot.records[1].activation
    assert seed_activation is not None
    orphan = dataclasses.replace(seed_activation, generation_id="gen-9999")
    doctored = dataclasses.replace(
        snapshot,
        records=(snapshot.records[0],)
        + (dataclasses.replace(snapshot.records[1], activation=orphan),)
        + snapshot.records[2:],
    )
    with pytest.raises(ParityError, match="unknown generation"):
        validate_source_history(doctored)

    # parent that does not precede its child
    reordered = dataclasses.replace(snapshot, records=tuple(reversed(snapshot.records)))
    with pytest.raises(ParityError, match="acyclic|precede"):
        validate_source_history(reordered)


def test_explicit_activation_evidence_can_differ_from_generation_decision() -> None:
    """A future revision-native activation supplies its own evidence; the
    contract represents evidence that differs from the generation's original
    decision (e.g. a fresh promote-time comparison)."""
    from strive.revisions import RevisionActivation, RevisionRef, ScopeRef

    fresh_evidence_ref = "ab" * 32  # a different decision than the original
    activation = RevisionActivation(
        revision=RevisionRef(ScopeRef("task", "sum-integers"), "rev-0001"),
        mode="durable",
        reason="promote",
        at="t",
        policy_ref="paired-deterministic@1",
        decision_ref=fresh_evidence_ref,
    )
    assert activation.decision_ref == fresh_evidence_ref  # explicit, not inferred


# -- 6. permanent controls -----------------------------------------------------------------


def test_mirror_disabled_control_run_is_generation_identical(tmp_path: Path) -> None:
    """Dual-write on vs mirror publication off: generation-native records,
    cycle results, active generation, and replay are identical."""
    with_mirror = Store(tmp_path / "on", SUM_INTEGERS_TASK.task_id)
    without_mirror = Store(
        tmp_path / "off", SUM_INTEGERS_TASK.task_id, mirror_enabled=False
    )
    report_on = run_cycle(with_mirror, SUM_INTEGERS_TASK)
    report_off = run_cycle(without_mirror, SUM_INTEGERS_TASK)

    def structure(store: Store) -> list[tuple[str, ...]]:
        out: list[tuple[str, ...]] = []
        for line in store.ledger_path.read_text().splitlines():
            record = json.loads(line)
            out.append(
                (
                    record["schema"],
                    str(record.get("generation_id", "")),
                    str(record.get("reason", "")),
                    str(record.get("accepted", "")),
                    str(record.get("overall_score", "")),
                )
            )
        return out

    assert structure(with_mirror) == structure(without_mirror)
    assert report_on.evaluation.overall_score == report_off.evaluation.overall_score
    assert report_on.decision is not None and report_off.decision is not None
    assert report_on.decision.accepted == report_off.decision.accepted
    a_on, a_off = with_mirror.active_generation(), without_mirror.active_generation()
    assert a_on is not None and a_off is not None
    assert a_on.generation_id == a_off.generation_id
    replay_on = replay_run(with_mirror, SUM_INTEGERS_TASK, report_on.run_id)
    replay_off = replay_run(without_mirror, SUM_INTEGERS_TASK, report_off.run_id)
    assert replay_on.matches and replay_off.matches
    assert replay_on.decision_matches is True and replay_off.decision_matches is True
    # and the disabled store wrote no mirrors at all
    assert not without_mirror.mirror.path.exists() or not _mirror_lines(without_mirror)


def test_cross_task_mirror_isolation(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    sum_store = Store(root, SUM_INTEGERS_TASK.task_id)
    run_cycle(sum_store, SUM_INTEGERS_TASK)
    max_store = Store(root, MAX_INTEGERS_TASK.task_id)
    from strive.loop import ensure_seeded

    ensure_seeded(max_store, MAX_INTEGERS_TASK)
    assert parity_status(sum_store).complete
    assert parity_status(max_store).complete

    # a foreign-task mirror smuggled into the journal is rejected on read
    alien = next(
        e for e in max_store.mirror.entries() if isinstance(e, RevisionMirror)
    )
    with sum_store.mirror.path.open("a") as handle:
        handle.write(codec.dumps(alien) + "\n")
    with pytest.raises(MirrorError, match="task-isolation violation"):
        Store(root, SUM_INTEGERS_TASK.task_id).mirror.entries()


def test_migration_registry_chain_from_legacy(tmp_path: Path) -> None:
    from test_migration import _write_legacy_root

    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    assert [m.migration_id for m in MIGRATIONS] == [
        "0001-legacy-unscoped-ledger",
        "0002-revision-backfill",
    ]
    reports = apply_pending(root, SUM_INTEGERS_TASK)
    assert [r.migration_id for r in reports] == [
        "0001-legacy-unscoped-ledger",
        "0002-revision-backfill",
    ]
    store = Store(root, SUM_INTEGERS_TASK.task_id)
    assert parity_status(store).complete
    assert active_revision_id(store) == "rev-0001"
    # idempotent: nothing pending, re-apply is a no-op
    assert pending_migrations(root, SUM_INTEGERS_TASK) == []
    assert apply_pending(root, SUM_INTEGERS_TASK) == []
