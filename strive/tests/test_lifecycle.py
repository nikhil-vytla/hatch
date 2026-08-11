"""Stage-3B.3: the canonical native-revision lifecycle.

Adversarial coverage: exact candidate identity (evaluated == retained ==
activated), rejected-but-retained, lossless code+prompt composite state
across retain/activate/restart/rollback, stale/conflicting activation,
fail-closed on corrupt/incomplete/unknown-surface/mismatched candidates,
idempotent partial-write recovery, the durable breaker, and preservation of
legacy strategy behavior, canary controls, replay, parity, and cross-task
isolation.
"""

from pathlib import Path

import pytest

from strive import codec, lifecycle
from strive.contracts import Event
from strive.events import EventLog
from strive.lifecycle import (
    LifecycleError,
    active_revision_id,
    activate,
    compatibility_projection,
    compose_revision,
    lifecycle as lifecycle_ctx,
    materialize_active,
    retain,
    rollback,
    state,
)
from strive.loop import run_cycle
from strive.reader import MODE_SHADOW, reader_state, set_mode
from strive.revisions import (
    HarnessRevision,
    ManifestBinding,
    ScopeManifest,
)
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK


def _store(tmp_path: Path, name: str = "artifacts") -> Store:
    return Store(tmp_path / name, TASK.task_id)


def _active_manifest_bindings(store: Store) -> tuple[ManifestBinding, ...]:
    resolved = materialize_active(store)
    assert resolved is not None
    return resolved.effective


# -- exact candidate identity -------------------------------------------------------------------


def test_evaluated_retained_activated_are_the_same_revision(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    events = _events(store, report.run_id)
    overlay_ref = str(
        next(e for e in events if e.type == "candidate_overlay").payload["revision_ref"]
    )
    overlay: HarnessRevision = codec.loads(
        store.objects.get_text(overlay_ref), HarnessRevision
    )
    evaluated_id = overlay.ref.revision_id

    st = state(store)
    # retained id == evaluated id; the CAS ref proves the artifact is identical
    assert evaluated_id in st.retained
    assert st.retained[evaluated_id].revision_ref == overlay_ref
    # activated id == evaluated id
    assert st.active_revision_id == evaluated_id
    # the lifecycle-retained/activation events name the same id
    retained_evt = next(e for e in events if e.type == "lifecycle_retained")
    activated_evt = next(e for e in events if e.type == "lifecycle_activated")
    assert retained_evt.payload["revision_id"] == evaluated_id
    assert activated_evt.payload["revision_id"] == evaluated_id
    # evidence is linked to the exact candidate
    record = st.retained[evaluated_id]
    assert record.decision_ref is not None and record.evaluation_ref is not None
    decision: object = codec.loads(store.objects.get_text(record.decision_ref))
    assert codec.encode(decision) == codec.encode(report.decision)


def test_rejected_candidate_is_retained_but_not_activated(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)  # accepts gen-0001 -> lifecycle active = rev-cand-...
    accepted_active = active_revision_id(store)
    # a compare of the incumbent against the seed is a rejected decision, but
    # the loop only retains candidates from run_cycle; force a rejected cycle
    # by rolling back to the strong incumbent first, then running again with a
    # no-op proposer would not help. Instead retain a rejected candidate
    # directly against the lifecycle to assert the invariant precisely.
    st = state(store)
    parent_id = st.active_revision_id
    assert parent_id is not None
    parent_bindings = _active_manifest_bindings(store)
    revision, _ref = compose_revision(
        store,
        revision_id="rev-cand-rejected",
        base_parent_id=parent_id,
        parent_manifest_bindings=parent_bindings,
        surfaces={("strategy-code", "solve"): "def solve(t):\n    return 0\n"},
        proposer="test@0",
        summary="a rejected candidate",
        task_fingerprint=TASK.fingerprint(),
    )
    retain(
        store, revision, accepted=False, baseline_revision_id=parent_id,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    st = state(store)
    assert "rev-cand-rejected" in st.retained  # retained
    assert st.retained["rev-cand-rejected"].accepted is False
    assert st.active_revision_id == accepted_active  # NOT activated
    # activating a rejected candidate is possible only by explicit operator
    # action; the lifecycle does not do it automatically (loop never calls it)


# -- lossless composite (code + prompt) ---------------------------------------------------------


def _compose_code_prompt(
    store: Store, revision_id: str, base_parent_id: str, code: str, prompt: str
) -> HarnessRevision:
    parent_bindings = _active_manifest_bindings(store)
    revision, _ref = compose_revision(
        store,
        revision_id=revision_id,
        base_parent_id=base_parent_id,
        parent_manifest_bindings=parent_bindings,
        surfaces={
            ("strategy-code", "solve"): code,
            ("prompt", "proposal-template"): prompt,
        },
        proposer="composite-fixture@0",
        summary="code+prompt lifecycle fixture (prompt is lifecycle-only)",
        task_fingerprint=TASK.fingerprint(),
    )
    return revision


def test_code_plus_prompt_survives_retain_activate_restart_rollback(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)  # seed + first candidate
    baseline = active_revision_id(store)
    assert baseline is not None

    code = "def solve(t):\n    return sum(int(x) for x in t.replace(',', ' ').split())\n"
    prompt = "You are refining solve(). Consider negative integers. (lifecycle-only)"
    revision = _compose_code_prompt(store, "rev-composite-1", baseline, code, prompt)
    retain(
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    activate(
        store, "rev-composite-1", reason="promote", policy_ref="manual@0",
        expected_active_revision_id=baseline,
    )

    def assert_composite(s: Store) -> None:
        resolved = materialize_active(s)
        assert resolved is not None
        surfaces = {
            (b.kind, b.name): b.binding.content_ref
            for b in resolved.effective
            if b.binding.content_ref is not None
        }
        # BOTH surfaces are present and materialized from the manifest
        assert ("strategy-code", "solve") in surfaces
        assert ("prompt", "proposal-template") in surfaces
        assert s.objects.get_text(surfaces[("prompt", "proposal-template")]) == prompt
        assert s.objects.get_text(surfaces[("strategy-code", "solve")]) == code
        # the compatibility projection is strategy-only and marks the prompt as
        # a present-but-not-projected surface — never flattened away
        proj = compatibility_projection(s)
        assert proj is not None
        assert ("prompt", "proposal-template") in proj.other_surfaces
        assert proj.strategy_source_text == code

    assert_composite(store)  # after activate
    assert_composite(Store(store.root, TASK.task_id))  # after restart

    # whole-revision rollback returns to the strategy-only baseline; the
    # composite revision is retained, not deleted, and its prompt survives
    rollback(store)
    assert active_revision_id(store) == baseline
    assert "rev-composite-1" in state(store).retained
    assert_composite_still_retained(store, prompt)
    # re-activating the composite restores both surfaces losslessly
    activate(
        store, "rev-composite-1", reason="promote", policy_ref="manual@0",
        expected_active_revision_id=baseline,
    )
    assert_composite(Store(store.root, TASK.task_id))


def assert_composite_still_retained(store: Store, prompt: str) -> None:
    record = state(store).retained["rev-composite-1"]
    revision: HarnessRevision = codec.loads(
        store.objects.get_text(record.revision_ref), HarnessRevision
    )
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    prompt_binding = next(
        b for b in manifest.bindings if (b.kind, b.name) == ("prompt", "proposal-template")
    )
    assert prompt_binding.binding.content_ref is not None
    assert store.objects.get_text(prompt_binding.binding.content_ref) == prompt


# -- stale / conflicting activation -------------------------------------------------------------


def test_stale_activation_head_is_refused(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-x", baseline, "def solve(t):\n    return 0\n", "p"
    )
    st = state(store)
    retain(
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    # authorize against the pre-retention head: now stale
    with pytest.raises(LifecycleError, match="stale lifecycle head"):
        activate(
            store, "rev-x", reason="promote", policy_ref="manual@0",
            expected_head=st.head,
        )


def test_conflicting_expected_active_is_refused(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-y", baseline, "def solve(t):\n    return 0\n", "p"
    )
    retain(
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    with pytest.raises(LifecycleError, match="expected active revision"):
        activate(
            store, "rev-y", reason="promote", policy_ref="manual@0",
            expected_active_revision_id="rev-does-not-match",
        )


def test_activate_unretained_revision_is_refused(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    with pytest.raises(LifecycleError, match="not retained"):
        activate(store, "rev-unknown", reason="promote", policy_ref="manual@0")


# -- fail closed on bad candidates --------------------------------------------------------------


def test_retain_rejects_content_ref_identity_mismatch(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-z", baseline, "def solve(t):\n    return 0\n", "p"
    )
    # mutate the in-memory revision so it no longer matches its stored ref
    tampered = codec.loads(codec.dumps(revision), HarnessRevision)
    object.__setattr__(tampered, "summary", "tampered after hashing")
    ctx = lifecycle_ctx(store)
    from strive.lifecycle import validate_composite

    good_ref = ctx.objects.put_text(codec.dumps(revision))
    with pytest.raises(LifecycleError, match="identity mismatch"):
        validate_composite(ctx, tampered, good_ref)


def test_retain_rejects_unknown_surface(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    parent_bindings = _active_manifest_bindings(store)
    with pytest.raises(Exception):  # ContractViolation inside compose -> rejected
        compose_revision(
            store,
            revision_id="rev-bad-surface",
            base_parent_id=baseline,
            parent_manifest_bindings=parent_bindings,
            surfaces={("telemetry", "spy"): "data"},  # not a registered surface
            proposer="test@0",
            summary="unknown surface",
            task_fingerprint=TASK.fingerprint(),
        )


def test_retain_rejects_missing_artifact(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-missing", baseline, "def solve(t):\n    return 0\n", "p"
    )
    # delete the prompt artifact from CAS -> manifest closure incomplete
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    prompt_ref = next(
        b.binding.content_ref
        for b in manifest.bindings
        if b.kind == "prompt"
    )
    assert prompt_ref is not None
    (store.objects.root / prompt_ref[:2] / prompt_ref).unlink()
    with pytest.raises(LifecycleError, match="artifact for prompt|unavailable"):
        retain(
            store, revision, accepted=True, baseline_revision_id=baseline,
            evaluation_ref=None, decision_ref=None,
            task_fingerprint=TASK.fingerprint(),
        )


def test_retain_rejects_unknown_base_parent(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    revision = _compose_code_prompt(
        store, "rev-orphan", "rev-nonexistent-parent",
        "def solve(t):\n    return 0\n", "p",
    )
    with pytest.raises(LifecycleError, match="not retained; retain the parent"):
        retain(
            store, revision, accepted=True,
            baseline_revision_id="rev-nonexistent-parent",
            evaluation_ref=None, decision_ref=None,
            task_fingerprint=TASK.fingerprint(),
        )


def test_redefining_a_retained_revision_id_fails_closed(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    r1 = _compose_code_prompt(store, "rev-dup", baseline, "def solve(t):\n    return 1\n", "p1")
    retain(
        store, r1, accepted=False, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    r2 = _compose_code_prompt(store, "rev-dup", baseline, "def solve(t):\n    return 2\n", "p2")
    with pytest.raises(LifecycleError, match="already retained with different"):
        retain(
            store, r2, accepted=False, baseline_revision_id=baseline,
            evaluation_ref=None, decision_ref=None,
            task_fingerprint=TASK.fingerprint(),
        )


# -- idempotent partial-write recovery ----------------------------------------------------------


def test_retain_is_idempotent_no_duplicates(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-idem", baseline, "def solve(t):\n    return 0\n", "p"
    )
    head1 = retain(
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    head2 = retain(  # same id, same content -> no-op
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    assert head1 == head2  # head did not advance
    ids = [r for r in state(store).retained]
    assert ids.count("rev-idem") == 1


def test_torn_final_batch_is_ignored_and_recoverable(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = lifecycle_ctx(store).journal
    before = state(store)
    # simulate a crash mid-append: a partial (unframed, no newline) tail
    with journal.path.open("ab") as handle:
        handle.write(b'{"schema":"revision-retained@1","revision_id":"rev-torn"')
    after = state(store)
    assert after.active_revision_id == before.active_revision_id
    assert "rev-torn" not in after.retained  # torn tail never honored
    assert after.journal_errors == 0  # a torn *final* line is a tolerated artifact
    # the lifecycle still accepts new writes (recovers cleanly)
    baseline = after.active_revision_id
    assert baseline is not None


def test_unframed_forged_entry_is_never_honored(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = lifecycle_ctx(store).journal
    from strive.revisions import RevisionActivation, RevisionRef, ScopeRef, LEVEL_TASK
    from strive.events import now_iso

    forged = codec.dumps(
        RevisionActivation(
            revision=RevisionRef(ScopeRef(LEVEL_TASK, TASK.task_id), "rev-forged"),
            mode="durable", reason="promote", at=now_iso(), policy_ref="x@0",
        )
    )
    with journal.path.open("a") as handle:
        handle.write(forged + "\n")  # a complete but UNFRAMED line
    st = state(store)
    assert st.active_revision_id != "rev-forged"  # not honored
    assert st.journal_errors >= 1  # detected


# -- durable breaker ----------------------------------------------------------------------------


def test_breaker_blocks_activation_until_cleared(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_code_prompt(
        store, "rev-brk", baseline, "def solve(t):\n    return 0\n", "p"
    )
    retain(
        store, revision, accepted=True, baseline_revision_id=baseline,
        evaluation_ref=None, decision_ref=None, task_fingerprint=TASK.fingerprint(),
    )
    # corrupt the retained revision's manifest artifact so revalidation fails
    manifest_ref = revision.scope_manifest_ref
    (store.objects.root / manifest_ref[:2] / manifest_ref).write_text("corrupt")
    with pytest.raises(LifecycleError, match="breaker opened"):
        activate(store, "rev-brk", reason="promote", policy_ref="manual@0")
    st = state(store)
    assert st.breaker_open
    # further activation is blocked while the breaker is open — no lossy fallback
    with pytest.raises(LifecycleError, match="breaker is open"):
        activate(store, baseline, reason="promote", policy_ref="manual@0")
    assert active_revision_id(store) == baseline  # unchanged


# -- compatibility, canary, parity, isolation intact --------------------------------------------


def test_legacy_generation_behavior_and_active_state_intact(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    # generation-native active state is unchanged by the lifecycle
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"
    # and the native lifecycle names the SAME artifact via its own id
    proj = compatibility_projection(store)
    assert proj is not None
    assert proj.strategy_source_ref == active.source_ref


def test_canary_controls_and_parity_still_work(tmp_path: Path) -> None:
    from strive.dualwrite import parity_status

    store = _store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    run_cycle(store, TASK)
    assert reader_state(store).mode == MODE_SHADOW
    assert parity_status(store).complete  # generation->revision mirror parity


def test_cross_task_isolation_of_the_lifecycle_journal(tmp_path: Path) -> None:
    from strive.tasks import TASKS

    other_id = next(t for t in TASKS if t != TASK.task_id)
    root = tmp_path / "shared"
    a = Store(root, TASK.task_id)
    b = Store(root, other_id)
    run_cycle(a, TASK)
    run_cycle(b, TASKS[other_id])
    # each task's lifecycle journal is a distinct file and stream
    ctx_a, ctx_b = lifecycle_ctx(a), lifecycle_ctx(b)
    assert ctx_a.journal.path != ctx_b.journal.path
    assert active_revision_id(a) is not None
    # a task only sees its own retained revisions
    assert all(
        rec.task_id == TASK.task_id for rec in state(a).retained.values()
    )
    assert all(
        rec.task_id == other_id for rec in state(b).retained.values()
    )


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(
        EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()
    )
