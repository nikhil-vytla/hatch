"""Stage-3B dual-write: exact mirroring, parity, repair, backfill, isolation.

Generation-native records stay authoritative; these tests prove the revision
mirrors are field-preserving, deterministic, idempotent, and repairable —
and that Stage 1–2b behavior (including replay) is untouched.
"""

import json
from pathlib import Path

import pytest

from strive import codec
from strive.contracts import Activation, Generation
from strive.dualwrite import (
    ParityError,
    build_generation_mirror,
    parity_status,
    repair_parity,
)
from strive.loop import LoopConfig, promote_generation, replay_run, run_cycle
from strive.migrations import MIGRATIONS, apply_pending, pending_migrations
from strive.revisions import (
    HarnessRevision,
    MigrationProvenance,
    RevisionActivation,
    delta_label,
)
from strive.store import LedgerError, Store
from strive.tasks import MAX_INTEGERS_TASK, SUM_INTEGERS_TASK


def _evolved_store(tmp_path: Path) -> Store:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted
    return store


# -- exact mapping ---------------------------------------------------------------------


def test_every_generation_and_activation_has_an_exact_mirror(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    report = parity_status(store)
    assert report.complete
    assert report.generations == report.revisions == 2
    assert report.activations == report.revision_activations == 2

    generations = store.generations()
    for revision in store.revisions():
        generation = generations[revision.ref.revision_id.replace("rev-", "gen-")]
        # field preservation through MigrationProvenance in CAS
        assert revision.provenance_ref is not None
        provenance: MigrationProvenance = codec.loads(
            store.objects.get_text(revision.provenance_ref), MigrationProvenance
        )
        assert provenance.task_fingerprint == generation.task_fingerprint
        assert provenance.origin == generation.origin
        assert provenance.weakness_id == generation.weakness_id
        # delta carries the real content refs
        delta = revision.deltas[0]
        assert delta.after.content_ref == generation.source_ref
        if generation.parent_id is not None:
            parent = generations[generation.parent_id]
            assert delta.before.content_ref == parent.source_ref
            assert delta_label(delta) == "update"
        else:
            assert delta_label(delta) == "create"

    for activation, mirror in zip(store.activations(), store.revision_activations()):
        assert mirror.revision.revision_id == activation.generation_id.replace(
            "gen-", "rev-"
        )
        assert mirror.mode == activation.mode
        assert mirror.reason == activation.reason
        assert mirror.at == activation.at
        assert mirror.expires_after_cycles == activation.expires_after_cycles
        assert mirror.baseline_score == activation.baseline_score


def test_accepted_and_rejected_decisions_survive_in_cas(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # accepted candidate
    # force a rejected candidate: a second cycle proposes nothing, so instead
    # retain one manually with a rejecting decision via the normal API
    from strive.contracts import Decision

    rejected_decision = Decision(
        accepted=False,
        reason="regressions on previously passing cases: x",
        policy="paired-deterministic",
        policy_version=1,
        baseline_score=1.0,
        candidate_score=0.4,
        baseline_split_scores={"visible": 1.0},
        candidate_split_scores={"visible": 0.4},
        regressed_case_ids=("x",),
    )
    store.add_generation(
        "def solve(t):\n    return 0\n",
        task_fingerprint=SUM_INTEGERS_TASK.fingerprint(),
        parent_id="gen-0001",
        origin="evolved",
        surface="strategy-code",
        weakness_id="w",
        decision=rejected_decision,
    )

    assert parity_status(store).complete
    revisions = {r.ref.revision_id: r for r in store.revisions()}
    for revision_id, expected_accepted in (("rev-0001", True), ("rev-0002", False)):
        revision = revisions[revision_id]
        assert revision.provenance_ref is not None
        provenance: MigrationProvenance = codec.loads(
            store.objects.get_text(revision.provenance_ref), MigrationProvenance
        )
        assert provenance.decision_ref is not None
        decision: object = codec.loads(store.objects.get_text(provenance.decision_ref))
        assert isinstance(decision, Decision)
        assert decision.accepted is expected_accepted
        if not expected_accepted:
            assert decision.regressed_case_ids == ("x",)  # rejection evidence intact


def test_active_parity_at_every_activation_prefix(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    store.rollback()
    promote_generation(store, SUM_INTEGERS_TASK, "gen-0001")

    activations = store.activations()
    mirrors = store.revision_activations()
    assert [a.reason for a in activations] == ["seed", "evolved", "rollback", "promote"]
    assert len(activations) == len(mirrors)
    for i in range(1, len(activations) + 1):
        live_active = activations[:i][-1].generation_id
        mirror_active = mirrors[:i][-1].revision.revision_id
        assert mirror_active == live_active.replace("gen-", "rev-")


def test_rollback_and_provisional_metadata_are_equivalent(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    run_cycle(store, SUM_INTEGERS_TASK)
    store.activate(
        "gen-0000",
        reason="promote",
        mode="provisional",
        expires_after_cycles=2,
        baseline_score=1.0,
        policy="provisional@1",
    )
    mirrors = store.revision_activations()
    provisional = mirrors[-1]
    assert provisional.mode == "provisional"
    assert provisional.expires_after_cycles == 2
    assert provisional.baseline_score == 1.0
    assert provisional.policy_ref == "provisional@1"
    # legacy unversioned policies map to the reserved @0 era
    assert mirrors[0].policy_ref == "seed@0"
    assert parity_status(store).complete


# -- partial dual-write detection and repair --------------------------------------------


def _strip_mirrors(store: Store, keep_revisions: int, keep_activations: int) -> None:
    """Simulate interrupted dual-write by rewriting the journal without some
    mirror records (test-only surgery on the ledger file)."""
    lines = store.ledger_path.read_text().splitlines()
    kept: list[str] = []
    revisions_seen = 0
    activations_seen = 0
    for line in lines:
        record = json.loads(line)
        schema = record["schema"]
        if schema == "revision@1":
            revisions_seen += 1
            if revisions_seen > keep_revisions:
                continue
        if schema == "revision-activation@1":
            activations_seen += 1
            if activations_seen > keep_activations:
                continue
        kept.append(line)
    store.ledger_path.write_text("\n".join(kept) + "\n")


def test_partial_dual_write_is_detected_and_repaired(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_mirrors(store, keep_revisions=1, keep_activations=1)

    fresh = Store(store.root, SUM_INTEGERS_TASK.task_id)
    report = parity_status(fresh)
    assert not report.complete
    assert report.missing_revision_ids == ("rev-0001",)
    assert report.missing_activation_indices == (1,)

    repaired = repair_parity(fresh)
    assert repaired.complete
    # deterministic reconstruction: repairing again is a no-op (idempotent)
    assert repair_parity(fresh).complete
    assert len(fresh.revisions()) == 2
    assert len(fresh.revision_activations()) == 2
    # and active-prefix parity holds after repair... order differs (repaired
    # mirrors append at the tail), but LAST-activation parity must hold
    assert (
        fresh.revision_activations()[-1].revision.revision_id
        == fresh.activations()[-1].generation_id.replace("gen-", "rev-")
    )


def test_ambiguous_mirrors_are_refused_not_papered_over(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    # tamper: append a revision with no source generation
    alien = build_generation_mirror(
        store.objects,
        Generation(
            generation_id="gen-0099",
            task_id=SUM_INTEGERS_TASK.task_id,
            task_fingerprint=SUM_INTEGERS_TASK.fingerprint(),
            parent_id=None,
            origin="manual",
            surface="strategy-code",
            weakness_id=None,
            created_at="t",
            source_ref=store.objects.put_text("def solve(t):\n    return 9\n"),
        ),
        None,
    )
    store.append_revision(alien)
    report = parity_status(store)
    assert not report.complete
    assert any("no source generation" in issue for issue in report.mismatched)
    with pytest.raises(ParityError, match="ambiguous"):
        repair_parity(store)


# -- migration registry ------------------------------------------------------------------


def test_migration_registry_orders_and_noops(tmp_path: Path) -> None:
    assert [m.migration_id for m in MIGRATIONS] == [
        "0001-legacy-unscoped-ledger",
        "0002-revision-backfill",
    ]
    store = _evolved_store(tmp_path)
    root = store.root
    # complete parity: nothing pending
    assert pending_migrations(root, SUM_INTEGERS_TASK) == []
    assert apply_pending(root, SUM_INTEGERS_TASK) == []


def test_backfill_migration_applies_and_is_idempotent(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    _strip_mirrors(store, keep_revisions=0, keep_activations=0)
    root = store.root

    pending = pending_migrations(root, SUM_INTEGERS_TASK)
    assert [m.migration_id for m in pending] == ["0002-revision-backfill"]

    journal_before = Store(root, SUM_INTEGERS_TASK.task_id).ledger_path.read_bytes()
    reports = apply_pending(root, SUM_INTEGERS_TASK)
    assert len(reports) == 1 and reports[0].applied
    assert "backfilled 2 revisions, 2 revision-activations" in reports[0].detail

    after = Store(root, SUM_INTEGERS_TASK.task_id)
    assert parity_status(after).complete
    # source records preserved byte-for-byte (backfill is append-only)
    assert after.ledger_path.read_bytes().startswith(journal_before)
    # marker journaled with the pre-backfill hash
    markers = [i for i in after.interventions() if i.kind == "revision-backfill"]
    assert len(markers) == 1 and "sha256" in markers[0].reason
    # idempotent: nothing pending, re-apply is a no-op
    assert pending_migrations(root, SUM_INTEGERS_TASK) == []
    assert apply_pending(root, SUM_INTEGERS_TASK) == []


def test_legacy_then_backfill_chain(tmp_path: Path) -> None:
    from test_migration import _write_legacy_root

    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    pending = pending_migrations(root, SUM_INTEGERS_TASK)
    assert [m.migration_id for m in pending] == ["0001-legacy-unscoped-ledger"]

    reports = apply_pending(root, SUM_INTEGERS_TASK)
    # 0001 runs, then 0002 becomes needed and runs in the same sequential pass
    assert [r.migration_id for r in reports] == [
        "0001-legacy-unscoped-ledger",
        "0002-revision-backfill",
    ]
    store = Store(root, SUM_INTEGERS_TASK.task_id)
    assert parity_status(store).complete
    assert store.active_generation() is not None


def test_backfill_refuses_corrupt_history(tmp_path: Path) -> None:
    store = _evolved_store(tmp_path)
    lines = store.ledger_path.read_bytes().splitlines(keepends=True)
    lines[0] = b'{"schema":"generation@2","garbage":true}\n'
    store.ledger_path.write_bytes(b"".join(lines))
    with pytest.raises(LedgerError):
        apply_pending(store.root, SUM_INTEGERS_TASK)


# -- isolation and untouched Stage 1-2b behavior -----------------------------------------


def test_cross_task_revision_mirrors_stay_isolated(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    sum_store = Store(root, SUM_INTEGERS_TASK.task_id)
    run_cycle(sum_store, SUM_INTEGERS_TASK)
    from strive.diagnose import EvidenceDiagnoser
    from strive.fakemodel import scripted_fixture_adapter
    from strive.model_proposer import ModelProposer
    from strive.contracts import BudgetSpec

    max_store = Store(root, MAX_INTEGERS_TASK.task_id)
    run_cycle(
        max_store,
        MAX_INTEGERS_TASK,
        LoopConfig(
            proposer=ModelProposer(),
            diagnoser=EvidenceDiagnoser(),
            model_adapter=scripted_fixture_adapter(),
            budget=BudgetSpec(model_calls=4),
        ),
    )
    for store, task_id in ((sum_store, "sum-integers"), (max_store, "max-integers")):
        assert parity_status(store).complete
        for revision in store.revisions():
            assert revision.ref.scope.name == task_id

    # a foreign-task revision mirror smuggled into a ledger is rejected on read
    alien = max_store.revisions()[0]
    with sum_store.ledger_path.open("a") as handle:
        handle.write(codec.dumps(alien) + "\n")
    with pytest.raises(LedgerError, match="task-isolation violation"):
        Store(root, SUM_INTEGERS_TASK.task_id).entries()


def test_replay_and_loop_behavior_stay_generation_native(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    # execution-and-decision replay is untouched by dual-write
    replay = replay_run(store, SUM_INTEGERS_TASK, report.run_id)
    assert replay.matches and replay.decision_matches is True
    # active state is still derived from generation-native activations
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"
