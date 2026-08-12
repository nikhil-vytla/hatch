"""Stage-3B.3 (corrected): the canonical native-revision lifecycle.

Adversarial coverage: exact candidate identity end to end (including an
actually evaluated code+prompt revision), identity/evidence separation with
repeated evaluations, evidence-gated activation with trusted overrides,
parent-manifest state replay, cross-journal crash injection with
reconciliation, rollback that changes served behavior, framing recovery
(torn tails and unframed lines), pre-44 upgrade fixtures (reader journal +
lifecycle backfill), unsafe-model lifecycle-authority refusal, and
preservation of legacy behavior, canary controls, parity, and cross-task
isolation.
"""

import hashlib
import json
from pathlib import Path

import pytest

from strive import codec, lifecycle
from strive.contracts import Event
from strive.events import EventLog, now_iso
from strive.framing import FramingError
from strive.lifecycle import (
    ActivationCompleted,
    ActivationIntent,
    LifecycleError,
    activate,
    active_revision_id,
    compat_parity,
    compatibility_projection,
    compose_revision,
    lifecycle as lifecycle_ctx,
    materialize_active,
    reconcile,
    record_evaluation,
    record_selection,
    record_surface_evidence,
    retain,
    rollback,
    run_activation_op,
    state,
    sync_from_generations,
)
from strive.loop import LoopConfig, run_cycle
from strive.policy import get_policy
from strive.reader import MODE_SHADOW, reader_state, set_mode
from strive.revisions import HarnessRevision, ManifestBinding, ScopeManifest
from strive.sandbox import run_strategy
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK

# a minimal VALID prompt template for composite fixtures (the prompt@3
# descriptor's validator now runs at retention/activation)
def _fixture_prompt(marker: str) -> str:
    return (
        f"[fixture:{marker}] Reply with ONLY a JSON object for "
        "{parent_generation_id}."
    )


def _store(tmp_path: Path, name: str = "artifacts") -> Store:
    return Store(tmp_path / name, TASK.task_id)


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all())


def _strong_source(store: Store) -> str:
    """The known-good evolved strategy (the accepted gen-0001 candidate)."""
    return store.source_of(store.generations()["gen-0001"])


def _active_bindings(store: Store) -> tuple[ManifestBinding, ...]:
    resolved = materialize_active(store)
    assert resolved is not None
    return resolved.effective


def _record_prompt_evidence(store: Store, revision_id: str) -> None:
    """Record fixture prompt-comparison evidence for a composite's prompt
    delta — the surface-specific evidence its promoting selection must
    carry (surfaces cannot borrow the task gate's evidence)."""
    from strive.promptgate import PromptComparisonEvidence, TemplateOutcome

    def outcome(ref: str, gate: bool) -> TemplateOutcome:
        return TemplateOutcome(
            template_ref=ref,
            proposal_valid=True,
            failure_kind=None,
            source_ref=None,
            gate_accepted=gate,
            candidate_score=None,
            regressed_cases=0,
            model_calls=1,
            tokens=0,
            cost=None,
        )

    evidence = PromptComparisonEvidence(
        incumbent=outcome("tmpl-incumbent", False),
        candidate=outcome("tmpl-candidate", True),
        adapter="fixture",
        policy_ref="prompt-comparison@1",
        improved=True,
        detail="fixture: candidate strictly dominates",
        at="2026-01-01T00:00:00Z",
    )
    record_surface_evidence(
        store,
        revision_id,
        surface="prompt",
        evidence_ref=store.objects.put_text(codec.dumps(evidence)),
        improved=True,
    )


def _evaluate_and_select(
    store: Store, revision: HarnessRevision, baseline_id: str
) -> tuple[str, str, bool]:
    """ACTUALLY evaluate a retained revision's strategy artifact against the
    baseline under the trusted paired gate, and record the evidence.
    Returns (evaluation_ref, decision_ref, accepted)."""
    from strive.evaluate import evaluate as evaluate_task

    ctx = lifecycle_ctx(store)
    manifest: ScopeManifest = codec.loads(
        ctx.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    candidate_source = next(
        ctx.objects.get_text(b.binding.content_ref)
        for b in manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    baseline_record = state(store).retained[baseline_id]
    baseline_revision = codec.loads(
        ctx.objects.get_text(baseline_record.revision_ref), HarnessRevision
    )
    baseline_manifest: ScopeManifest = codec.loads(
        ctx.objects.get_text(baseline_revision.scope_manifest_ref), ScopeManifest
    )
    baseline_source = next(
        ctx.objects.get_text(b.binding.content_ref)
        for b in baseline_manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    cases = TASK.selection_cases()
    baseline_eval = evaluate_task(
        TASK, run_strategy(baseline_source, cases, generation_id="baseline"), cases
    )
    candidate_eval = evaluate_task(
        TASK, run_strategy(candidate_source, cases, generation_id="candidate"), cases
    )
    policy = get_policy("paired-deterministic")
    decision = policy.decide(baseline_eval, candidate_eval)
    evaluation_ref = store.objects.put_text(codec.dumps(candidate_eval))
    decision_ref = store.objects.put_text(codec.dumps(decision))
    record_evaluation(
        store,
        revision.ref.revision_id,
        baseline_revision_id=baseline_id,
        evaluation_ref=evaluation_ref,
        manifest_ref=revision.scope_manifest_ref,
    )
    record_selection(
        store,
        revision.ref.revision_id,
        baseline_revision_id=baseline_id,
        evaluation_ref=evaluation_ref,
        decision_ref=decision_ref,
        policy_ref=f"{policy.name}@{policy.version}",
        accepted=decision.accepted,
        task=TASK,  # synthesize the lossless SelectionDecision envelope
    )
    return evaluation_ref, decision_ref, decision.accepted


def _compose_linked(
    store: Store,
    revision_id: str,
    surfaces: dict[tuple[str, str], str],
    *,
    parent_id: str | None = None,
) -> HarnessRevision:
    """Compose a revision on top of the active one, retain it, and link a
    compatibility generation serving its strategy source."""
    st = state(store)
    base = parent_id if parent_id is not None else st.active_revision_id
    assert base is not None
    revision, _ref = compose_revision(
        store,
        revision_id=revision_id,
        base_parent_id=base,
        parent_manifest_bindings=_active_bindings(store),
        surfaces=surfaces,
        proposer="composite-fixture@0",
        summary="lifecycle fixture",
        task_fingerprint=TASK.fingerprint(),
    )
    code = surfaces.get(("strategy-code", "solve"))
    generation_id: str | None = None
    if code is not None:
        parent_generation = store.active_generation()
        generation = store.add_generation(
            code,
            task_fingerprint=TASK.fingerprint(),
            parent_id=(
                parent_generation.generation_id if parent_generation else None
            ),
            origin="manual",
            surface="strategy-code",
            weakness_id=None,
            decision=None,
        )
        generation_id = generation.generation_id
    retain(
        store,
        revision,
        task_fingerprint=TASK.fingerprint(),
        generation_id=generation_id,
    )
    return revision


# -- exact candidate identity (end to end) --------------------------------------------------------


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
    assert evaluated_id in st.retained
    assert st.retained[evaluated_id].revision_ref == overlay_ref  # identical artifact
    assert st.active_revision_id == evaluated_id  # activated id == evaluated id
    # identity and evidence are separate records; both exist and agree
    selections = st.selections[evaluated_id]
    assert len(selections) == 1 and selections[0].accepted
    assert selections[0].baseline_revision_id == "rev-prompt-default"
    evaluations = st.evaluations[evaluated_id]
    assert len(evaluations) == 1
    decision: object = codec.loads(store.objects.get_text(selections[0].decision_ref))
    assert codec.encode(decision) == codec.encode(report.decision)
    # the cross-journal activation op ran intent -> ... -> completed
    ctx = lifecycle_ctx(store)
    entries = ctx.journal.read().entries
    intents = [e for e in entries if isinstance(e, ActivationIntent)]
    completions = [e for e in entries if isinstance(e, ActivationCompleted)]
    assert intents and completions
    assert completions[-1].outcome == "completed"
    # served compatibility behavior and the lifecycle agree
    parity = compat_parity(store)
    assert parity.ok, parity.reason


def test_actually_evaluated_code_plus_prompt_has_one_identity(tmp_path: Path) -> None:
    """The end-to-end composite case: a code+prompt revision is ACTUALLY
    evaluated (sandbox execution + the trusted paired gate), its evidence is
    recorded, and the SAME id is retained and activated."""
    store = _store(tmp_path)
    run_cycle(store, TASK)
    rollback(store)  # back to the pre-candidate baseline (the prompt pin)
    baseline = active_revision_id(store)
    assert baseline == "rev-prompt-default"

    code = _strong_source(store) + "\n# composite-e2e variant\n"
    prompt = _fixture_prompt("e2e")
    revision = _compose_linked(
        store,
        "rev-composite-e2e",
        {("strategy-code", "solve"): code, ("prompt", "proposal-template"): prompt},
    )
    evaluated_id = revision.ref.revision_id
    # the composite's prompt delta needs its own surface evidence BEFORE the
    # selection, or the evidence gate refuses promotion (no piggybacking)
    _record_prompt_evidence(store, evaluated_id)
    _evaluation_ref, decision_ref, accepted = _evaluate_and_select(
        store, revision, baseline
    )
    assert accepted  # a strict improvement over the weak seed: the gate accepts

    run_activation_op(
        store,
        evaluated_id,
        reason="promote",
        policy_ref="paired-deterministic@1",
        decision_ref=decision_ref,
    )
    st = state(store)
    assert st.active_revision_id == evaluated_id  # evaluated == retained == activated
    resolved = materialize_active(store)
    assert resolved is not None
    surfaces = {(b.kind, b.name) for b in resolved.effective}
    assert ("prompt", "proposal-template") in surfaces  # composite intact
    assert compat_parity(store).ok  # served behavior follows the same revision


def test_rejected_candidate_is_retained_but_cannot_activate(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    # a strictly WORSE candidate: the gate rejects it
    revision = _compose_linked(
        store, "rev-worse", {("strategy-code", "solve"): "def solve(t):\n    return 0\n"}
    )
    _eval_ref, decision_ref, accepted = _evaluate_and_select(store, revision, baseline)
    assert not accepted
    st = state(store)
    assert "rev-worse" in st.retained  # rejected candidates ARE retained
    assert not st.selections["rev-worse"][-1].accepted
    assert st.active_revision_id == baseline  # ... but not activated
    # activation is refused on rejected evidence
    with pytest.raises(LifecycleError, match="REJECTED"):
        run_activation_op(
            store, "rev-worse", reason="promote",
            policy_ref="paired-deterministic@1", decision_ref=decision_ref,
        )
    # ... and on NO evidence
    fresh = _compose_linked(
        store, "rev-no-evidence",
        {("strategy-code", "solve"): "def solve(t):\n    return 1\n"},
    )
    del fresh
    with pytest.raises(LifecycleError, match="no selection evidence"):
        run_activation_op(
            store, "rev-no-evidence", reason="promote", policy_ref="manual@0",
        )
    # a distinct trusted override record is the only path around the gate
    run_activation_op(
        store, "rev-worse", reason="promote", policy_ref="manual@0",
        override_reason="operator override for test",
    )
    st = state(store)
    assert st.active_revision_id == "rev-worse"
    assert len(st.overrides["rev-worse"]) == 1  # the override is durable
    assert compat_parity(store).ok


def test_one_revision_can_be_evaluated_repeatedly(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store, "rev-multi",
        {("strategy-code", "solve"): _strong_source(store) + "\n# multi\n"},
    )
    _evaluate_and_select(store, revision, baseline)
    _evaluate_and_select(store, revision, "rev-0000")  # a DIFFERENT baseline
    st = state(store)
    assert len(st.evaluations["rev-multi"]) == 2
    assert len(st.selections["rev-multi"]) == 2
    baselines = {s.baseline_revision_id for s in st.selections["rev-multi"]}
    assert baselines == {baseline, "rev-0000"}
    # the promote gate uses the LATEST selection: it was against rev-0000,
    # not the current active baseline, so activation refuses as stale evidence
    with pytest.raises(LifecycleError, match="re-evaluate against the current"):
        run_activation_op(
            store, "rev-multi", reason="promote", policy_ref="manual@0",
        )


# -- parent-manifest state replay ------------------------------------------------------------------


def test_code_only_child_of_code_plus_prompt_parent_preserves_prompt(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    prompt = _fixture_prompt("carry-forward")
    parent = _compose_linked(
        store,
        "rev-parent-cp",
        {
            ("strategy-code", "solve"): "def solve(t):\n    return 1\n",
            ("prompt", "proposal-template"): prompt,
        },
    )
    _eval, dec, _acc = _evaluate_and_select(store, parent, baseline)
    run_activation_op(
        store, "rev-parent-cp", reason="promote", policy_ref="manual@0",
        override_reason="fixture activation",
    )
    # a code-only child: the prompt binding must carry over UNCHANGED
    child = _compose_linked(
        store, "rev-child-code-only",
        {("strategy-code", "solve"): "def solve(t):\n    return 2\n"},
    )
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(child.scope_manifest_ref), ScopeManifest
    )
    keys = {(b.kind, b.name) for b in manifest.bindings}
    assert ("prompt", "proposal-template") in keys  # preserved, not dropped
    assert "rev-child-code-only" in state(store).retained


def test_dropped_surface_and_stale_before_fail_closed(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    parent = _compose_linked(
        store,
        "rev-parent2",
        {
            ("strategy-code", "solve"): "def solve(t):\n    return 3\n",
            ("prompt", "proposal-template"): _fixture_prompt("p2"),
        },
    )
    _eval, _dec, _acc = _evaluate_and_select(store, parent, baseline)
    run_activation_op(
        store, "rev-parent2", reason="promote", policy_ref="manual@0",
        override_reason="fixture activation",
    )

    # a child whose manifest silently DROPS the prompt (no delete delta)
    from strive.revisions import (
        ABSENT,
        RevisionProvenance,
        RevisionRef,
        ScopeRef,
        SurfaceDelta,
        content_binding,
    )

    code_ref = store.objects.put_text("def solve(t):\n    return 4\n")
    parent_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(parent.scope_manifest_ref), ScopeManifest
    )
    parent_code = next(
        b.binding for b in parent_manifest.bindings if b.kind == "strategy-code"
    )
    after = content_binding("strategy-code", code_ref)
    bad_manifest = ScopeManifest(
        scope=parent.ref.scope,
        bindings=(ManifestBinding("strategy-code", "solve", after),),  # prompt GONE
    )
    bad_manifest_ref = store.objects.put_text(codec.dumps(bad_manifest))
    provenance_ref = store.objects.put_text(
        codec.dumps(
            RevisionProvenance(
                origin="test", task_id=TASK.task_id,
                task_fingerprint=TASK.fingerprint(), surface="strategy-code",
                weakness_id=None, parent_revision_id="rev-parent2",
                decision_ref=None,
            )
        )
    )
    dropped = HarnessRevision(
        ref=RevisionRef(parent.ref.scope, "rev-drops-prompt"),
        base_parent=parent.ref,
        provenance_parents=(),
        deltas=(SurfaceDelta("strategy-code", "solve", parent_code, after),),
        scope_manifest_ref=bad_manifest_ref,
        proposer="test@0",
        summary="drops the prompt without declaring it",
        created_at=now_iso(),
        provenance_ref=provenance_ref,
    )
    with pytest.raises(LifecycleError, match="dropped surfaces"):
        retain(store, dropped, task_fingerprint=TASK.fingerprint())

    # a child whose delta declares a STALE before-state
    stale = HarnessRevision(
        ref=RevisionRef(parent.ref.scope, "rev-stale-before"),
        base_parent=parent.ref,
        provenance_parents=(),
        deltas=(SurfaceDelta("strategy-code", "solve", ABSENT, after),),
        scope_manifest_ref=bad_manifest_ref,
        proposer="test@0",
        summary="stale before",
        created_at=now_iso(),
        provenance_ref=provenance_ref,
    )
    with pytest.raises(LifecycleError, match="stale or mismatched before-state"):
        retain(store, stale, task_fingerprint=TASK.fingerprint())


# -- rollback drives served behavior ----------------------------------------------------------------


def test_rollback_changes_served_strategy_and_keeps_parity(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    evolved = store.active_generation()
    assert evolved is not None and evolved.generation_id == "gen-0001"
    evolved_source = store.source_of(evolved)

    rollback(store)  # ONE recoverable op across both journals
    st = state(store)
    assert st.active_revision_id == "rev-prompt-default"
    served = store.active_generation()
    assert served is not None and served.generation_id == "gen-0000"  # served changed
    assert store.source_of(served) != evolved_source
    parity = compat_parity(store)
    assert parity.ok, parity.reason
    projection = compatibility_projection(store)
    assert projection is not None
    assert projection.strategy_source_text == store.source_of(served)
    # nothing was deleted
    assert "gen-0001" in store.generations()
    assert len(st.retained) >= 2


# -- cross-journal crash injection + reconciliation --------------------------------------------------


def _inject_intent(store: Store, revision_id: str) -> ActivationIntent:
    st = state(store)
    ctx = lifecycle_ctx(store)
    intent = ActivationIntent(
        op_id="op-crash",
        revision_id=revision_id,
        baseline_revision_id=st.active_revision_id,
        generation_id=st.links[revision_id],
        reason="promote",
        policy_ref="manual@0",
        decision_ref=None,
        at=now_iso(),
    )
    ctx.journal.append_batch([intent])
    return intent


def _prepare_promotable(store: Store, revision_id: str) -> str:
    """Roll back to the weak seed, then compose a STRONG candidate whose
    selection is accepted against the current baseline — a realistic
    promotable state for crash injection."""
    rollback(store)
    baseline = active_revision_id(store)
    assert baseline == "rev-prompt-default"
    revision = _compose_linked(
        store, revision_id,
        {("strategy-code", "solve"): _strong_source(store) + f"\n# {revision_id}\n"},
    )
    _eval, decision_ref, accepted = _evaluate_and_select(store, revision, baseline)
    assert accepted
    return decision_ref


def test_crash_after_intent_before_generation_activation_is_abandoned(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    _prepare_promotable(store, "rev-crash-a")
    before_gen = store.active_generation()
    _inject_intent(store, "rev-crash-a")

    outcomes = reconcile(store)
    assert outcomes == ("abandoned",)
    # served behavior never changed; the lifecycle active did not move
    assert store.active_generation() == before_gen
    assert active_revision_id(store) != "rev-crash-a"
    assert not state(store).open_intents


def test_crash_after_generation_activation_resumes_lifecycle(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    _prepare_promotable(store, "rev-crash-b")
    intent = _inject_intent(store, "rev-crash-b")
    # the generation side activated, then the process died
    store.activate(intent.generation_id, reason="promote", policy="manual@0")

    outcomes = reconcile(store)
    assert outcomes == ("completed",)
    st = state(store)
    assert st.active_revision_id == "rev-crash-b"  # lifecycle caught up
    assert not st.open_intents
    assert compat_parity(store).ok


def test_crash_with_invalid_revision_reverts_generation_and_opens_breaker(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    _prepare_promotable(store, "rev-crash-c")
    baseline_gen = store.active_generation()
    assert baseline_gen is not None
    intent = _inject_intent(store, "rev-crash-c")
    store.activate(intent.generation_id, reason="promote", policy="manual@0")
    # the revision's manifest artifact corrupts before reconciliation
    record = state(store).retained["rev-crash-c"]
    revision: HarnessRevision = codec.loads(
        store.objects.get_text(record.revision_ref), HarnessRevision
    )
    ref = revision.scope_manifest_ref
    (store.objects.root / ref[:2] / ref).write_text("corrupt")

    outcomes = reconcile(store)
    assert outcomes == ("reverted",)
    st = state(store)
    assert st.breaker_open  # durable
    served = store.active_generation()
    assert served is not None
    assert served.generation_id == baseline_gen.generation_id  # reverted
    assert st.active_revision_id != "rev-crash-c"
    assert not st.open_intents


def test_lifecycle_failure_after_generation_activation_is_not_swallowed(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    decision_ref = _prepare_promotable(store, "rev-live-fail")
    record = state(store).retained["rev-live-fail"]
    revision: HarnessRevision = codec.loads(
        store.objects.get_text(record.revision_ref), HarnessRevision
    )
    baseline_gen = store.active_generation()
    assert baseline_gen is not None
    ref = revision.scope_manifest_ref
    (store.objects.root / ref[:2] / ref).write_text("corrupt")  # invalidate NOW

    with pytest.raises(LifecycleError, match="reverted"):
        run_activation_op(
            store, "rev-live-fail", reason="promote", policy_ref="manual@0",
            decision_ref=decision_ref,
        )
    served = store.active_generation()
    assert served is not None
    assert served.generation_id == baseline_gen.generation_id  # reverted, recorded
    st = state(store)
    assert st.breaker_open
    ctx = lifecycle_ctx(store)
    completions = [
        e for e in ctx.journal.read().entries if isinstance(e, ActivationCompleted)
    ]
    assert completions[-1].outcome == "reverted"


# -- framing recovery ---------------------------------------------------------------------------------


def test_append_after_torn_tail_refuses_then_repairs(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = lifecycle_ctx(store).journal
    good = journal.path.read_bytes()
    with journal.path.open("ab") as handle:
        handle.write(b'{"schema":"lifecycle-breaker@1","state":"cle')  # torn

    with pytest.raises(FramingError, match="unverified region"):
        journal.append_batch(
            [lifecycle.LifecycleBreaker(state="open", reason="x", at=now_iso())]
        )
    quarantine = journal.repair_to_verified("test torn tail")
    assert quarantine is not None
    assert Path(quarantine).read_bytes().startswith(good)  # bytes preserved
    assert journal.path.read_bytes() == good  # truncated to verified boundary
    journal.append_batch(  # appends work again
        [lifecycle.LifecycleBreaker(state="open", reason="x", at=now_iso())]
    )
    assert state(store).breaker_open


def test_append_after_unframed_line_refuses_then_repairs(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = lifecycle_ctx(store).journal
    good = journal.path.read_bytes()
    forged = codec.dumps(
        lifecycle.LifecycleBreaker(state="cleared", reason="forged", at=now_iso())
    )
    with journal.path.open("a") as handle:
        handle.write(forged + "\n")  # complete but UNFRAMED

    assert state(store).journal_errors >= 1
    with pytest.raises(FramingError, match="unverified region"):
        journal.append_batch(
            [lifecycle.LifecycleBreaker(state="open", reason="y", at=now_iso())]
        )
    # mutation and materialization refuse over the dirty journal
    with pytest.raises(LifecycleError, match="unverifiable"):
        materialize_active(store)
    quarantine = journal.repair_to_verified("test unframed")
    assert quarantine is not None and journal.path.read_bytes() == good
    assert state(store).journal_errors == 0
    assert materialize_active(store) is not None


def test_invalid_entry_type_is_rejected_before_writing(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = lifecycle_ctx(store).journal
    before = journal.path.read_bytes()
    with pytest.raises(FramingError, match="not a valid entry type"):
        journal.append_batch(["not a record"])
    assert journal.path.read_bytes() == before  # nothing was written


# -- pre-44 upgrade fixtures -----------------------------------------------------------------------


def test_lifecycle_backfill_preserves_actual_active_revision(tmp_path: Path) -> None:
    """A pre-lifecycle store (generation history exists, no revisions journal)
    backfills to the ACTUAL active revision — never just the seed."""
    store = _store(tmp_path)
    run_cycle(store, TASK)  # evolves to gen-0001
    store.rollback()  # ... and back to gen-0000
    store.activate("gen-0001", reason="promote", policy="manual@0")  # re-promote
    lifecycle_ctx(store).journal.path.unlink()  # simulate a pre-44 store

    from strive.migrations import apply_pending, pending_migrations

    pending = [m.migration_id for m in pending_migrations(store.root, TASK)]
    assert "0003-lifecycle-backfill" in pending
    reports = apply_pending(store.root, TASK)
    assert any(r.migration_id == "0003-lifecycle-backfill" for r in reports)

    st = state(store)
    assert st.active_revision_id == "rev-0001"  # the ACTUAL active, not rev-0000
    assert set(st.retained) >= {"rev-0000", "rev-0001"}
    # the full activation history was replayed, order preserved
    # the native history includes the prompt-pin re-activation of gen-0000;
    # after the journal was deleted, gen-0000's single backfilled identity is
    # rev-0000, so BOTH its activations map there — order preserved exactly
    assert st.activation_order == (
        "rev-0000", "rev-0000", "rev-0001", "rev-0000", "rev-0001"
    )
    assert compat_parity(store).ok


def _write_legacy_reader_journal(path: Path, task_id: str, batches: list[list[object]]) -> bytes:
    """Byte-exact PR#43 reader-journal format: reader-frame@1 frames chained
    from the old fixed genesis."""
    genesis = hashlib.sha256(b"strive-reader-genesis").hexdigest()
    last = genesis
    out = b""
    for seq, batch in enumerate(batches, start=1):
        payload = "".join(codec.dumps(e) + "\n" for e in batch).encode("utf-8")
        frame = {
            "schema": "reader-frame@1",
            "task_id": task_id,
            "seq": seq,
            "prev": last,
            "payload_hash": hashlib.sha256(payload).hexdigest(),
            "count": len(batch),
            "at": "2026-08-09T00:00:00+00:00",
        }
        line = json.dumps(frame, sort_keys=True, separators=(",", ":")).encode("utf-8")
        out += payload + line + b"\n"
        last = hashlib.sha256(line).hexdigest()
    path.write_bytes(out)
    return out


def test_pr43_reader_journal_is_detected_and_upgraded_exactly(tmp_path: Path) -> None:
    from strive.reader import (
        EpochReset,
        ModeChange,
        ReadCheck,
        ReaderError,
        reader_journal,
        upgrade_reader_journal,
    )

    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = reader_journal(store)
    journal.path.unlink()  # replace with a PR#43-format journal
    epoch = EpochReset(
        epoch="epoch-legacy", reason="opened", reader_version="state-reader@2",
        projector_ref="generation-to-revision@1", at="2026-08-09T00:00:00+00:00",
    )
    mode = ModeChange(mode=MODE_SHADOW, reason="burn-in", at="2026-08-09T00:00:01+00:00")
    check = ReadCheck(
        epoch="epoch-legacy", op_id="op-legacy", operation="status",
        subject="status-active", mode=MODE_SHADOW, outcome="agreed", detail="ok",
        canonical_head="1:aa", mirror_head="1:bb",
        reader_version="state-reader@2",
        projector_ref="generation-to-revision@1", at="2026-08-09T00:00:02+00:00",
    )
    original = _write_legacy_reader_journal(
        journal.path, TASK.task_id, [[epoch, mode], [check]]
    )

    # detection is LOUD with migration guidance, not generic corruption
    with pytest.raises(ReaderError, match="legacy frame schema.*migrate"):
        journal.read()
    from strive.migrations import pending_migrations

    pending = [m.migration_id for m in pending_migrations(store.root, TASK)]
    assert "0004-reader-journal-upgrade" in pending

    report = upgrade_reader_journal(store)
    assert report.original_sha256 == hashlib.sha256(original).hexdigest()
    assert Path(report.quarantine_path).read_bytes() == original  # bytes preserved
    assert report.batches == 2 and report.entries == 3

    view = journal.read()
    assert view.errors == 0
    assert list(view.entries) == [epoch, mode, check]  # exact order + content
    st = reader_state(store)
    assert st.mode == MODE_SHADOW  # mode preserved
    assert st.epoch == "epoch-legacy"  # epoch preserved


def test_pr43_upgrade_refuses_ambiguous_journals(tmp_path: Path) -> None:
    from strive.reader import ReaderError, reader_journal, upgrade_reader_journal

    store = _store(tmp_path)
    run_cycle(store, TASK)
    journal = reader_journal(store)
    journal.path.unlink()
    from strive.reader import ModeChange

    original = _write_legacy_reader_journal(
        journal.path, TASK.task_id,
        [[ModeChange(mode=MODE_SHADOW, reason="x", at="2026-08-09T00:00:00+00:00")]],
    )
    # tamper one byte inside the legacy region
    journal.path.write_bytes(original.replace(b'"reason":"x"', b'"reason":"y"', 1))
    with pytest.raises(ReaderError, match="refusing an ambiguous migration"):
        upgrade_reader_journal(store)
    assert journal.path.read_bytes() != b""  # untouched, not partially migrated


# -- lifecycle semantics hardening --------------------------------------------------------------------


def test_duplicate_redefinition_and_unretained_activation_fail(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    r1 = _compose_linked(
        store, "rev-dup", {("strategy-code", "solve"): "def solve(t):\n    return 1\n"}
    )
    del r1
    r2, _ = compose_revision(
        store,
        revision_id="rev-dup",
        base_parent_id=baseline,
        parent_manifest_bindings=_active_bindings(store),
        surfaces={("strategy-code", "solve"): "def solve(t):\n    return 2\n"},
        proposer="test@0",
        summary="redefinition",
        task_fingerprint=TASK.fingerprint(),
    )
    with pytest.raises(LifecycleError, match="already retained with different"):
        retain(store, r2, task_fingerprint=TASK.fingerprint())
    with pytest.raises(LifecycleError, match="not retained"):
        activate(store, "rev-never-retained", reason="promote", policy_ref="x@0")


def test_task_scope_mismatch_and_unknown_parent_fail(tmp_path: Path) -> None:
    from strive.tasks import TASKS

    store = _store(tmp_path)
    run_cycle(store, TASK)
    other_id = next(t for t in TASKS if t != TASK.task_id)
    other = Store(store.root, other_id)
    run_cycle(other, TASKS[other_id])
    # a revision from ANOTHER task's lifecycle cannot be retained here
    other_record = next(iter(state(other).retained.values()))
    foreign: HarnessRevision = codec.loads(
        other.objects.get_text(other_record.revision_ref), HarnessRevision
    )
    with pytest.raises(LifecycleError, match="scoped to"):
        retain(store, foreign, task_fingerprint=TASK.fingerprint())
    # unknown parent
    orphan, _ = compose_revision(
        store,
        revision_id="rev-orphan",
        base_parent_id="rev-nonexistent",
        parent_manifest_bindings=_active_bindings(store),
        surfaces={("strategy-code", "solve"): "def solve(t):\n    return 0\n"},
        proposer="test@0",
        summary="orphan",
        task_fingerprint=TASK.fingerprint(),
    )
    with pytest.raises(LifecycleError, match="not retained; retain the parent"):
        retain(store, orphan, task_fingerprint=TASK.fingerprint())


def test_stale_head_and_conflicting_active_fail(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    baseline = active_revision_id(store)
    assert baseline is not None
    st = state(store)
    _compose_linked(
        store, "rev-stale", {("strategy-code", "solve"): "def solve(t):\n    return 5\n"}
    )
    with pytest.raises(LifecycleError, match="stale lifecycle head"):
        activate(
            store, "rev-stale", reason="rollback", policy_ref="manual@0",
            expected_head=st.head,  # pre-retention head: now stale
        )
    with pytest.raises(LifecycleError, match="expected active revision"):
        activate(
            store, "rev-stale", reason="rollback", policy_ref="manual@0",
            expected_active_revision_id="rev-wrong",
        )


def test_breaker_blocks_activation_and_clear_revalidates(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.open_breaker(store, "test")
    with pytest.raises(LifecycleError, match="breaker is open"):
        activate(store, "rev-0000", reason="rollback", policy_ref="manual@0")
    lifecycle.clear_breaker(store, "cleared after check")  # revalidates active
    assert not state(store).breaker_open
    # head-checked clear: a stale expected head refuses
    lifecycle.open_breaker(store, "again")
    stale_head = state(store).head
    lifecycle.open_breaker(store, "moved")  # journal advances
    with pytest.raises(LifecycleError):
        lifecycle.clear_breaker(store, "stale clear", expected_head=stale_head)


def test_unsafe_model_code_refuses_lifecycle_authority(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK, LoopConfig(unsafe_model_code=True))
    assert report.decision is not None and report.decision.accepted
    served = store.active_generation()
    assert served is not None and served.generation_id == "gen-0001"
    # NO lifecycle identity was written for the unsafe-run candidate
    st = state(store)
    assert all(not r.startswith("rev-cand-") for r in st.retained)
    parity = compat_parity(store)
    assert not parity.ok  # the gap is visible, not hidden
    # a later SAFE operation converges the lifecycle from the authoritative
    # generation ledger (kernel-derived history, not candidate-driven writes)
    run_cycle(store, TASK)
    assert compat_parity(store).ok


# -- legacy behavior, canary controls, parity, isolation intact --------------------------------------


def test_legacy_generation_behavior_and_projection_intact(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK)
    assert report.decision is not None and report.decision.accepted
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"
    projection = compatibility_projection(store)
    assert projection is not None
    assert projection.strategy_source_ref == active.source_ref
    assert projection.derived


def test_canary_controls_replay_and_parity_still_work(tmp_path: Path) -> None:
    from strive.dualwrite import parity_status
    from strive.loop import replay_run

    store = _store(tmp_path)
    set_mode(store, MODE_SHADOW, "test")
    report = run_cycle(store, TASK)
    assert reader_state(store).mode == MODE_SHADOW
    assert parity_status(store).complete
    replay = replay_run(store, TASK, report.run_id)
    assert replay.matches and replay.decision_matches


def test_cross_task_isolation_of_the_lifecycle_journal(tmp_path: Path) -> None:
    from strive.tasks import TASKS

    other_id = next(t for t in TASKS if t != TASK.task_id)
    root = tmp_path / "shared"
    a = Store(root, TASK.task_id)
    b = Store(root, other_id)
    run_cycle(a, TASK)
    run_cycle(b, TASKS[other_id])
    ctx_a, ctx_b = lifecycle_ctx(a), lifecycle_ctx(b)
    assert ctx_a.journal.path != ctx_b.journal.path
    assert all(r.task_id == TASK.task_id for r in state(a).retained.values())
    assert all(r.task_id == other_id for r in state(b).retained.values())
    assert compat_parity(a).ok and compat_parity(b).ok
