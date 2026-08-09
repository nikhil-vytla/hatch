"""Stage-3B.1: derived integrity + subject-specific revision shadow reads.

Failure injection for prefix pinning, intent exclusivity, fail-closed
planning, artifact closure, quarantine/rebuild, prefix-scoped completion,
and stage-3B journal upgrades — plus per-use-site read-parity checks with
durable coverage across run/compare/replay/promote/rollback/audit/status
flows, execution-provenance manifests, and cutover eligibility.
"""

import hashlib
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
    capture_snapshot,
    open_intent,
    parity_status,
    plan_projection,
    rebuild_mirror,
    run_backfill_operation,
)
from strive.contracts import INTERVENTION_SHADOW_DIVERGENCE
from strive.evaluate import evaluate
from strive.contracts import Event
from strive.events import EventLog
from strive.loop import (
    audit_generation,
    compare_generations,
    promote_generation,
    replay_run,
    rollback_generation,
    run_cycle,
)
from strive.revisions import ResolvedHarnessManifest
from strive.sandbox import run_strategy
from strive.shadow import (
    CHECK_AGREED,
    CHECK_DIVERGED,
    CHECK_NOT_APPLICABLE,
    CHECK_UNAVAILABLE,
    ShadowSession,
    build_shadow_view,
    cutover_eligibility,
    read_shadow_records,
    shadow_coverage,
)
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
    # the resumed op completed its declared prefix; the live dual-write
    # already mirrored the appended records, so parity is fully complete
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


def test_open_intent_permits_later_activation_mirrors(tmp_path: Path) -> None:
    """Prefix-scoped completion: an intent is open, then a rollback creates a
    LATER activation + live mirror before resume. Resume must validate,
    repair, and complete only the intent's declared prefix; the newer mirror
    is out of scope and left untouched — never treated as foreign."""
    store = _evolved_store(tmp_path)
    # simulate an incomplete backfill: drop one mirror WITHIN the prefix
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
    # the later activation mirror survived, exactly once
    survivors = [
        l for l in _mirror_lines(store)
        if json.loads(l)["schema"] == "activation-mirror@1"
    ]
    assert sorted(survivors) == sorted(set(later_mirrors))
    # the repaired prefix mirror is back and the derived view agrees
    view = build_shadow_view(store)
    assert view.available, view.reason
    assert view.active_revision_id() == "rev-0000"  # post-rollback


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
    # the derived view is unavailable — closure is an availability requirement
    assert not build_shadow_view(store).available

    repaired = run_backfill_operation(store, "parity-repair")
    assert repaired.complete  # republished from the pure projection plan
    assert build_shadow_view(store).available


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
    # the derived view degrades to unavailable; it never raises
    view = build_shadow_view(store)
    assert not view.available and view.active_revision_id() is None

    rebuilt = rebuild_mirror(store)
    assert rebuilt.report.complete
    # prior journal preserved byte-for-byte in quarantine
    assert rebuilt.quarantine_path is not None
    assert Path(rebuilt.quarantine_path).read_bytes() == corrupt_bytes
    assert rebuilt.prior_mirror_sha256 == hashlib.sha256(corrupt_bytes).hexdigest()
    # canonical ledger untouched; rebuild is journaled with intent + completion
    assert store.ledger_path.read_bytes() == ledger_before
    kinds = [type(e).__name__ for e in store.mirror.entries()]
    assert kinds[0] == "MigrationIntent" and kinds[-1] == "MigrationCompleted"
    completed = store.mirror.entries()[-1]
    assert isinstance(completed, MigrationCompleted)
    assert rebuilt.prior_mirror_sha256 in completed.detail
    # the derived view works again and matches generation-native state
    view = build_shadow_view(store)
    assert view.available
    assert view.active_revision_id() == "rev-0000"  # post-rollback


def test_stage3b_intent_journal_is_detected_with_rebuild_guidance(
    tmp_path: Path,
) -> None:
    """A journal written in the exact stage-3B format (migration-intent@1,
    no prefix_digest) is detected precisely and directed to
    `strive parity --rebuild`; the rebuild recovers it with quarantine."""
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
    assert not build_shadow_view(store).available  # degraded, not crashed

    rebuilt = rebuild_mirror(store)
    assert rebuilt.report.complete
    assert rebuilt.quarantine_path is not None
    assert legacy_intent in Path(rebuilt.quarantine_path).read_text()
    assert build_shadow_view(store).available


# -- 4. subject-specific read parity across every flow ----------------------------------------


def _statuses(store: Store) -> dict[str, set[str]]:
    records, errors = read_shadow_records(store)
    assert errors == 0
    out: dict[str, set[str]] = {}
    for record in records:
        out.setdefault(record.subject, set()).add(record.status)
    return out


def test_every_use_site_records_an_agreed_check(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)  # cycle-baseline + cycle-candidate
    compare_generations(store, SUM_INTEGERS_TASK, "gen-0000", "gen-0001")
    run_cycle(store, SUM_INTEGERS_TASK)
    # replay the FIRST cycle: it retained a candidate, so the replay pairs
    # both its baseline and candidate reads
    replay_run(store, SUM_INTEGERS_TASK, store.cycles()[0].run_id)
    audit_generation(store, SUM_INTEGERS_TASK)
    rollback_generation(store)
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")
    session = ShadowSession(store)  # the status/restart read
    assert session.check_active("status-active", store.active_generation()).status \
        == CHECK_AGREED
    session.check_lineage("status-lineage", store.lineage())
    session.finish(None)

    statuses = _statuses(store)
    for subject in (
        "cycle-baseline", "cycle-candidate", "compare-left", "compare-right",
        "replay-baseline", "replay-candidate", "promote-incumbent",
        "promote-target", "rollback-active", "rollback-parent", "audit-target",
        "status-active", "status-lineage",
    ):
        recorded = statuses[subject]
        # every use site was checked and agreed; a cycle without a candidate
        # legitimately records its candidate read as not-applicable
        assert recorded <= {CHECK_AGREED, CHECK_NOT_APPLICABLE}, (subject, recorded)
        assert CHECK_AGREED in recorded, (subject, recorded)
    # no divergences anywhere in this healthy history
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )


def test_restart_read_shadows_identically(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    reopened = Store(store.root, SUM_INTEGERS_TASK.task_id)  # restart
    session = ShadowSession(reopened)
    check = session.check_active("status-active", reopened.active_generation())
    session.finish(None)
    assert check.status == CHECK_AGREED
    view = build_shadow_view(reopened)
    assert view.active_revision_id() == "rev-0001"
    assert view.lineage_of("rev-0001") == ("rev-0001", "rev-0000")
    assert view.parent_of("rev-0001") == "rev-0000"


def test_shadow_materialized_source_evaluates_identically(tmp_path: Path) -> None:
    """The revision-derived strategy source (materialized from the scope
    manifest by (kind, name) under pinned descriptors) produces the same
    evaluation result as the generation-native source."""
    store = _evolved_store(tmp_path)
    view = build_shadow_view(store)
    active_id = view.active_revision_id()
    assert view.available and active_id is not None
    _, shadow_source = view.sources[active_id]

    active = store.active_generation()
    assert active is not None
    native_report = run_strategy(
        store.source_of(active), SUM_INTEGERS_TASK.selection_cases(),
        generation_id=active.generation_id,
    )
    shadow_report = run_strategy(
        shadow_source, SUM_INTEGERS_TASK.selection_cases(),
        generation_id="shadow",
    )
    native_eval = evaluate(SUM_INTEGERS_TASK, native_report)
    shadow_eval = evaluate(SUM_INTEGERS_TASK, shadow_report)
    assert native_eval.overall_score == shadow_eval.overall_score == 1.0
    assert native_eval.split_scores == shadow_eval.split_scores


def test_incomplete_parity_is_unavailable_never_divergent(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    # drop the LATEST activation mirror
    lines = _mirror_lines(store)
    activation_lines = [
        i for i, l in enumerate(lines)
        if json.loads(l)["schema"] == "activation-mirror@1"
    ]
    del lines[activation_lines[-1]]
    store.mirror.path.write_text("\n".join(lines) + "\n")

    view = build_shadow_view(store)
    assert not view.available
    assert view.active_revision_id() is None  # no active revision reported
    assert "no mirror" in view.reason

    session = ShadowSession(store)
    check = session.check_active("status-active", store.active_generation())
    session.finish(None)
    assert check.status == CHECK_UNAVAILABLE  # unavailable ≠ divergent
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE for i in store.interventions()
    )
    # canonical behavior untouched; repair restores the derived view
    assert store.active_generation() is not None
    run_backfill_operation(store, "parity-repair")
    assert build_shadow_view(store).available


def test_derived_corruption_never_fails_the_canonical_operation(
    tmp_path: Path,
) -> None:
    """With the mirror journal replaced by a directory (an unexpected OS-level
    failure), every canonical flow still commits; shadow checks degrade to
    unavailable statuses."""
    store = _evolved_store(tmp_path)
    store.mirror.path.unlink()
    store.mirror.path.mkdir()  # reads now raise IsADirectoryError inside

    report = run_cycle(store, SUM_INTEGERS_TASK)  # must not raise
    assert report.run_id
    statuses = _statuses(store)
    assert CHECK_UNAVAILABLE in statuses["cycle-baseline"]
    view = build_shadow_view(store)
    assert not view.available and view.active_revision_id() is None


def test_lineage_cycle_is_detected_and_bounded(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    lines = _mirror_lines(store)
    for index, line in enumerate(lines):
        record = json.loads(line)
        if (
            record["schema"] == "revision-mirror@1"
            and record["revision"]["ref"]["revision_id"] == "rev-0000"
        ):
            # doctor rev-0000 to claim rev-0001 as its base parent: a cycle
            record["revision"]["base_parent"] = {
                "schema": "revision-ref@1",
                "scope": record["revision"]["ref"]["scope"],
                "revision_id": "rev-0001",
            }
            lines[index] = json.dumps(record, sort_keys=True, separators=(",", ":"))
            break
    store.mirror.path.write_text("\n".join(lines) + "\n")

    view = build_shadow_view(store)
    assert not view.available
    assert "lineage cycle" in view.reason


def test_true_divergence_is_durable_and_deduplicated(tmp_path: Path) -> None:
    """A genuinely divergent mirror is recorded durably with its subject;
    repeating the identical incident does not duplicate the intervention;
    behavior stays generation-native."""
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

    for _ in range(2):  # the identical incident, twice
        session = ShadowSession(store)
        check = session.check_active("status-active", store.active_generation())
        session.finish(None)
        assert check.status == CHECK_DIVERGED

    divergences = [
        i for i in store.interventions()
        if i.kind == INTERVENTION_SHADOW_DIVERGENCE
    ]
    assert len(divergences) == 1  # deduplicated
    assert divergences[0].reason.startswith("status-active: ")
    assert "rev-0000" in divergences[0].reason
    # ... but EVERY attempted check is in the coverage journal
    records, _ = read_shadow_records(store)
    assert sum(1 for r in records if r.status == CHECK_DIVERGED) == 2
    # generation-native behavior unaffected
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"


# -- 5. execution provenance ------------------------------------------------------------------


def _events(store: Store, run_id: str) -> "list[Event]":
    return EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()


def test_each_execution_pins_a_resolved_manifest(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    run_id = store.cycles()[-1].run_id
    manifests = [
        e for e in _events(store, run_id)
        if e.type == "execution_manifest"
    ]
    by_subject = {e.payload["subject"]: e.payload for e in manifests}
    assert set(by_subject) == {"cycle-baseline", "cycle-candidate"}
    # separate refs per subject: different executed artifacts
    baseline_ref = str(by_subject["cycle-baseline"]["resolved_manifest_ref"])
    candidate_ref = str(by_subject["cycle-candidate"]["resolved_manifest_ref"])
    assert baseline_ref != candidate_ref
    # the run activated the candidate, yet BOTH manifests identify the
    # baseline revision that produced the evaluation
    assert by_subject["cycle-baseline"]["baseline_revision"] == "rev-0000"
    assert by_subject["cycle-candidate"]["baseline_revision"] == "rev-0000"
    assert build_shadow_view(store).active_revision_id() == "rev-0001"

    resolved: ResolvedHarnessManifest = codec.loads(
        store.objects.get_text(candidate_ref), ResolvedHarnessManifest
    )
    assert resolved.contributions[0].revision.revision_id == "rev-0000"
    # tamper-evident journal head: record count AND source-prefix digest
    head_value = resolved.contributions[0].journal_head.value
    count, _, digest = head_value.partition(":")
    assert count.isdigit() and len(digest) == 64
    snapshot = capture_snapshot(store)
    assert digest == snapshot.prefix_digest(int(count))
    # the executed artifact is the candidate's source
    candidate = store.generations()["gen-0001"]
    assert resolved.effective[0].binding.content_ref == candidate.source_ref


def test_compare_and_replay_emit_per_subject_manifests(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    compare_generations(store, SUM_INTEGERS_TASK, "gen-0000", "gen-0001")
    compare_run = sorted(
        p.name for p in store.runs_dir.iterdir() if p.name.startswith("compare-")
    )[-1]
    subjects = {
        e.payload["subject"]
        for e in _events(store, compare_run)
        if e.type == "execution_manifest"
    }
    assert subjects == {"compare-left", "compare-right"}

    replay_run(store, SUM_INTEGERS_TASK, store.cycles()[-1].run_id)
    replay_id = sorted(
        p.name for p in store.runs_dir.iterdir() if p.name.startswith("replay-")
    )[-1]
    subjects = {
        e.payload["subject"]
        for e in _events(store, replay_id)
        if e.type == "execution_manifest"
    }
    assert subjects == {"replay-baseline", "replay-candidate"}


# -- 6. coverage + cutover eligibility ---------------------------------------------------------


def test_cutover_requires_coverage_not_just_no_divergence(tmp_path: Path) -> None:
    """A store with complete parity but NO recorded shadow checks must not be
    cutover-eligible: absence of divergence records is not evidence."""
    from strive.loop import ensure_seeded

    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    ensure_seeded(store, SUM_INTEGERS_TASK)
    assert parity_status(store).complete
    verdict = cutover_eligibility(store)
    assert not verdict.eligible
    assert any("no eligible shadowed reads" in r for r in verdict.reasons)


def test_cutover_eligibility_on_healthy_history(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    compare_generations(store, SUM_INTEGERS_TASK, "gen-0000", "gen-0001")
    rollback_generation(store)
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")
    coverage = shadow_coverage(store)
    assert coverage.diverged == 0 and coverage.unavailable == 0
    assert coverage.eligible == coverage.checked > 0
    assert coverage.divergence_rate == 0.0 and coverage.coverage_ratio == 1.0
    verdict = cutover_eligibility(store)
    assert verdict.eligible and verdict.parity_complete


def test_divergence_or_low_coverage_blocks_cutover(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    # make the derived side unavailable: subsequent checks are eligible-but-
    # unchecked, so coverage drops below the declared minimum
    lines = _mirror_lines(store)
    del lines[-1]
    store.mirror.path.write_text("\n".join(lines) + "\n")
    for _ in range(20):
        session = ShadowSession(store)
        session.check_active("status-active", store.active_generation())
        session.finish(None)

    coverage = shadow_coverage(store)
    assert coverage.unavailable >= 20
    verdict = cutover_eligibility(store)
    assert not verdict.eligible
    assert any("coverage" in r or "parity" in r for r in verdict.reasons)


# -- 7. differential control ------------------------------------------------------------------


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
    # the mirror-off run records no derived state at all; the mirror-on run
    # IS the shadowed run: agreed checks, zero divergences
    assert not stores["off"].shadow_path.exists()
    coverage = shadow_coverage(stores["on"])
    assert coverage.agreed > 0 and coverage.diverged == 0
    assert not any(
        i.kind == INTERVENTION_SHADOW_DIVERGENCE
        for i in stores["on"].interventions()
    )
