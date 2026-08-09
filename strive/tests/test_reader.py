"""Stage-3B.2: the read boundary, cutover evidence, and the reversible
revision-read canary.

Adversarial coverage: ephemeral candidates, non-active compare/replay/audit
subjects, stale rollback/activation, concurrent coverage writers, early
exceptions, missing expected checks, epoch resets, low samples, breaker
opening/recovery, the kill switch, and restart in every mode.
"""

import json
import threading
from pathlib import Path

import pytest

from strive import codec
from strive.contracts import Event, INTERVENTION_SHADOW_DIVERGENCE
from strive.dualwrite import rebuild_mirror, run_backfill_operation
from strive.events import EventLog, now_iso
from strive.loop import (
    audit_generation,
    compare_generations,
    promote_generation,
    replay_run,
    rollback_generation,
    run_cycle,
)
from strive.reader import (
    MODE_CANARY,
    MODE_NATIVE,
    MODE_SHADOW,
    OUTCOME_AGREED,
    OUTCOME_DIVERGED,
    OUTCOME_MISSING,
    OUTCOME_UNAVAILABLE,
    OperationSummary,
    ReadCheck,
    ReaderError,
    StateReader,
    VerifiedRevisionSnapshot,
    clear_breaker,
    cutover_eligibility,
    enable_canary,
    kill_switch,
    read_coverage,
    reader_journal,
    reader_state,
    set_mode,
    verify_revision_snapshot,
)
from strive.revisions import (
    HarnessRevision,
    ResolvedHarnessManifest,
    RevisionProvenance,
    ScopeManifest,
)
from strive.store import Store, StoreError
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK


def _evolved_store(tmp_path: Path, name: str = "artifacts") -> Store:
    store = Store(tmp_path / name, TASK.task_id)
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    return store


def _status_read(store: Store, restart: bool = False) -> str:
    reader = StateReader(store, "status")
    try:
        reader.read_active("status-active")
        if restart:
            reader.add_fact("restart")
        return reader._checks[-1].outcome if reader._checks else "none"
    finally:
        reader.finish(None)


def _exercise_all_paths(store: Store) -> None:
    """Deterministic burn-in exercising every required subject and path."""
    set_mode(store, MODE_SHADOW, "test burn-in")
    active = store.active_generation()
    if active is not None and active.parent_id is not None:
        rollback_generation(store)  # weak incumbent so the next cycle evolves
    first = run_cycle(store, TASK)  # accepted evolution
    assert first.decision is not None and first.decision.accepted
    run_cycle(store, TASK)  # healthy: no weakness -> no candidate
    run_cycle(store, TASK)
    compare_generations(store, TASK, "gen-0001", "gen-0000")  # rejected decision
    replay_run(store, TASK, first.run_id)
    audit_generation(store, TASK)
    rollback_generation(store)
    promote_generation(store, TASK, "gen-0001")  # re-promotion after rollback
    reopened = Store(store.root, TASK.task_id)  # the restart read
    reader = StateReader(reopened, "lineage")
    try:
        reader.read_lineage("status-lineage")
    finally:
        reader.finish(None)
    _status_read(reopened, restart=True)


def _events(store: Store, run_id: str) -> list[Event]:
    return EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()


# -- modes: defaults, persistence, restart ------------------------------------------------------


def test_default_mode_is_native_with_no_derived_reads(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    state = reader_state(store)
    assert state.mode == MODE_NATIVE and not state.breaker_open
    coverage = read_coverage(store)
    assert coverage.agreed == 0 and coverage.diverged == 0
    assert coverage.native_only > 0  # reads were routed, comparisons off
    verdict = cutover_eligibility(store)
    assert not verdict.eligible  # absence of divergence records is not evidence


def test_restart_preserves_mode_in_every_mode(tmp_path: Path) -> None:
    # native
    native = _evolved_store(tmp_path, "native")
    assert reader_state(Store(native.root, TASK.task_id)).mode == MODE_NATIVE
    assert _status_read(Store(native.root, TASK.task_id)) == "native"
    # shadow
    shadow = _evolved_store(tmp_path, "shadow")
    set_mode(shadow, MODE_SHADOW, "test")
    reopened = Store(shadow.root, TASK.task_id)
    assert reader_state(reopened).mode == MODE_SHADOW
    assert _status_read(reopened) == OUTCOME_AGREED
    # revision-canary
    canary = Store(tmp_path / "canary", TASK.task_id)
    _exercise_all_paths(canary)
    enable_canary(canary)
    reopened = Store(canary.root, TASK.task_id)
    assert reader_state(reopened).mode == MODE_CANARY
    assert _status_read(reopened) == OUTCOME_AGREED
    assert not reader_state(reopened).breaker_open
    report = run_cycle(reopened, TASK)  # a full canary-mode operation
    assert report.generation_after == "gen-0001"


def test_mirror_disabled_forces_native_and_records_nothing(tmp_path: Path) -> None:
    store = Store(tmp_path / "off", TASK.task_id, mirror_enabled=False)
    run_cycle(store, TASK)
    reader = StateReader(store, "status")
    assert reader.mode == MODE_NATIVE
    reader.finish(None)
    assert not reader_journal(store).path.exists()


# -- evidence: coverage, epochs, eligibility ----------------------------------------------------


def test_burn_in_reaches_eligibility_and_enables_canary(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    verdict = cutover_eligibility(store)
    assert verdict.eligible, verdict.reasons
    coverage = verdict.coverage
    assert coverage.diverged == coverage.unavailable == coverage.missing == 0
    assert coverage.agreed >= 20
    enable_canary(store)
    assert reader_state(store).mode == MODE_CANARY


def test_low_samples_refuse_canary(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    run_cycle(store, TASK)  # one operation is nowhere near enough
    verdict = cutover_eligibility(store)
    assert not verdict.eligible
    assert any("declared minimum" in r for r in verdict.reasons)
    assert any("required path" in r for r in verdict.reasons)
    with pytest.raises(ReaderError, match="eligibility not met"):
        enable_canary(store)


def test_missing_expected_checks_block_eligibility(tmp_path: Path) -> None:
    """An operation that never records its expected subjects gets them
    synthesized as `missing` — uninstrumented paths lower coverage."""
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    reader = StateReader(store, "cycle")
    reader.finish(None, status="ok")  # recorded NOTHING for cycle-*
    coverage = read_coverage(store)
    assert coverage.missing == 2  # cycle-baseline + cycle-candidate
    verdict = cutover_eligibility(store)
    assert any("never recorded" in r for r in verdict.reasons)


def test_early_exception_still_records_evidence_in_finally(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")

    class ExplodingDiagnoser:
        def diagnose(self, ctx: object) -> None:
            raise RuntimeError("diagnoser exploded")

    from strive.loop import LoopConfig

    with pytest.raises(RuntimeError, match="diagnoser exploded"):
        run_cycle(store, TASK, LoopConfig(diagnoser=ExplodingDiagnoser()))

    entries, errors = reader_journal(store).entries()
    assert errors == 0
    summaries = [e for e in entries if isinstance(e, OperationSummary)]
    assert summaries[-1].status == "error:RuntimeError"
    checks = [e for e in entries if isinstance(e, ReadCheck)]
    failing_op = [c for c in checks if c.op_id == summaries[-1].op_id]
    assert any(c.outcome == OUTCOME_AGREED for c in failing_op)  # baseline ran
    assert any(
        c.subject == "cycle-candidate" and c.outcome == OUTCOME_MISSING
        for c in failing_op
    )


def test_check_rows_carry_versions_epoch_op_and_heads(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    _status_read(store)
    entries, _ = reader_journal(store).entries()
    check = [e for e in entries if isinstance(e, ReadCheck)][-1]
    assert check.reader_version == "state-reader@1"
    assert check.projector_ref == "generation-to-revision@1"
    assert check.epoch.startswith("epoch-")
    assert check.op_id.startswith("op-")
    count, _, digest = check.canonical_head.partition(":")
    assert count.isdigit() and len(digest) == 64
    count, _, digest = check.mirror_head.partition(":")
    assert count.isdigit() and len(digest) == 64


def test_epoch_resets_on_repair_and_excludes_old_evidence(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    assert cutover_eligibility(store).eligible
    raw_before = reader_journal(store).path.read_bytes()

    rebuild_mirror(store)  # repair: derived history was rebuilt
    verdict = cutover_eligibility(store)
    assert not verdict.eligible  # fresh epoch, no current evidence
    assert read_coverage(store).total == 0
    # old evidence is preserved byte-for-byte, just not current
    assert reader_journal(store).path.read_bytes().startswith(raw_before)


def test_concurrent_coverage_writers_never_interleave(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    journal = reader_journal(store)
    before, _ = journal.entries()

    def write_batch(worker: int) -> None:
        for i in range(25):
            journal.append(
                ReadCheck(
                    epoch="epoch-test", op_id=f"op-{worker}-{i}",
                    operation="status", subject="status-active",
                    mode=MODE_SHADOW, outcome=OUTCOME_AGREED, detail="t",
                    canonical_head="0:0", mirror_head="0:0",
                    reader_version="state-reader@1",
                    projector_ref="generation-to-revision@1", at=now_iso(),
                )
            )

    threads = [threading.Thread(target=write_batch, args=(w,)) for w in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    entries, errors = journal.entries()
    assert errors == 0
    assert len(entries) == len(before) + 100  # every locked append intact


# -- honest evaluated subjects ------------------------------------------------------------------


def test_ephemeral_candidate_overlay_is_immutable_and_unactivated(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    events = _events(store, report.run_id)
    overlay_events = [e for e in events if e.type == "candidate_overlay"]
    assert len(overlay_events) == 1
    revision_ref = str(overlay_events[0].payload["revision_ref"])

    overlay: HarnessRevision = codec.loads(
        store.objects.get_text(revision_ref), HarnessRevision
    )
    assert overlay.ref.revision_id.startswith("rev-cand-")
    assert overlay.base_parent is not None
    assert overlay.base_parent.revision_id == "rev-0000"
    assert overlay.provenance_ref is not None
    provenance: RevisionProvenance = codec.loads(
        store.objects.get_text(overlay.provenance_ref), RevisionProvenance
    )
    assert provenance.origin == "candidate-overlay"  # native, not migration
    # unactivated and never in the mirror journal
    snapshot = verify_revision_snapshot(store)
    assert overlay.ref.revision_id not in snapshot.revisions
    assert all(
        a.revision.revision_id != overlay.ref.revision_id
        for a in snapshot.activations
    )

    # the candidate execution names the overlay as its subject and the
    # PRE-ACTIVATION baseline as the resolved harness it ran under
    records = {
        str(e.payload["subject"]): e.payload
        for e in events
        if e.type == "execution_record"
    }
    candidate_payload = records["cycle-candidate"]
    assert candidate_payload["subject_kind"] == "candidate-overlay"
    from strive.reader import ExecutionRecord

    record: ExecutionRecord = codec.loads(
        store.objects.get_text(str(candidate_payload["execution_record_ref"])),
        ExecutionRecord,
    )
    assert record.subject_revision_ref == revision_ref
    assert record.base_resolved_ref is not None
    base: ResolvedHarnessManifest = codec.loads(
        store.objects.get_text(record.base_resolved_ref), ResolvedHarnessManifest
    )
    assert base.contributions[0].revision.revision_id == "rev-0000"
    # the baseline harness binds the BASELINE source — never the candidate's
    seed = store.generations()["gen-0000"]
    candidate = store.generations()["gen-0001"]
    assert base.effective[0].binding.content_ref == seed.source_ref
    assert record.effective_manifest_ref is not None
    subject_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(record.effective_manifest_ref), ScopeManifest
    )
    assert subject_manifest.bindings[0].binding.content_ref == candidate.source_ref


def test_non_active_subjects_are_never_claimed_as_the_active_baseline(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)  # active: gen-0001
    set_mode(store, MODE_SHADOW, "test")
    compare_generations(store, TASK, "gen-0000", "gen-0001")
    compare_run = sorted(
        p.name for p in store.runs_dir.iterdir() if p.name.startswith("compare-")
    )[-1]
    records = {}
    from strive.reader import ExecutionRecord

    for event in _events(store, compare_run):
        if event.type == "execution_record":
            records[str(event.payload["subject"])] = codec.loads(
                store.objects.get_text(str(event.payload["execution_record_ref"])),
                ExecutionRecord,
            )
    left = records["compare-left"]  # gen-0000: retained, NOT active
    right = records["compare-right"]  # gen-0001: the active incumbent
    assert left.subject_kind == "retained-revision"
    assert right.subject_kind == "active-revision"
    seed = store.generations()["gen-0000"]
    active = store.generations()["gen-0001"]
    # both ran under the ACTIVE baseline harness...
    for record in (left, right):
        assert record.base_resolved_ref is not None
        base: ResolvedHarnessManifest = codec.loads(
            store.objects.get_text(record.base_resolved_ref), ResolvedHarnessManifest
        )
        assert base.contributions[0].revision.revision_id == "rev-0001"
        assert base.effective[0].binding.content_ref == active.source_ref
    # ... but the non-active subject's own manifest binds ITS source
    assert left.effective_manifest_ref is not None
    left_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(left.effective_manifest_ref), ScopeManifest
    )
    assert left_manifest.bindings[0].binding.content_ref == seed.source_ref


# -- stale mutations ----------------------------------------------------------------------------


def test_stale_rollback_and_activation_are_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    reader = StateReader(store, "rollback")
    stale_head = reader.canonical_head
    # a concurrent writer moves the ledger after the read snapshot
    Store(store.root, TASK.task_id).activate(
        "gen-0001", reason="promote", policy="manual@0"
    )
    with pytest.raises(StoreError, match="stale read head"):
        store.rollback(expected_head=stale_head)
    with pytest.raises(StoreError, match="stale read head"):
        store.activate(
            "gen-0001", reason="promote", policy="manual@0",
            expected_head=stale_head,
        )
    reader.finish(None, status="stale")


# -- canary authority, breaker, kill switch ------------------------------------------------------


def _doctored_reader(store: Store, operation: str = "status") -> StateReader:
    """Simulate a derivation bug: a verified-looking snapshot whose active
    revision is wrong (the seed activation only)."""
    real = verify_revision_snapshot(store)
    assert real.available
    reader = StateReader(store, operation)
    reader._snapshot = VerifiedRevisionSnapshot(
        available=True,
        reason="ok",
        revisions=real.revisions,
        activations=real.activations[:1],
        sources=real.sources,
    )
    return reader


def test_divergence_in_canary_opens_durable_breaker(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)

    reader = _doctored_reader(store)
    check_outcome = None
    try:
        reader.read_active("status-active")
        check_outcome = reader._checks[-1].outcome
    finally:
        reader.finish(None)
    assert check_outcome == OUTCOME_DIVERGED
    state = reader_state(store)
    assert state.breaker_open
    assert state.breaker_reason is not None and "divergence" in state.breaker_reason
    # the divergence is also a durable canonical intervention
    assert any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )
    # canary use is blocked: mode is still canary, but reads run as shadow
    blocked = StateReader(store, "status")
    assert blocked.mode == MODE_CANARY and blocked.effective_mode == MODE_SHADOW
    blocked.finish(None)
    # canary cannot be re-enabled over an open breaker
    with pytest.raises(ReaderError, match="breaker is open"):
        enable_canary(store)
    # the kill switch returns immediately to native
    kill_switch(store)
    assert reader_state(store).mode == MODE_NATIVE


def test_unavailable_in_canary_opens_breaker_and_never_fails_the_operation(
    tmp_path: Path,
) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    # derived state becomes unavailable (drop the newest mirror line)
    lines = [l for l in store.mirror.path.read_text().splitlines() if l.strip()]
    store.mirror.path.write_text("\n".join(lines[:-1]) + "\n")

    outcome = _status_read(store)  # canonical operation still succeeds
    assert outcome == OUTCOME_UNAVAILABLE
    state = reader_state(store)
    assert state.breaker_open and state.mode == MODE_CANARY
    report = run_cycle(store, TASK)  # full operations keep committing
    assert report.run_id
    # no divergence was fabricated: unavailable is not divergent
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )


def test_breaker_recovery_requires_repair_and_fresh_evidence(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    lines = [l for l in store.mirror.path.read_text().splitlines() if l.strip()]
    store.mirror.path.write_text("\n".join(lines[:-1]) + "\n")
    _status_read(store)
    assert reader_state(store).breaker_open

    kill_switch(store)  # step 1: back to native
    run_backfill_operation(store, "parity-repair")  # step 2: repair (epoch resets)
    clear_breaker(store, "repaired and verified")  # step 3: close the breaker
    assert not reader_state(store).breaker_open
    with pytest.raises(ReaderError, match="eligibility not met"):
        enable_canary(store)  # old evidence is excluded: must re-earn
    _exercise_all_paths(store)  # step 4: fresh burn-in in the new epoch
    enable_canary(store)
    assert reader_state(store).mode == MODE_CANARY
    assert _status_read(store) == OUTCOME_AGREED


def test_canary_and_shadow_histories_are_canonically_identical(
    tmp_path: Path,
) -> None:
    """The same deterministic operation sequence, one store staying in
    shadow, one cut over to the canary: canonical ledgers stay identical
    (activation and promotion remain generation-native)."""
    stores = {
        "shadow": Store(tmp_path / "shadow", TASK.task_id),
        "canary": Store(tmp_path / "canary", TASK.task_id),
    }
    for store in stores.values():
        _exercise_all_paths(store)
    enable_canary(stores["canary"])
    for store in stores.values():
        run_cycle(store, TASK)
        rollback_generation(store)
        promote_generation(store, TASK, "gen-0001")
        run_cycle(store, TASK)

    def canonical(store: Store) -> list[tuple[str, ...]]:
        out: list[tuple[str, ...]] = []
        for line in store.ledger_path.read_text().splitlines():
            record = json.loads(line)
            out.append(
                (record["schema"], str(record.get("generation_id", "")),
                 str(record.get("reason", "")), str(record.get("accepted", "")),
                 str(record.get("overall_score", "")))
            )
        return out

    assert canonical(stores["shadow"]) == canonical(stores["canary"])
    assert not reader_state(stores["canary"]).breaker_open
    # the canary really served revision-derived reads: agreed checks exist
    # under revision-canary mode in the journal
    entries, _ = reader_journal(stores["canary"]).entries()
    canary_checks = [
        e
        for e in entries
        if isinstance(e, ReadCheck) and e.mode == MODE_CANARY
    ]
    assert canary_checks and all(
        c.outcome in (OUTCOME_AGREED, "not-applicable", "native")
        for c in canary_checks
    )
