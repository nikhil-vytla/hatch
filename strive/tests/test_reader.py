"""Stage-3B.2 (corrected): the read boundary, trustworthy cutover evidence,
and the fail-closed reversible revision-read canary.

Adversarial coverage: coherent-capture interleavings, ephemeral candidates,
overlay failure without silent fallback, retention identity, stale
rollback/activation, concurrent coverage writers, early exceptions, missing
expected checks, epoch resets (repair + shadow entry), low samples,
fact-counting discipline, frame tampering (forgery/deletion/truncation),
malicious candidate code, canary refusal for unsafe model code, breaker
recovery, the journal-independent force-native override, and restart in
every mode.
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
    LoopConfig,
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
    BreakerEvent,
    ExecutionRecord,
    ModeChange,
    OperationSummary,
    ReadCheck,
    ReaderError,
    RetentionRecord,
    StateReader,
    VerifiedRevisionSnapshot,
    clear_breaker,
    cutover_eligibility,
    enable_canary,
    force_native,
    kill_switch,
    lift_force_native,
    quarantine_reader_journal,
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
from strive.sandbox import run_strategy
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
        return next(iter(reader._checks.values())).outcome if reader._checks else "none"
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
    _status_read(reopened)


def _events(store: Store, run_id: str) -> list[Event]:
    return EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()


def _checks(store: Store) -> list[ReadCheck]:
    view = reader_journal(store).read()
    return [e for e in view.entries if isinstance(e, ReadCheck)]


def _summaries(store: Store) -> list[OperationSummary]:
    view = reader_journal(store).read()
    return [e for e in view.entries if isinstance(e, OperationSummary)]


# -- coherent capture --------------------------------------------------------------------------


def test_capture_retries_when_writers_move_the_ledger(tmp_path: Path) -> None:
    """Deterministic concurrency: a writer appends between EVERY capture step;
    the reader must never pair an old canonical capture with a newer mirror
    capture — it retries until the pair is coherent."""
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    writer = Store(store.root, TASK.task_id)
    appended = {"count": 0}

    class InterleavingReader(StateReader):
        def _on_capture_step(self, step: str) -> None:
            if step == "mirror" and appended["count"] < 2:
                appended["count"] += 1
                # a concurrent writer commits a full record + live mirror
                # between the canonical read and the coherence recheck
                writer.activate("gen-0001", reason="promote", policy="manual@0")

    reader = InterleavingReader(store, "status")
    try:
        assert appended["count"] == 2  # the loop really was interleaved
        # the final capture is coherent: the snapshot verified against the
        # SAME canonical bytes the native view derives from
        assert reader._snapshot.available, reader._snapshot.reason
        outcome = reader.read_active("status-active")
        assert outcome is not None
        assert next(iter(reader._checks.values())).outcome == OUTCOME_AGREED
        # the native view includes the concurrent appends (it was retaken)
        head_count = int(reader.canonical_head.split(":")[0])
        assert head_count == len(store.entries())
    finally:
        reader.finish(None)


def test_capture_gives_up_cleanly_under_persistent_interleaving(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    writer = Store(store.root, TASK.task_id)

    class HostileReader(StateReader):
        def _on_capture_step(self, step: str) -> None:
            if step == "mirror":  # move the ledger on EVERY attempt
                writer.activate("gen-0001", reason="promote", policy="manual@0")

    reader = HostileReader(store, "status")
    try:
        assert not reader._snapshot.available
        assert "coherent capture failed" in reader._snapshot.reason
        # the canonical operation still works from the last native capture
        assert reader.native_active() is not None
    finally:
        reader.finish(None)


def test_snapshot_and_native_view_derive_from_one_capture(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    reader = StateReader(store, "status")
    try:
        # the verified snapshot covers EXACTLY the entries of the native view
        head_count = int(reader.canonical_head.split(":")[0])
        assert head_count == len(reader.ledger_entries())
        source_records = sum(
            1
            for e in reader.ledger_entries()
            if type(e).__name__ in ("Generation", "Activation")
        )
        assert (
            len(reader._snapshot.revisions) + len(reader._snapshot.activations)
            == source_records
        )
    finally:
        reader.finish(None)


# -- modes: defaults, persistence, restart, override ---------------------------------------------


def test_default_mode_is_native_with_no_derived_reads(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    state = reader_state(store)
    assert state.mode == MODE_NATIVE and not state.breaker_open
    coverage = read_coverage(store)
    assert coverage.agreed == 0 and coverage.diverged == 0
    assert coverage.native_only > 0  # reads were routed, comparisons off
    assert coverage.facts == ()  # native operations contribute NO facts
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


def test_force_native_override_is_journal_independent(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    assert reader_state(store).mode == MODE_CANARY

    force_native(store, "emergency")
    state = reader_state(store)
    assert state.mode == MODE_NATIVE and state.forced_native
    assert state.configured_mode == MODE_CANARY  # the journal was not touched
    reader = StateReader(store, "status")
    assert reader.mode == MODE_NATIVE  # reads are native NOW
    reader.finish(None)
    with pytest.raises(ReaderError, match="force-native override"):
        enable_canary(store)

    lift_force_native(store)
    assert reader_state(store).mode == MODE_CANARY  # journal control resumes


def test_mirror_disabled_forces_native_and_records_nothing(tmp_path: Path) -> None:
    store = Store(tmp_path / "off", TASK.task_id, mirror_enabled=False)
    run_cycle(store, TASK)
    reader = StateReader(store, "status")
    assert reader.mode == MODE_NATIVE
    reader.finish(None)
    assert not reader_journal(store).path.exists()


# -- evidence: framing, epochs, facts, eligibility ------------------------------------------------


def test_burn_in_reaches_eligibility_and_enables_canary(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    verdict = cutover_eligibility(store)
    assert verdict.eligible, verdict.reasons
    coverage = verdict.coverage
    assert coverage.diverged == coverage.unavailable == coverage.missing == 0
    assert coverage.agreed >= 20
    enable_canary(store)
    state = reader_state(store)
    assert state.mode == MODE_CANARY
    # the transition persisted its eligibility proof and authorized head
    view = reader_journal(store).read()
    changes = [e for e in view.entries if isinstance(e, ModeChange)]
    assert changes[-1].mode == MODE_CANARY
    assert "agreed=" in changes[-1].proof and "parity=complete" in changes[-1].proof
    assert changes[-1].authorized_head.split(":")[0].isdigit()


def test_entering_shadow_starts_a_new_epoch(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    assert cutover_eligibility(store).eligible
    set_mode(store, MODE_SHADOW, "re-entered")  # NEW burn-in epoch
    verdict = cutover_eligibility(store)
    assert not verdict.eligible  # old evidence is excluded
    assert read_coverage(store).total == 0


def test_facts_count_only_from_successful_shadow_or_canary_operations(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)  # ran in NATIVE mode
    _status_read(store, restart=True)  # native op claims the restart fact
    assert read_coverage(store).facts == ()  # ... and it does not count

    set_mode(store, MODE_SHADOW, "test")

    class ExplodingDiagnoser:
        def diagnose(self, ctx: object) -> None:
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        run_cycle(store, TASK, LoopConfig(diagnoser=ExplodingDiagnoser()))
    # the failing operation recorded evidence but contributed NO facts
    coverage = read_coverage(store)
    assert "no-candidate" not in coverage.facts
    _status_read(store, restart=True)  # a successful shadow op
    assert "restart" in read_coverage(store).facts


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
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    reader = StateReader(store, "cycle")
    reader.finish(None, status="ok")  # recorded NOTHING for cycle-*
    coverage = read_coverage(store)
    assert coverage.missing == 3  # baseline + candidate-overlay + retained
    verdict = cutover_eligibility(store)
    assert any("never recorded" in r for r in verdict.reasons)


def test_early_exception_still_records_evidence_in_finally(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")

    class ExplodingDiagnoser:
        def diagnose(self, ctx: object) -> None:
            raise RuntimeError("diagnoser exploded")

    with pytest.raises(RuntimeError, match="diagnoser exploded"):
        run_cycle(store, TASK, LoopConfig(diagnoser=ExplodingDiagnoser()))

    summaries = _summaries(store)
    assert summaries[-1].status == "error:RuntimeError"
    failing_op = [c for c in _checks(store) if c.op_id == summaries[-1].op_id]
    assert any(c.outcome == OUTCOME_AGREED for c in failing_op)  # baseline ran
    assert any(
        c.subject == "cycle-candidate-overlay" and c.outcome == OUTCOME_MISSING
        for c in failing_op
    )


def test_check_rows_carry_versions_epoch_op_and_heads_at_check_time(
    tmp_path: Path,
) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    report = run_cycle(store, TASK)  # no-candidate cycle with an activation-free head
    del report
    last_cycle_op = [s for s in _summaries(store) if s.operation == "cycle"][-1].op_id
    rows = [c for c in _checks(store) if c.op_id == last_cycle_op]
    baseline = next(c for c in rows if c.subject == "cycle-baseline")
    assert baseline.reader_version == "state-reader@2"
    assert baseline.projector_ref == "generation-to-revision@1"
    assert baseline.epoch.startswith("epoch-")
    assert baseline.mode == MODE_SHADOW
    count, _, digest = baseline.canonical_head.partition(":")
    assert count.isdigit() and len(digest) == 64
    count, _, digest = baseline.mirror_head.partition(":")
    assert count.isdigit() and len(digest) == 64
    # heads were captured AT CHECK TIME: the baseline's head predates the
    # cycle record this operation appended afterwards
    assert int(baseline.canonical_head.split(":")[0]) < len(store.entries())
    # exactly one terminal outcome per (op_id, subject)
    keys = [(c.op_id, c.subject) for c in rows]
    assert len(keys) == len(set(keys))


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


def test_repair_control_update_is_not_best_effort(tmp_path: Path) -> None:
    """A repair whose reader-journal control update cannot be recorded must
    fail — never complete silently with a live canary on stale evidence."""
    store = _evolved_store(tmp_path)
    journal = reader_journal(store)
    journal.path.parent.joinpath(journal.path.name).unlink(missing_ok=True)
    journal.path.mkdir()  # appends now fail with IsADirectoryError

    with pytest.raises(Exception):
        run_backfill_operation(store, "parity-repair")


def test_concurrent_coverage_writers_never_interleave(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    journal = reader_journal(store)
    before = len(journal.read().entries)

    def write_batch(worker: int) -> None:
        for i in range(25):
            journal.append_batch(
                [
                    ReadCheck(
                        epoch="epoch-test", op_id=f"op-{worker}-{i}",
                        operation="status", subject="status-active",
                        mode=MODE_SHADOW, outcome=OUTCOME_AGREED, detail="t",
                        canonical_head="0:0", mirror_head="0:0",
                        reader_version="state-reader@2",
                        projector_ref="generation-to-revision@1", at=now_iso(),
                    )
                ]
            )

    threads = [threading.Thread(target=write_batch, args=(w,)) for w in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    view = journal.read()
    assert view.errors == 0  # every framed batch intact, chain unbroken
    assert len(view.entries) == before + 100


# -- tamper evidence -----------------------------------------------------------------------------


def test_unframed_forged_control_lines_are_never_honored(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    forged = codec.dumps(
        ModeChange(mode=MODE_CANARY, reason="forged", at=now_iso())
    )
    with reader_journal(store).path.open("a") as handle:
        handle.write(forged + "\n")

    state = reader_state(store)
    assert state.mode == MODE_SHADOW  # the forged mode change is ignored
    assert state.journal_errors >= 1  # ... and detected
    assert not cutover_eligibility(store).eligible


def test_deletion_and_reordering_break_the_frame_chain(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    run_cycle(store, TASK)
    journal = reader_journal(store)
    assert journal.read().errors == 0
    lines = journal.path.read_text().splitlines()

    # deletion of an interior line
    journal.path.write_text("\n".join(lines[:2] + lines[3:]) + "\n")
    assert journal.read().errors > 0
    # reordering
    reordered = list(lines)
    reordered[0], reordered[1] = reordered[1], reordered[0]
    journal.path.write_text("\n".join(reordered) + "\n")
    assert journal.read().errors > 0
    # restore
    journal.path.write_text("\n".join(lines) + "\n")
    assert journal.read().errors == 0


def test_malicious_candidate_tampering_is_detected_and_blocks_canary(
    tmp_path: Path,
) -> None:
    """Candidate code shares the controller's UID: it CAN write the reader
    journal. Naive forgeries (mode/breaker/evidence lines) are unframed and
    therefore never honored — and they poison eligibility, so the canary
    fails closed at the next operation start. This detection is best-effort
    against a reader-aware attacker, which is exactly why canary mode is
    REFUSED for real model-generated code (see the threat-model test)."""
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    journal = reader_journal(store)

    malicious = f'''
def solve(text):
    import pathlib
    p = pathlib.Path({str(journal.path)!r})
    with p.open("a") as handle:
        handle.write('{codec.dumps(BreakerEvent(state="cleared", reason="forged", at="2026-01-01T00:00:00Z"))}\\n')
        handle.write('{codec.dumps(ModeChange(mode=MODE_CANARY, reason="forged", at="2026-01-01T00:00:00Z"))}\\n')
    return sum(int(x) for x in text.replace(",", " ").split())
'''
    report = run_strategy(malicious, TASK.selection_cases(), generation_id="mal")
    assert report.ok  # the tampering attempt executed

    state = reader_state(store)
    assert state.journal_errors >= 2  # forged lines detected, not honored
    assert state.configured_mode == MODE_CANARY  # the forgery changed nothing
    assert not cutover_eligibility(store).eligible  # corruption blocks cutover
    # the canary fails closed at the next operation start: a corrupt journal
    # cannot be trusted to record a breaker, so the journal-INDEPENDENT
    # force-native override engages and reads run native, not canary
    _status_read(store)
    after = reader_state(store)
    assert after.forced_native and after.mode == MODE_NATIVE
    assert StateReader(store, "status").effective_mode != MODE_CANARY


def test_canary_is_refused_for_unsafe_model_code(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    with pytest.raises(StoreError, match="refused for real model-generated"):
        run_cycle(store, TASK, LoopConfig(unsafe_model_code=True))
    # native mode accepts the same configuration
    kill_switch(store)
    report = run_cycle(store, TASK, LoopConfig(unsafe_model_code=True))
    assert report.run_id


# -- honest evaluated subjects --------------------------------------------------------------------


def test_candidate_overlay_created_and_validated_in_every_mode(
    tmp_path: Path,
) -> None:
    for mode_setup in ("native", "shadow"):
        store = Store(tmp_path / mode_setup, TASK.task_id)
        if mode_setup == "shadow":
            set_mode(store, MODE_SHADOW, "test")
        report = run_cycle(store, TASK)
        assert report.decision is not None
        overlay_events = [
            e for e in _events(store, report.run_id) if e.type == "candidate_overlay"
        ]
        assert len(overlay_events) == 1, mode_setup  # created in EVERY mode
        revision: HarnessRevision = codec.loads(
            store.objects.get_text(str(overlay_events[0].payload["revision_ref"])),
            HarnessRevision,
        )
        assert revision.ref.revision_id.startswith("rev-cand-")
        assert revision.base_parent is not None
        assert revision.base_parent.revision_id == "rev-0000"
        assert revision.provenance_ref is not None
        provenance: RevisionProvenance = codec.loads(
            store.objects.get_text(revision.provenance_ref), RevisionProvenance
        )
        assert provenance.origin == "candidate-overlay"


def test_overlay_failure_has_no_silent_native_path(tmp_path: Path) -> None:
    import strive.loop as loop_module

    # shadow: unavailable is recorded
    store = Store(tmp_path / "shadow", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    original = loop_module._build_composite_overlay
    loop_module._build_composite_overlay = lambda *args, **kwargs: None
    try:
        # under 3B.3, an ACCEPTED candidate whose evaluated identity cannot
        # be retained is refused promotion outright — stronger than the old
        # record-and-continue behavior, and never a silent native path
        with pytest.raises(StoreError, match="evaluated identity"):
            run_cycle(store, TASK)
        rows = [c for c in _checks(store) if c.subject == "cycle-candidate-overlay"]
        assert rows[-1].outcome == OUTCOME_UNAVAILABLE
        assert not cutover_eligibility(store).eligible
        # served behavior did NOT change
        active = store.active_generation()
        assert active is not None and active.generation_id == "gen-0000"

        # canary: the breaker opens BEFORE execution
        canary = Store(tmp_path / "canary", TASK.task_id)
        loop_module._build_composite_overlay = original
        _exercise_all_paths(canary)
        enable_canary(canary)
        rollback_generation(canary)  # make the next cycle evolve
        loop_module._build_composite_overlay = lambda *args, **kwargs: None
        with pytest.raises(StoreError, match="evaluated identity"):
            run_cycle(canary, TASK)
        assert reader_state(canary).breaker_open
    finally:
        loop_module._build_composite_overlay = original


def test_retention_references_the_exact_evaluated_candidate(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    events = _events(store, report.run_id)
    overlay_ref = str(
        next(e for e in events if e.type == "candidate_overlay").payload["revision_ref"]
    )
    retention_events = [e for e in events if e.type == "retention_record"]
    assert len(retention_events) == 1
    record: RetentionRecord = codec.loads(
        store.objects.get_text(str(retention_events[0].payload["retention_record_ref"])),
        RetentionRecord,
    )
    assert record.overlay_revision_ref == overlay_ref
    assert record.retained_generation_id == "gen-0001"
    assert record.retained_revision_id == "rev-0001"
    decision: object = codec.loads(store.objects.get_text(record.decision_ref))
    assert codec.encode(decision) == codec.encode(report.decision)

    # the retained mirror is content-identical to the evaluated overlay
    overlay: HarnessRevision = codec.loads(
        store.objects.get_text(overlay_ref), HarnessRevision
    )
    snapshot = verify_revision_snapshot(store)
    mirrored = snapshot.revisions["rev-0001"]
    assert mirrored.deltas == overlay.deltas
    assert mirrored.scope_manifest_ref == overlay.scope_manifest_ref
    # ... and the retained-candidate check agreed on exactly that
    rows = [c for c in _checks(store) if c.subject == "cycle-candidate-retained"]
    assert rows[-1].outcome == OUTCOME_AGREED


def test_ephemeral_candidate_execution_names_the_overlay(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    set_mode(store, MODE_SHADOW, "test")
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    events = _events(store, report.run_id)
    overlay_ref = str(
        next(e for e in events if e.type == "candidate_overlay").payload["revision_ref"]
    )
    records = {
        str(e.payload["subject"]): e.payload
        for e in events
        if e.type == "execution_record"
    }
    candidate_payload = records["cycle-candidate-overlay"]
    assert candidate_payload["subject_kind"] == "candidate-overlay"
    record: ExecutionRecord = codec.loads(
        store.objects.get_text(str(candidate_payload["execution_record_ref"])),
        ExecutionRecord,
    )
    assert record.subject_revision_ref == overlay_ref
    assert record.base_resolved_ref is not None
    base: ResolvedHarnessManifest = codec.loads(
        store.objects.get_text(record.base_resolved_ref), ResolvedHarnessManifest
    )
    # the run activated the candidate, yet the execution ran under rev-0000
    assert base.contributions[0].revision.revision_id == "rev-0000"
    seed = store.generations()["gen-0000"]
    candidate = store.generations()["gen-0001"]
    assert base.effective[0].binding.content_ref == seed.source_ref
    assert record.effective_manifest_ref is not None
    subject_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(record.effective_manifest_ref), ScopeManifest
    )
    assert subject_manifest.bindings[0].binding.content_ref == candidate.source_ref
    # the overlay is unactivated and never in the mirror journal
    snapshot = verify_revision_snapshot(store)
    overlay: HarnessRevision = codec.loads(
        store.objects.get_text(overlay_ref), HarnessRevision
    )
    assert overlay.ref.revision_id not in snapshot.revisions
    assert all(
        a.revision.revision_id != overlay.ref.revision_id
        for a in snapshot.activations
    )


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
    for record in (left, right):
        assert record.base_resolved_ref is not None
        base: ResolvedHarnessManifest = codec.loads(
            store.objects.get_text(record.base_resolved_ref), ResolvedHarnessManifest
        )
        assert base.contributions[0].revision.revision_id == "rev-0001"
        assert base.effective[0].binding.content_ref == active.source_ref
    assert left.effective_manifest_ref is not None
    left_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(left.effective_manifest_ref), ScopeManifest
    )
    assert left_manifest.bindings[0].binding.content_ref == seed.source_ref


# -- stale mutations -----------------------------------------------------------------------------


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
    assert _summaries(store)[-1].status == "stale"


def test_control_transitions_use_expected_journal_head(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    journal = reader_journal(store)
    head_before = journal.read().head
    # a concurrent control write moves the journal under the transition
    journal.append_batch(
        [ModeChange(mode=MODE_SHADOW, reason="concurrent", at=now_iso())]
    )
    with pytest.raises(ReaderError, match="journal advanced"):
        journal.append_batch(
            [ModeChange(mode=MODE_NATIVE, reason="stale", at=now_iso())],
            expected_head=head_before,
        )


# -- canary authority, breaker, kill switch --------------------------------------------------------


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
    try:
        reader.read_active("status-active")
        outcome = reader._checks["status-active"].outcome
    finally:
        reader.finish(None)
    assert outcome == OUTCOME_DIVERGED
    state = reader_state(store)
    assert state.breaker_open
    assert state.breaker_reason is not None and "divergence" in state.breaker_reason
    assert any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )
    # canary use is blocked: mode is still canary, but reads run as shadow
    blocked = StateReader(store, "status")
    assert blocked.mode == MODE_CANARY and blocked.effective_mode == MODE_SHADOW
    blocked.finish(None)
    with pytest.raises(ReaderError, match="breaker is open"):
        enable_canary(store)
    kill_switch(store)
    assert reader_state(store).mode == MODE_NATIVE


def test_canary_loses_eligibility_at_operation_start(tmp_path: Path) -> None:
    """The canary is effective only while the CURRENT epoch remains eligible
    at operation start: losing parity opens the breaker before any read."""
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    lines = [l for l in store.mirror.path.read_text().splitlines() if l.strip()]
    store.mirror.path.write_text("\n".join(lines[:-1]) + "\n")

    outcome = _status_read(store)  # canonical operation still succeeds
    assert outcome == OUTCOME_UNAVAILABLE
    state = reader_state(store)
    assert state.breaker_open and state.configured_mode == MODE_CANARY
    report = run_cycle(store, TASK)  # full operations keep committing
    assert report.run_id
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )


def test_clear_breaker_preconditions(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    enable_canary(store)
    lines = [l for l in store.mirror.path.read_text().splitlines() if l.strip()]
    store.mirror.path.write_text("\n".join(lines[:-1]) + "\n")
    _status_read(store)
    assert reader_state(store).breaker_open

    # refused while the canary is still configured
    with pytest.raises(ReaderError, match="kill the canary first"):
        clear_breaker(store, "too early")
    kill_switch(store)
    # refused while parity is incomplete
    with pytest.raises(ReaderError, match="parity"):
        clear_breaker(store, "still broken")
    run_backfill_operation(store, "parity-repair")  # also resets the epoch
    clear_breaker(store, "repaired")
    state = reader_state(store)
    assert not state.breaker_open
    assert state.mode == MODE_NATIVE  # clearing NEVER reactivates a canary


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
    canary_checks = [
        c for c in _checks(stores["canary"]) if c.mode == MODE_CANARY
    ]
    assert canary_checks and all(
        c.outcome in (OUTCOME_AGREED, "not-applicable") for c in canary_checks
    )


def test_reset_journal_quarantines_and_returns_to_native(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", TASK.task_id)
    _exercise_all_paths(store)
    journal = reader_journal(store)
    corrupt = journal.path.read_bytes() + b"garbage line\n"
    journal.path.write_bytes(corrupt)
    assert reader_state(store).journal_errors > 0

    quarantined = quarantine_reader_journal(store, "test corruption")
    assert quarantined is not None
    assert Path(quarantined).read_bytes() == corrupt  # preserved byte-for-byte
    state = reader_state(store)
    assert state.journal_errors == 0
    assert state.mode == MODE_NATIVE
    assert state.epoch is not None  # a fresh epoch, no old evidence
    assert read_coverage(store).total == 0
