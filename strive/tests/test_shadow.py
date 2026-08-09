"""Stage-3B.1: hardened derived integrity + revision shadow-read parity.

Failure injection for prefix pinning, intent exclusivity, fail-closed
planning, artifact closure, quarantine/rebuild — and differential shadow
tests across run/compare/replay/promote/rollback/restart flows.
"""

import json
from pathlib import Path

import pytest

from strive import codec
from strive.dualwrite import (
    ActivationMirror,
    MigrationIntent,
    MirrorError,
    PROJECTOR_REF,
    ParityError,
    RevisionMirror,
    capture_snapshot,
    open_intent,
    parity_status,
    plan_projection,
    rebuild_mirror,
    run_backfill_operation,
)
from strive.loop import (
    compare_generations,
    promote_generation,
    replay_run,
    run_cycle,
)
from strive.contracts import INTERVENTION_SHADOW_DIVERGENCE
from strive.sandbox import run_strategy
from strive.evaluate import evaluate
from strive.shadow import compare_shadow, compute_shadow, record_shadow_check
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


# -- 1. migration/repair hardening ---------------------------------------------------------


def test_altered_source_prefix_after_intent_is_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_all_mirrors(store)
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    store.mirror.append(
        MigrationIntent(
            op_id="op-pin", migration_id="0002-revision-backfill",
            source_head=snapshot.head, source_hash=snapshot.journal_hash,
            prefix_digest=snapshot.prefix_digest(snapshot.head),
            projector_ref=PROJECTOR_REF, started_at=now_iso(),
        )
    )
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
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    store.mirror.append(
        MigrationIntent(
            op_id="op-append", migration_id="0002-revision-backfill",
            source_head=snapshot.head, source_hash=snapshot.journal_hash,
            prefix_digest=snapshot.prefix_digest(snapshot.head),
            projector_ref=PROJECTOR_REF, started_at=now_iso(),
        )
    )
    run_cycle(store, SUM_INTEGERS_TASK)  # append-only growth is fine
    report = run_backfill_operation(store, "0002-revision-backfill")
    # the resumed op completed its declared prefix; the live dual-write
    # already mirrored the appended records, so parity is fully complete
    assert report.complete
    assert open_intent(store.mirror) is None


def test_multiple_open_intents_are_refused(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    for op_id in ("op-a", "op-b"):
        store.mirror.append(
            MigrationIntent(
                op_id=op_id, migration_id="0002-revision-backfill",
                source_head=snapshot.head, source_hash=snapshot.journal_hash,
                prefix_digest=snapshot.prefix_digest(snapshot.head),
                projector_ref=PROJECTOR_REF, started_at=now_iso(),
            )
        )
    with pytest.raises(ParityError, match="2 unfinished migration intents"):
        run_backfill_operation(store, "0002-revision-backfill")


def test_resume_validates_migration_id_and_projector(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    snapshot = capture_snapshot(store)
    from strive.events import now_iso

    store.mirror.append(
        MigrationIntent(
            op_id="op-x", migration_id="0002-revision-backfill",
            source_head=snapshot.head, source_hash=snapshot.journal_hash,
            prefix_digest=snapshot.prefix_digest(snapshot.head),
            projector_ref=PROJECTOR_REF, started_at=now_iso(),
        )
    )
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
    # nothing was published on the failure path
    objects_after = sorted(
        p.name for p in store.objects.root.rglob("*") if p.is_file()
    )
    assert objects_after == objects_before


def test_mismatched_mirror_plus_missing_records_fails_closed(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    # corrupt one mirror's revision content AND drop another mirror entirely
    record = json.loads(lines[0])
    record["revision"]["summary"] = "tampered"
    mangled = [json.dumps(record, sort_keys=True, separators=(",", ":"))] + lines[2:]
    store.mirror.path.write_text("\n".join(mangled) + "\n")

    report = parity_status(store)
    assert not report.complete
    assert report.mismatched and report.missing_source_ordinals
    with pytest.raises(ParityError):
        run_backfill_operation(store, "parity-repair")


# -- 2. artifact closure --------------------------------------------------------------------


def _object_path(store: Store, ref: str) -> Path:
    return store.objects.root / ref[:2] / ref


def test_missing_derived_objects_are_detected_and_repaired(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    revision = store.revisions()[-1]
    assert revision.provenance_ref is not None
    # delete derived CAS objects (manifest + provenance)
    _object_path(store, revision.scope_manifest_ref).unlink()
    _object_path(store, revision.provenance_ref).unlink()

    report = parity_status(store)
    assert not report.complete
    assert len(report.missing_objects) == 2
    assert not report.closure_issues

    repaired = run_backfill_operation(store, "parity-repair")
    assert repaired.complete  # republished from the pure projection plan


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
    # fail closed: the corrupt object was NOT silently overwritten
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

    # a MISSING canonical source artifact is data loss, not repairable
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

    rebuilt = rebuild_mirror(store)
    assert rebuilt.report.complete
    # prior journal preserved byte-for-byte in quarantine
    assert rebuilt.quarantine_path is not None
    assert Path(rebuilt.quarantine_path).read_bytes() == corrupt_bytes
    import hashlib

    assert rebuilt.prior_mirror_sha256 == hashlib.sha256(corrupt_bytes).hexdigest()
    # canonical ledger untouched; rebuild is journaled with intent + completion
    assert store.ledger_path.read_bytes() == ledger_before
    kinds = [type(e).__name__ for e in store.mirror.entries()]
    assert kinds[0] == "MigrationIntent" and kinds[-1] == "MigrationCompleted"
    completed = store.mirror.entries()[-1]
    from strive.dualwrite import MigrationCompleted

    assert isinstance(completed, MigrationCompleted)
    assert rebuilt.prior_mirror_sha256 in completed.detail
    # shadow works again and agrees with generation-native state
    comparison = compare_shadow(store)
    assert comparison.shadow.available and not comparison.divergences
    assert comparison.shadow.active_revision_id == "rev-0000"  # post-rollback


# -- 4. shadow reads across flows ------------------------------------------------------------


def test_shadow_agrees_across_all_flows_and_restart(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)

    def assert_no_divergence(s: Store) -> None:
        comparison = compare_shadow(s)
        assert comparison.shadow.available, comparison.shadow.reason
        assert comparison.divergences == ()
        assert set(comparison.checked) == {
            "active_id", "lineage", "active_source", "rollback_parent",
            "candidate_source",
        }

    assert_no_divergence(store)  # after run
    compare_generations(store, SUM_INTEGERS_TASK, "gen-0000", "gen-0001")
    assert_no_divergence(store)  # after compare
    report = run_cycle(store, SUM_INTEGERS_TASK)
    replay_run(store, SUM_INTEGERS_TASK, report.run_id)
    assert_no_divergence(store)  # after replay
    store.rollback()
    assert_no_divergence(store)  # after rollback
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")
    assert_no_divergence(store)  # after promote

    reopened = Store(store.root, SUM_INTEGERS_TASK.task_id)  # restart
    assert_no_divergence(reopened)
    shadow = compute_shadow(reopened)
    assert shadow.active_revision_id == "rev-0001"
    assert shadow.lineage == ("rev-0001", "rev-0000")
    assert shadow.rollback_parent_id == "rev-0000"
    # no shadow-divergence interventions anywhere in this healthy history
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in reopened.interventions()
    )


def test_shadow_materialized_source_evaluates_identically(tmp_path: Path) -> None:
    """The revision-derived strategy source (materialized from the scope
    manifest under pinned descriptors) produces the same evaluation result
    as the generation-native source."""
    store = _evolved_store(tmp_path)
    shadow = compute_shadow(store)
    assert shadow.available and shadow.active_source_text is not None

    active = store.active_generation()
    assert active is not None
    native_report = run_strategy(
        store.source_of(active), SUM_INTEGERS_TASK.selection_cases(),
        generation_id=active.generation_id,
    )
    shadow_report = run_strategy(
        shadow.active_source_text, SUM_INTEGERS_TASK.selection_cases(),
        generation_id="shadow",
    )
    native_eval = evaluate(SUM_INTEGERS_TASK, native_report)
    shadow_eval = evaluate(SUM_INTEGERS_TASK, shadow_report)
    assert native_eval.overall_score == shadow_eval.overall_score == 1.0
    assert native_eval.split_scores == shadow_eval.split_scores


def test_no_active_revision_reported_while_parity_incomplete(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    # drop the LATEST activation mirror
    lines = _mirror_lines(store)
    activation_lines = [
        i for i, l in enumerate(lines)
        if json.loads(l)["schema"] == "activation-mirror@1"
    ]
    del lines[activation_lines[-1]]
    store.mirror.path.write_text("\n".join(lines) + "\n")

    shadow = compute_shadow(store)
    assert not shadow.available
    assert shadow.active_revision_id is None
    assert "activation parity incomplete" in shadow.reason
    # the shadowed run records no divergence (unavailable ≠ divergent) and
    # generation-native behavior is untouched
    comparison = record_shadow_check(store, None)
    assert comparison.divergences == ()
    assert store.active_generation() is not None
    # repair restores the shadow view
    run_backfill_operation(store, "parity-repair")
    assert compute_shadow(store).available


def test_true_divergence_is_a_durable_structured_event(tmp_path: Path) -> None:
    """A genuinely divergent mirror (activation mirror pointing at the wrong
    revision) is recorded durably; behavior stays generation-native."""
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    # tamper the LAST activation mirror to point at rev-0000
    for index in range(len(lines) - 1, -1, -1):
        record = json.loads(lines[index])
        if record["schema"] == "activation-mirror@1":
            record["activation"]["revision"]["revision_id"] = "rev-0000"
            lines[index] = json.dumps(record, sort_keys=True, separators=(",", ":"))
            break
    store.mirror.path.write_text("\n".join(lines) + "\n")

    comparison = record_shadow_check(store, None)
    assert comparison.divergences  # detected
    assert any("active" in d for d in comparison.divergences)
    # durable structured event in the canonical ledger
    divergence_interventions = [
        i for i in store.interventions()
        if i.kind == INTERVENTION_SHADOW_DIVERGENCE
    ]
    assert len(divergence_interventions) == 1
    assert "rev-0000" in divergence_interventions[0].reason
    # generation-native behavior unaffected
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"


def test_shadowed_run_stores_resolved_manifest(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    from strive.events import EventLog

    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    manifest_events = [e for e in events if e.type == "shadow_resolved_manifest"]
    assert len(manifest_events) == 1
    ref = str(manifest_events[0].payload["resolved_manifest_ref"])
    from strive.revisions import ResolvedHarnessManifest

    resolved: ResolvedHarnessManifest = codec.loads(
        store.objects.get_text(ref), ResolvedHarnessManifest
    )
    assert len(resolved.resolution_chain) == 1  # task-only
    assert resolved.contributions[0].revision.revision_id == "rev-0001"
    assert resolved.effective[0].binding.content_ref is not None


# -- 5. differential control ------------------------------------------------------------------


def test_mirror_off_on_and_shadow_runs_are_canonically_identical(
    tmp_path: Path,
) -> None:
    stores = {
        "off": Store(tmp_path / "off", SUM_INTEGERS_TASK.task_id, mirror_enabled=False),
        "on": Store(tmp_path / "on", SUM_INTEGERS_TASK.task_id),
    }
    results = {}
    for name, store in stores.items():
        report = run_cycle(store, SUM_INTEGERS_TASK)
        results[name] = report

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

    assert canonical(stores["off"]) == canonical(stores["on"])
    assert (
        results["off"].evaluation.overall_score
        == results["on"].evaluation.overall_score
    )
    # the mirror-on run IS the revision-shadow run (shadow checks active) and
    # reported no divergence
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE
        for i in stores["on"].interventions()
    )
    comparison = compare_shadow(stores["on"])
    assert comparison.shadow.available and not comparison.divergences
