"""Stage-3C.2A: versioned validation evidence and policy-neutral selection.

Adversarial coverage: distinct task/prompt/constraint bundles for composite
candidates (surfaces cannot borrow evidence); one revision evaluated under
two dataset revisions without redefining identity; dataset growth forcing
incumbent re-baselining rather than task-drift acknowledgement; every
disposition requiring evidence; stale, missing-role, mismatched-subject,
inconclusive-constraint, corrupt, and unknown-validator-version evidence
failing closed; the idempotent migration backfill preserving original bytes
and refs; activation citing the exact SelectionDecision; replay recomputing
bundle metrics; and CLI inspection of manifests, bundles, decisions, roles,
and stale-evidence reasons.
"""

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from strive import codec, lifecycle
from strive.cli import main
from strive.contracts import REGRESSION, BudgetSpec, TaskCase
from strive.datasets import (
    current_dataset_revision,
    dataset_fingerprint,
    ensure_dataset_revision,
    load_dataset_revisions,
    materialize_split,
)
from strive.evidence import (
    DISPOSITION_FRONTIER_ADD,
    DecisionEvidence,
    EvaluationManifest,
    ROLE_CONSTRAINT,
    ROLE_PROMPT,
    ROLE_TASK,
    SelectionDecision,
    ValidationBundle,
    ValidatorResult,
    task_spec_version,
)
from strive.lifecycle import (
    LifecycleError,
    RevisionEvaluated,
    RevisionSelected,
    activation_readiness,
    active_revision_id,
    record_evaluation,
    record_selection,
    run_activation_op,
    state,
)
from strive.loop import replay_run, rollback_generation, run_cycle
from strive.migrations import apply_pending, pending_migrations
from strive.revisions import HarnessRevision, RevisionActivation
from strive.selection import (
    build_constraint_bundle,
    build_selection_decision,
    build_task_bundle,
)
from strive.store import Store
from strive.tasks import MAX_INTEGERS_TASK, Task
from strive.validators import ValidatorError, get_validator

# reuse the lifecycle suite's composite fixtures
import test_lifecycle
from test_lifecycle import (
    TASK,
    _compose_linked,
    _evaluate_and_select,
    _fixture_prompt,
    _record_prompt_evidence,
    _store,
    _strong_source,
)


def _grown_task() -> Task:
    """The task with one grown regression case — a routine dataset event."""
    return dataclasses.replace(
        TASK,
        cases=TASK.cases
        + (TaskCase("reg-grown", "grown -8 plus 3", -5, REGRESSION),),
    )


def _lifecycle_entries(store: Store) -> list[object]:
    return list(lifecycle.lifecycle(store).journal.read().entries)


# -- validator registry -----------------------------------------------------------------


def test_validator_registry_resolves_exactly() -> None:
    assert get_validator("task-suite@1").role == ROLE_TASK
    assert get_validator("prompt-comparison@1").role == ROLE_PROMPT
    assert get_validator("source-screen@1").role == ROLE_CONSTRAINT
    with pytest.raises(ValidatorError, match="unknown validator version"):
        get_validator("task-suite@99")  # known name, unknown version
    with pytest.raises(ValidatorError, match="unknown validator"):
        get_validator("vibes-check@1")


# -- dataset revisions ------------------------------------------------------------------


def test_dataset_revisions_reconstruct_and_grow(tmp_path: Path) -> None:
    store = _store(tmp_path)
    first = ensure_dataset_revision(store, TASK)
    assert first.revision == 1 and first.parent_revision is None
    assert first.reason == "initial"
    # idempotent: same data, same revision
    assert ensure_dataset_revision(store, TASK).revision == 1

    grown = _grown_task()
    second = ensure_dataset_revision(
        store, grown, reason="regression: captured failing input from run-x"
    )
    assert second.revision == 2 and second.parent_revision == 1
    assert second.fingerprint != first.fingerprint
    assert second.split_counts[REGRESSION] == 1
    # every historical split re-materializes EXACTLY from CAS
    visible_then = materialize_split(store, first, "visible")
    assert visible_then == TASK.visible_cases()
    regression_now = materialize_split(store, second, REGRESSION)
    assert regression_now[0].case_id == "reg-grown"
    assert [r.revision for r in load_dataset_revisions(store)] == [1, 2]
    # growing DATA never changes SPEC identity: no drift acknowledgement
    assert (
        task_spec_version(store, grown).fingerprint
        == task_spec_version(store, TASK).fingerprint
    )
    assert dataset_fingerprint(grown) != dataset_fingerprint(TASK)


# -- composite bundles: separate roles, no borrowing --------------------------------------


def test_composite_gets_distinct_task_prompt_constraint_bundles(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline == "rev-prompt-default"
    revision = _compose_linked(
        store,
        "rev-evidence-composite",
        {
            ("strategy-code", "solve"): _strong_source(store) + "\n# ev\n",
            ("prompt", "proposal-template"): _fixture_prompt("evidence"),
        },
    )
    _record_prompt_evidence(store, revision.ref.revision_id)
    _eval_ref, _decision_ref, accepted = _evaluate_and_select(
        store, revision, baseline
    )
    assert accepted
    st = state(store)
    link = next(
        l
        for l in reversed(st.evidence_links["rev-evidence-composite"])
        if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    roles = {e.role: e.bundle_ref for e in envelope.evidence}
    assert set(roles) == {ROLE_TASK, ROLE_CONSTRAINT, ROLE_PROMPT}
    assert len(set(roles.values())) == 3  # three DISTINCT bundles
    for role, bundle_ref in roles.items():
        bundle: ValidationBundle = codec.loads(
            store.objects.get_text(bundle_ref), ValidationBundle
        )
        assert bundle.role == role  # evidence cannot be relabeled
        assert bundle.subject.revision_id == "rev-evidence-composite"
    readiness = activation_readiness(store, "rev-evidence-composite")
    assert readiness.ok, readiness.reasons


def test_prompt_delta_without_prompt_evidence_cannot_activate(
    tmp_path: Path,
) -> None:
    """A harmful/unevidenced prompt cannot piggyback on good code: the
    composite's promoting selection lacks the prompt role, so activation
    fails closed naming the missing role."""
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        "rev-piggyback",
        {
            ("strategy-code", "solve"): _strong_source(store) + "\n# pb\n",
            ("prompt", "proposal-template"): _fixture_prompt("piggyback"),
        },
    )
    # NO surface evidence recorded: the synthesized selection carries only
    # task + constraint roles
    _eval_ref, decision_ref, accepted = _evaluate_and_select(
        store, revision, baseline
    )
    assert accepted  # the CODE passes the task gate
    readiness = activation_readiness(store, "rev-piggyback")
    assert not readiness.ok
    assert any("missing required evidence role(s): prompt" in r for r in readiness.reasons)
    with pytest.raises(LifecycleError, match="missing required evidence role"):
        run_activation_op(
            store,
            "rev-piggyback",
            reason="promote",
            policy_ref="paired-deterministic@1",
            decision_ref=decision_ref,
        )
    assert active_revision_id(store) == baseline  # nothing activated


# -- identity vs repeated evaluation -------------------------------------------------------


def test_one_revision_evaluated_under_two_dataset_revisions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        "rev-two-datasets",
        {("strategy-code", "solve"): _strong_source(store) + "\n# d2\n"},
    )
    _evaluate_and_select(store, revision, baseline)
    first_dataset = current_dataset_revision(store)
    assert first_dataset is not None and first_dataset.revision == 1

    # the dataset grows: the SAME revision is re-evaluated under r2 (the
    # grown task IS the current task from here on)
    grown = _grown_task()
    ensure_dataset_revision(store, grown, reason="regression growth")
    monkeypatch.setattr(test_lifecycle, "TASK", grown)
    _evaluate_and_select(store, revision, baseline)

    st = state(store)
    assert len(st.retained) == len(
        {r for r in st.retained}
    )  # identity: exactly one retained record for the revision
    evaluations = st.evaluations["rev-two-datasets"]
    assert len(evaluations) == 2  # appended, never redefined
    links = [
        l for l in st.evidence_links["rev-two-datasets"] if l.kind == "selection"
    ]
    fingerprints = set()
    for link in links:
        envelope: SelectionDecision = codec.loads(
            store.objects.get_text(link.envelope_ref), SelectionDecision
        )
        task_bundle_ref = next(
            e.bundle_ref for e in envelope.evidence if e.role == ROLE_TASK
        )
        bundle: ValidationBundle = codec.loads(
            store.objects.get_text(task_bundle_ref), ValidationBundle
        )
        manifest: EvaluationManifest = codec.loads(
            store.objects.get_text(bundle.evaluation_manifest_ref),
            EvaluationManifest,
        )
        fingerprints.add(manifest.dataset_fingerprint)
    assert len(fingerprints) == 2  # two manifests pin two dataset revisions


def test_dataset_growth_forces_rebaseline_not_drift_ack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        "rev-stale-data",
        {("strategy-code", "solve"): _strong_source(store) + "\n# sd\n"},
    )
    _eval_ref, decision_ref, accepted = _evaluate_and_select(
        store, revision, baseline
    )
    assert accepted
    assert activation_readiness(store, "rev-stale-data").ok

    # the dataset grows AFTER selection: the evidence is now stale
    grown = _grown_task()
    ensure_dataset_revision(store, grown, reason="regression growth")
    monkeypatch.setattr(test_lifecycle, "TASK", grown)
    readiness = activation_readiness(store, "rev-stale-data")
    assert not readiness.ok
    assert any("STALE evidence" in r for r in readiness.reasons)
    with pytest.raises(LifecycleError, match="STALE evidence"):
        run_activation_op(
            store,
            "rev-stale-data",
            reason="promote",
            policy_ref="paired-deterministic@1",
            decision_ref=decision_ref,
        )
    # re-baselining (re-evaluating under the current dataset) unblocks —
    # no task-drift acknowledgement is ever involved
    _evaluate_and_select(store, revision, baseline)
    assert activation_readiness(store, "rev-stale-data").ok
    run_activation_op(
        store,
        "rev-stale-data",
        reason="promote",
        policy_ref="paired-deterministic@1",
    )
    assert active_revision_id(store) == "rev-stale-data"


# -- dispositions -----------------------------------------------------------------------


def test_every_disposition_requires_evidence(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        "rev-no-envelope",
        {("strategy-code", "solve"): _strong_source(store) + "\n# ne\n"},
    )
    from strive.evaluate import evaluate as evaluate_task
    from strive.sandbox import run_strategy
    from strive.policy import get_policy

    cases = TASK.selection_cases()
    source = _strong_source(store) + "\n# ne\n"
    candidate_eval = evaluate_task(
        TASK, run_strategy(source, cases, generation_id="c"), cases
    )
    baseline_eval = evaluate_task(
        TASK,
        run_strategy(store.source_of(store.generations()["gen-0000"]), cases,
                     generation_id="b"),
        cases,
    )
    decision = get_policy("paired-deterministic").decide(
        baseline_eval, candidate_eval
    )
    evaluation_ref = store.objects.put_text(codec.dumps(candidate_eval))
    decision_ref = store.objects.put_text(codec.dumps(decision))
    # neither selection_ref nor task: refused — every disposition needs evidence
    with pytest.raises(LifecycleError, match="requires its SelectionDecision envelope"):
        record_selection(
            store,
            "rev-no-envelope",
            baseline_revision_id=baseline,
            evaluation_ref=evaluation_ref,
            decision_ref=decision_ref,
            policy_ref="paired-deterministic@1",
            accepted=decision.accepted,
        )


def test_frontier_add_is_recordable_but_never_activates(tmp_path: Path) -> None:
    """`frontier_add` is structurally supported (the population disposition)
    without any frontier algorithm: it records evidence-backed retention and
    does NOT authorize serving."""
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        "rev-frontier",
        {("strategy-code", "solve"): _strong_source(store) + "\n# fr\n"},
    )
    from strive.evaluate import evaluate as evaluate_task
    from strive.sandbox import run_strategy

    cases = TASK.selection_cases()
    source = _strong_source(store) + "\n# fr\n"
    candidate_eval = evaluate_task(
        TASK, run_strategy(source, cases, generation_id="c"), cases
    )
    evaluation_ref = store.objects.put_text(codec.dumps(candidate_eval))
    # a frontier_add decision: kept for the population, not promoted
    from strive.contracts import Decision

    legacy = Decision(
        accepted=False,
        reason="kept on the frontier (population retention)",
        policy="pareto-population",
        policy_version=0,
        baseline_score=0.0,
        candidate_score=candidate_eval.overall_score,
        baseline_split_scores={},
        candidate_split_scores=dict(candidate_eval.split_scores),
        regressed_case_ids=(),
    )
    decision_ref = store.objects.put_text(codec.dumps(legacy))
    _bundle, task_bundle_ref = build_task_bundle(
        store,
        TASK,
        subject_revision_id="rev-frontier",
        resolved_manifest_ref="",
        baseline_evaluation=None,
        candidate_evaluation=candidate_eval,
        decision=legacy,
        budget=BudgetSpec(),
    )
    _cb, constraint_bundle_ref = build_constraint_bundle(
        store,
        TASK,
        subject_revision_id="rev-frontier",
        resolved_manifest_ref="",
        screen_rejection_kind=None,
        screen_detail="screened",
        usage=None,
        budget=BudgetSpec(),
    )
    _sd, selection_ref = build_selection_decision(
        store,
        policy_ref="pareto-population@0",
        disposition=DISPOSITION_FRONTIER_ADD,
        subject_revision_id="rev-frontier",
        incumbent_revision_id=None,
        evidence=(
            DecisionEvidence(role=ROLE_TASK, bundle_ref=task_bundle_ref),
            DecisionEvidence(role=ROLE_CONSTRAINT, bundle_ref=constraint_bundle_ref),
        ),
        rationale="joins the frontier without dethroning the incumbent",
    )
    record_selection(
        store,
        "rev-frontier",
        baseline_revision_id=baseline,
        evaluation_ref=evaluation_ref,
        decision_ref=decision_ref,
        policy_ref="pareto-population@0",
        accepted=False,  # frontier_add does not authorize serving
        selection_ref=selection_ref,
    )
    readiness = activation_readiness(store, "rev-frontier")
    assert not readiness.ok  # latest selection is not an activating one
    with pytest.raises(LifecycleError, match="REJECTED"):
        run_activation_op(
            store,
            "rev-frontier",
            reason="promote",
            policy_ref="pareto-population@0",
        )


# -- fail-closed matrix -------------------------------------------------------------------


def _promotable(store: Store, revision_id: str) -> str:
    """A promotable revision with a synthesized envelope; returns baseline."""
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    revision = _compose_linked(
        store,
        revision_id,
        {("strategy-code", "solve"): _strong_source(store) + f"\n# {revision_id}\n"},
    )
    _evaluate_and_select(store, revision, baseline)
    return baseline


def test_unknown_validator_version_blocks_activation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-unknown-validator")
    # hand-craft an envelope whose bundle pins a FUTURE validator version
    st = state(store)
    link = next(
        l
        for l in reversed(st.evidence_links["rev-unknown-validator"])
        if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    task_bundle_ref = next(
        e.bundle_ref for e in envelope.evidence if e.role == ROLE_TASK
    )
    bundle: ValidationBundle = codec.loads(
        store.objects.get_text(task_bundle_ref), ValidationBundle
    )
    manifest: EvaluationManifest = codec.loads(
        store.objects.get_text(bundle.evaluation_manifest_ref), EvaluationManifest
    )
    future_manifest = dataclasses.replace(manifest, validators=("task-suite@99",))
    future_bundle = dataclasses.replace(
        bundle,
        evaluation_manifest_ref=store.objects.put_text(
            codec.dumps(future_manifest)
        ),
    )
    future_bundle_ref = store.objects.put_text(codec.dumps(future_bundle))
    future_envelope = dataclasses.replace(
        envelope,
        evidence=tuple(
            dataclasses.replace(e, bundle_ref=future_bundle_ref)
            if e.role == ROLE_TASK
            else e
            for e in envelope.evidence
        ),
    )
    future_ref = store.objects.put_text(codec.dumps(future_envelope))
    latest = st.selections["rev-unknown-validator"][-1]
    record_selection(
        store,
        "rev-unknown-validator",
        baseline_revision_id=baseline,
        evaluation_ref=latest.evaluation_ref,
        decision_ref=latest.decision_ref,
        policy_ref=latest.policy_ref,
        accepted=True,
        selection_ref=future_ref,
    )
    readiness = activation_readiness(store, "rev-unknown-validator")
    assert not readiness.ok
    assert any("unknown validator version" in r for r in readiness.reasons)


def test_mismatched_subject_and_relabeled_role_block(tmp_path: Path) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-mismatch")
    st = state(store)
    link = next(
        l for l in reversed(st.evidence_links["rev-mismatch"]) if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    task_ev = next(e for e in envelope.evidence if e.role == ROLE_TASK)
    bundle: ValidationBundle = codec.loads(
        store.objects.get_text(task_ev.bundle_ref), ValidationBundle
    )
    # (a) another revision's bundle: subject mismatch fails closed
    foreign_bundle = dataclasses.replace(
        bundle, subject=dataclasses.replace(bundle.subject, revision_id="rev-other")
    )
    foreign_ref = store.objects.put_text(codec.dumps(foreign_bundle))
    borrowed = dataclasses.replace(
        envelope,
        evidence=tuple(
            dataclasses.replace(e, bundle_ref=foreign_ref)
            if e.role == ROLE_TASK
            else e
            for e in envelope.evidence
        ),
    )
    latest = st.selections["rev-mismatch"][-1]
    record_selection(
        store,
        "rev-mismatch",
        baseline_revision_id=baseline,
        evaluation_ref=latest.evaluation_ref,
        decision_ref=latest.decision_ref,
        policy_ref=latest.policy_ref,
        accepted=True,
        selection_ref=store.objects.put_text(codec.dumps(borrowed)),
    )
    readiness = activation_readiness(store, "rev-mismatch")
    assert not readiness.ok
    assert any("cannot be borrowed across subjects" in r for r in readiness.reasons)
    # (b) a constraint bundle relabeled as prompt evidence fails closed
    constraint_ev = next(e for e in envelope.evidence if e.role == ROLE_CONSTRAINT)
    relabeled = dataclasses.replace(
        envelope,
        evidence=envelope.evidence
        + (DecisionEvidence(role=ROLE_PROMPT, bundle_ref=constraint_ev.bundle_ref),),
    )
    record_selection(
        store,
        "rev-mismatch",
        baseline_revision_id=baseline,
        evaluation_ref=latest.evaluation_ref,
        decision_ref=latest.decision_ref,
        policy_ref=latest.policy_ref,
        accepted=True,
        selection_ref=store.objects.put_text(codec.dumps(relabeled)),
    )
    readiness = activation_readiness(store, "rev-mismatch")
    assert not readiness.ok
    assert any("cannot be relabeled" in r for r in readiness.reasons)


def test_inconclusive_constraint_blocks_activation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-inconclusive")
    st = state(store)
    link = next(
        l
        for l in reversed(st.evidence_links["rev-inconclusive"])
        if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    # an inconclusive budget constraint (no metered usage recorded)
    _cb, inconclusive_ref = build_constraint_bundle(
        store,
        TASK,
        subject_revision_id="rev-inconclusive",
        resolved_manifest_ref="",
        screen_rejection_kind=None,
        screen_detail="screened",
        usage=None,  # unknown usage -> INCONCLUSIVE
        budget=BudgetSpec(),
    )
    weakened = dataclasses.replace(
        envelope,
        evidence=tuple(
            dataclasses.replace(e, bundle_ref=inconclusive_ref)
            if e.role == ROLE_CONSTRAINT
            else e
            for e in envelope.evidence
        ),
    )
    latest = st.selections["rev-inconclusive"][-1]
    record_selection(
        store,
        "rev-inconclusive",
        baseline_revision_id=baseline,
        evaluation_ref=latest.evaluation_ref,
        decision_ref=latest.decision_ref,
        policy_ref=latest.policy_ref,
        accepted=True,
        selection_ref=store.objects.put_text(codec.dumps(weakened)),
    )
    readiness = activation_readiness(store, "rev-inconclusive")
    assert not readiness.ok
    assert any("INCONCLUSIVE" in r for r in readiness.reasons)


def test_corrupt_envelope_and_artifact_block_activation(tmp_path: Path) -> None:
    store = _store(tmp_path)
    _baseline = _promotable(store, "rev-corrupt")
    st = state(store)
    link = next(
        l for l in reversed(st.evidence_links["rev-corrupt"]) if l.kind == "selection"
    )
    # corrupt the CAS object holding the selection envelope (same-UID write:
    # tamper-EVIDENT, and the gate fails closed on it)
    path = store.objects._path(link.envelope_ref)
    path.write_bytes(b'{"tampered": true}')
    readiness = activation_readiness(store, "rev-corrupt")
    assert not readiness.ok
    assert any("selection envelope corrupt" in r for r in readiness.reasons)


# -- migration backfill --------------------------------------------------------------------


def _append_legacy_assessment(store: Store, revision_id: str, baseline: str) -> tuple[str, str]:
    """Append PRE-ENVELOPE RevisionEvaluated/RevisionSelected records exactly
    as pre-3C.2A code did (direct journal writes, no EvidenceLink)."""
    from strive.evaluate import evaluate as evaluate_task
    from strive.events import now_iso
    from strive.policy import get_policy
    from strive.sandbox import run_strategy

    cases = TASK.selection_cases()
    source = _strong_source(store) + f"\n# {revision_id}\n"
    candidate_eval = evaluate_task(
        TASK, run_strategy(source, cases, generation_id="c"), cases
    )
    baseline_eval = evaluate_task(
        TASK,
        run_strategy(store.source_of(store.generations()["gen-0000"]), cases,
                     generation_id="b"),
        cases,
    )
    decision = get_policy("paired-deterministic").decide(baseline_eval, candidate_eval)
    evaluation_ref = store.objects.put_text(codec.dumps(candidate_eval))
    decision_ref = store.objects.put_text(codec.dumps(decision))
    st = state(store)
    from strive.revisions import HarnessRevision

    retained_revision: HarnessRevision = codec.loads(
        store.objects.get_text(st.retained[revision_id].revision_ref),
        HarnessRevision,
    )
    manifest_ref = retained_revision.scope_manifest_ref
    ctx = lifecycle.lifecycle(store)
    ctx.journal.append_batch(
        [
            RevisionEvaluated(
                revision_id=revision_id,
                baseline_revision_id=baseline,
                evaluation_ref=evaluation_ref,
                manifest_ref=manifest_ref,
                at=now_iso(),
            ),
            RevisionSelected(
                revision_id=revision_id,
                baseline_revision_id=baseline,
                evaluation_ref=evaluation_ref,
                decision_ref=decision_ref,
                policy_ref="paired-deterministic@1",
                accepted=decision.accepted,
                at=now_iso(),
            ),
        ]
    )
    return evaluation_ref, decision_ref


def test_migration_0005_is_idempotent_and_preserves_bytes(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = Store(root, TASK.task_id)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    _compose_linked(
        store,
        "rev-legacy-history",
        {("strategy-code", "solve"): _strong_source(store) + "\n# rev-legacy-history\n"},
    )
    evaluation_ref, decision_ref = _append_legacy_assessment(
        store, "rev-legacy-history", baseline
    )
    journal_path = lifecycle.lifecycle(store).journal.path
    before_bytes = journal_path.read_bytes()

    # pre-envelope history: activation refuses, naming the migration
    readiness = activation_readiness(store, "rev-legacy-history")
    assert not readiness.ok
    assert any("strive migrate" in r for r in readiness.reasons)

    pending = pending_migrations(root, TASK)
    assert "0005-evidence-backfill" in [m.migration_id for m in pending]
    reports = apply_pending(root, TASK)
    assert any(r.migration_id == "0005-evidence-backfill" for r in reports)

    # original bytes preserved as an exact prefix; nothing rewritten
    after_bytes = journal_path.read_bytes()
    assert after_bytes.startswith(before_bytes)
    # idempotent: a second run appends nothing
    assert not pending_migrations(root, TASK)
    size_after = journal_path.stat().st_size
    apply_pending(root, TASK)
    assert journal_path.stat().st_size == size_after

    # the synthetic envelope is LOSSLESS: the original refs ARE the artifacts
    st = state(store)
    link = next(
        l
        for l in st.evidence_links["rev-legacy-history"]
        if l.kind == "selection"
    )
    assert link.synthetic
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    task_bundle: ValidationBundle = codec.loads(
        store.objects.get_text(
            next(e.bundle_ref for e in envelope.evidence if e.role == ROLE_TASK)
        ),
        ValidationBundle,
    )
    artifact_refs = {r.artifact_ref for r in task_bundle.results}
    assert evaluation_ref in artifact_refs and decision_ref in artifact_refs
    # HONEST GRADING: the backfilled envelope is preserved for inspection but
    # NEVER authorizes a fresh promotion — inferred source-screen and usage
    # records aren't promote-grade; a modern re-evaluation is required
    readiness = activation_readiness(store, "rev-legacy-history")
    assert not readiness.ok
    assert any("modern re-evaluation is required" in r for r in readiness.reasons)
    with pytest.raises(LifecycleError, match="modern re-evaluation"):
        run_activation_op(
            store,
            "rev-legacy-history",
            reason="promote",
            policy_ref="paired-deterministic@1",
        )
    # a modern re-evaluation (real envelopes, pinned provenance) unblocks
    retained = codec.loads(
        store.objects.get_text(
            state(store).retained["rev-legacy-history"].revision_ref
        ),
        HarnessRevision,
    )
    _evaluate_and_select(store, retained, baseline)
    assert activation_readiness(store, "rev-legacy-history").ok


# -- activation citation, replay, rollback ---------------------------------------------------


def test_activation_cites_the_exact_selection_decision(tmp_path: Path) -> None:
    store = _store(tmp_path)
    run_cycle(store, TASK)
    activations = [
        e
        for e in _lifecycle_entries(store)
        if isinstance(e, RevisionActivation) and e.reason == "evolved"
    ]
    assert activations
    cited = activations[-1].decision_ref
    assert cited is not None
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(cited), SelectionDecision
    )
    assert envelope.disposition == "promote"
    assert envelope.subject.revision_id == activations[-1].revision.revision_id


def test_replay_recomputes_bundle_metrics_and_diffs(tmp_path: Path) -> None:
    store = _store(tmp_path)
    report = run_cycle(store, TASK)
    replay = replay_run(store, TASK, report.run_id)
    assert replay.matches and replay.decision_matches
    assert replay.bundle_checked
    assert replay.bundle_matches is True
    assert replay.bundle_metric_diffs is not None
    assert all(v == 0.0 for v in replay.bundle_metric_diffs.values())


def test_rollback_restart_and_cross_task_isolation_intact(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = Store(root, TASK.task_id)
    run_cycle(store, TASK)
    active_before = active_revision_id(store)
    lifecycle.rollback(store)  # whole-revision rollback drives BOTH journals
    # restart: a fresh process reads the same evidence state
    reopened = Store(root, TASK.task_id)
    st = lifecycle.state(reopened)
    assert st.active_revision_id != active_before
    assert current_dataset_revision(reopened) is not None
    # cross-task isolation: the other task has its own dataset journal
    other = Store(root, MAX_INTEGERS_TASK.task_id)
    run_cycle(other, MAX_INTEGERS_TASK)
    ours = current_dataset_revision(reopened)
    theirs = current_dataset_revision(other)
    assert ours is not None and theirs is not None
    assert ours.dataset_id != theirs.dataset_id
    assert ours.fingerprint != theirs.fingerprint


# -- CLI inspection ---------------------------------------------------------------------


def test_cli_evidence_reports_roles_and_blocking_reasons(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "artifacts"
    store = Store(root, TASK.task_id)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    # a composite whose prompt delta has NO surface-specific evidence: the
    # readiness verdict must stay blocked (a reason stable across the CLI's
    # own reconvergence, unlike synthetic dataset growth)
    revision = _compose_linked(
        store,
        "rev-cli-evidence",
        {
            ("strategy-code", "solve"): _strong_source(store) + "\n# cli\n",
            ("prompt", "proposal-template"): _fixture_prompt("cli"),
        },
    )
    _evaluate_and_select(store, revision, baseline)

    code = main(
        ["--json", "--artifacts", str(root), "evidence", "rev-cli-evidence"]
    )
    out = capsys.readouterr().out.strip().splitlines()[-1]
    envelope = json.loads(out)
    assert code == 0 and envelope["ok"] is True
    data = envelope["data"]
    assert data["revision_id"] == "rev-cli-evidence"
    assert data["dataset"]["current"]["revision"] == 1
    assert "task-suite@1" in data["validators_known"]
    roles = {r["role"] for s in data["selections"] for r in s["roles"]}
    assert {"task", "constraint"} <= roles
    bundle_roles = {b.get("role") for b in data["bundles"]}
    assert "task" in bundle_roles
    assert all(
        not b["manifest"]["stale_dataset"]
        for b in data["bundles"]
        if "manifest" in b
    )
    assert data["readiness"]["ok"] is False
    assert any(
        "missing required evidence role" in reason
        for reason in data["readiness"]["reasons"]
    )


# =====================================================================================
# Stage 3C.2A.1 — authoritative envelopes
# =====================================================================================


def test_regression_growth_passes_the_real_mutation_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Dataset growth flows through the REAL mutation guard with NO drift
    acknowledgement: the spec is unchanged, so run_cycle proceeds, the new
    dataset revision is persisted, and fresh evidence pins it."""
    store = _store(tmp_path)
    run_cycle(store, TASK)  # binds the task SPEC at seeding
    st = state(store)
    assert st.task_spec is not None

    grown = _grown_task()
    monkeypatch.setattr(test_lifecycle, "TASK", grown)
    # the real guard, mutating, with NO acknowledgement: growth is not drift
    report = run_cycle(store, grown)
    assert report is not None
    dataset = current_dataset_revision(store)
    assert dataset is not None and dataset.revision == 2
    assert not any(
        i.kind == "task-drift-acknowledged" for i in store.interventions()
    )
    # a SPEC change (version bump) still requires the acknowledgement
    from strive.store import StoreError

    spec_changed = dataclasses.replace(grown, version=99)
    with pytest.raises(StoreError, match="task-SPEC drift"):
        run_cycle(store, spec_changed)


def test_spec_drift_invalidates_evidence(tmp_path: Path) -> None:
    """Evidence produced under an older spec binding cannot authorize
    activation after an acknowledged spec re-bind."""
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-spec-drift")
    assert activation_readiness(store, "rev-spec-drift").ok
    lifecycle.bind_task_spec(store, dataclasses.replace(TASK, version=99))
    readiness = activation_readiness(store, "rev-spec-drift")
    assert not readiness.ok
    assert any("spec drift invalidates evidence" in r for r in readiness.reasons)
    assert baseline is not None


def test_wrong_but_noncrashing_candidate_cannot_promote(tmp_path: Path) -> None:
    """A candidate that executes cleanly but scores WRONG: the candidate
    suite is noncrashing, the paired comparison fails, and nothing
    activates — a noncrashing run is not acceptance."""
    store = _store(tmp_path)
    run_cycle(store, TASK)
    lifecycle.rollback(store)
    baseline = active_revision_id(store)
    assert baseline is not None
    wrong_source = (
        '"""Wrong but noncrashing."""\n\n\ndef solve(input_text: str) -> int:\n'
        "    return 0\n"
    )
    revision = _compose_linked(
        store, "rev-wrong-quiet", {("strategy-code", "solve"): wrong_source}
    )
    _eval_ref, _decision_ref, accepted = _evaluate_and_select(
        store, revision, baseline
    )
    assert not accepted  # the paired comparison failed despite clean execution
    readiness = activation_readiness(store, "rev-wrong-quiet")
    assert not readiness.ok
    assert any("REJECTED" in r for r in readiness.reasons)
    with pytest.raises(LifecycleError, match="REJECTED"):
        run_activation_op(
            store, "rev-wrong-quiet", reason="promote",
            policy_ref="paired-deterministic@1",
        )


def _tampered_selection(
    store: Store,
    revision_id: str,
    baseline: str,
    mutate: Any,
) -> None:
    """Re-record the latest selection with a tampered envelope produced by
    `mutate(envelope) -> envelope`."""
    st = state(store)
    link = next(
        l for l in reversed(st.evidence_links[revision_id]) if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    latest = st.selections[revision_id][-1]
    record_selection(
        store,
        revision_id,
        baseline_revision_id=baseline,
        evaluation_ref=latest.evaluation_ref,
        decision_ref=latest.decision_ref,
        policy_ref=latest.policy_ref,
        accepted=True,
        selection_ref=store.objects.put_text(codec.dumps(mutate(envelope))),
    )


def _replace_task_bundle(
    store: Store, envelope: SelectionDecision, mutate_bundle: Any
) -> SelectionDecision:
    task_ev = next(e for e in envelope.evidence if e.role == ROLE_TASK)
    bundle: ValidationBundle = codec.loads(
        store.objects.get_text(task_ev.bundle_ref), ValidationBundle
    )
    new_bundle = mutate_bundle(bundle)
    new_ref = store.objects.put_text(codec.dumps(new_bundle))
    return dataclasses.replace(
        envelope,
        evidence=tuple(
            dataclasses.replace(e, bundle_ref=new_ref) if e.role == ROLE_TASK else e
            for e in envelope.evidence
        ),
    )


def test_missing_paired_comparison_blocks(tmp_path: Path) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-no-comparison")

    def drop_comparison(bundle: ValidationBundle) -> ValidationBundle:
        return dataclasses.replace(
            bundle,
            results=tuple(
                r for r in bundle.results if r.validator != "paired-comparison@1"
            ),
        )

    _tampered_selection(
        store, "rev-no-comparison", baseline,
        lambda env: _replace_task_bundle(store, env, drop_comparison),
    )
    readiness = activation_readiness(store, "rev-no-comparison")
    assert not readiness.ok
    assert any("paired-comparison" in r for r in readiness.reasons)


def test_failed_paired_comparison_blocks(tmp_path: Path) -> None:
    """A comparison whose recorded decision was REJECTED cannot ride into a
    promote — even when every suite result 'passed' (noncrashing)."""
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-failed-comparison")
    from strive.contracts import Decision

    rejected = Decision(
        accepted=False,
        reason="tampered: rejected comparison",
        policy="paired-deterministic",
        policy_version=1,
        baseline_score=0.0,
        candidate_score=1.0,
        baseline_split_scores={},
        candidate_split_scores={},
        regressed_case_ids=(),
    )
    rejected_ref = store.objects.put_text(codec.dumps(rejected))

    def swap_comparison_artifact(bundle: ValidationBundle) -> ValidationBundle:
        return dataclasses.replace(
            bundle,
            results=tuple(
                dataclasses.replace(r, artifact_ref=rejected_ref)
                if r.validator == "paired-comparison@1"
                else r
                for r in bundle.results
            ),
        )

    _tampered_selection(
        store, "rev-failed-comparison", baseline,
        lambda env: _replace_task_bundle(store, env, swap_comparison_artifact),
    )
    readiness = activation_readiness(store, "rev-failed-comparison")
    assert not readiness.ok
    assert any("NOT accepted" in r for r in readiness.reasons)


def test_objective_mismatch_blocks(tmp_path: Path) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-objective-mismatch")
    from strive.evidence import ObjectiveSpec, ObjectiveTerm

    other_objective = ObjectiveSpec(
        name="latency-first", version=1, description="different objective",
        objectives=(ObjectiveTerm(metric="latency", direction="min", weight=1.0),),
        constraints=(),
    )
    other_ref = store.objects.put_text(codec.dumps(other_objective))

    def swap_objective(bundle: ValidationBundle) -> ValidationBundle:
        manifest: EvaluationManifest = codec.loads(
            store.objects.get_text(bundle.evaluation_manifest_ref),
            EvaluationManifest,
        )
        new_manifest = dataclasses.replace(manifest, objective_spec_ref=other_ref)
        return dataclasses.replace(
            bundle,
            evaluation_manifest_ref=store.objects.put_text(
                codec.dumps(new_manifest)
            ),
        )

    _tampered_selection(
        store, "rev-objective-mismatch", baseline,
        lambda env: _replace_task_bundle(store, env, swap_objective),
    )
    readiness = activation_readiness(store, "rev-objective-mismatch")
    assert not readiness.ok
    assert any(
        "objective spec differs from the decision's" in r for r in readiness.reasons
    )


def test_execution_record_as_resolved_manifest_blocks(tmp_path: Path) -> None:
    """An ExecutionRecord smuggled in as the resolved manifest fails the
    exact-type decode — the manifest must pin a ResolvedHarnessManifest."""
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-record-smuggle")

    def smuggle(bundle: ValidationBundle) -> ValidationBundle:
        manifest: EvaluationManifest = codec.loads(
            store.objects.get_text(bundle.evaluation_manifest_ref),
            EvaluationManifest,
        )
        # point resolved_manifest_ref at the EXECUTION RECORD instead
        new_manifest = dataclasses.replace(
            manifest, resolved_manifest_ref=manifest.execution_record_ref
        )
        return dataclasses.replace(
            bundle,
            evaluation_manifest_ref=store.objects.put_text(
                codec.dumps(new_manifest)
            ),
        )

    _tampered_selection(
        store, "rev-record-smuggle", baseline,
        lambda env: _replace_task_bundle(store, env, smuggle),
    )
    readiness = activation_readiness(store, "rev-record-smuggle")
    assert not readiness.ok
    assert any(
        "does not decode to a ResolvedHarnessManifest" in r
        for r in readiness.reasons
    )


def test_duplicate_roles_and_validators_and_extraneous_results_block(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path)
    baseline = _promotable(store, "rev-duplicates")
    st = state(store)
    link = next(
        l for l in reversed(st.evidence_links["rev-duplicates"]) if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    task_ev = next(e for e in envelope.evidence if e.role == ROLE_TASK)
    # (a) duplicate role
    _tampered_selection(
        store, "rev-duplicates", baseline,
        lambda env: dataclasses.replace(env, evidence=env.evidence + (task_ev,)),
    )
    readiness = activation_readiness(store, "rev-duplicates")
    assert not readiness.ok
    assert any("duplicate evidence role" in r for r in readiness.reasons)

    # (b) duplicate (validator, subject_role) result + extraneous validator
    def duplicate_and_extraneous(bundle: ValidationBundle) -> ValidationBundle:
        extraneous = dataclasses.replace(
            bundle.results[0], validator="source-screen@1"
        )
        return dataclasses.replace(
            bundle, results=bundle.results + (bundle.results[0], extraneous)
        )

    _tampered_selection(
        store, "rev-duplicates", baseline,
        lambda env: _replace_task_bundle(store, env, duplicate_and_extraneous),
    )
    readiness = activation_readiness(store, "rev-duplicates")
    assert not readiness.ok
    assert any("duplicate result" in r for r in readiness.reasons)
    assert any("never pinned" in r for r in readiness.reasons)


def test_budget_validation_covers_every_dimension() -> None:
    """Each budget dimension is enforced with the meter's exact limit
    semantics: -1 accounting-only, 0 nothing-allowed, otherwise usage must
    not exceed the limit."""
    from strive.contracts import BudgetUsage
    from strive.validators import budget_result

    spec = BudgetSpec(
        wall_time_s=10.0, executions=4, model_calls=2, tokens=100,
        output_bytes=1000, cost=1.0, max_recursion_depth=1,
    )
    ok = BudgetUsage(
        wall_time_s=9.0, executions=4, model_calls=2, tokens=100,
        output_bytes=1000, cost=1.0, recursion_depth=1,
    )
    assert budget_result(ok, spec).status == "passed"  # AT the limit is fine

    overruns = {
        "wall_time_s": dataclasses.replace(ok, wall_time_s=10.5),
        "executions": dataclasses.replace(ok, executions=5),
        "model_calls": dataclasses.replace(ok, model_calls=3),
        "tokens": dataclasses.replace(ok, tokens=101),
        "output_bytes": dataclasses.replace(ok, output_bytes=1001),
        "cost": dataclasses.replace(ok, cost=1.5),
        "recursion_depth": dataclasses.replace(ok, recursion_depth=2),
    }
    for dimension, usage in overruns.items():
        result = budget_result(usage, spec)
        assert result.status == "failed", dimension
        assert dimension in result.detail, dimension
    # -1: accounting only — never a violation
    unlimited = BudgetSpec(
        wall_time_s=-1, executions=-1, model_calls=-1, tokens=-1,
        output_bytes=-1, cost=-1.0, max_recursion_depth=-1,
    )
    heavy = BudgetUsage(
        wall_time_s=9e9, executions=10**6, model_calls=10**6, tokens=10**9,
        output_bytes=10**9, cost=9e9, recursion_depth=99,
    )
    assert budget_result(heavy, unlimited).status == "passed"
    # 0: nothing allowed — any usage violates
    nothing = BudgetSpec(
        wall_time_s=0, executions=0, model_calls=0, tokens=0,
        output_bytes=0, cost=0.0, max_recursion_depth=0,
    )
    result = budget_result(BudgetUsage(executions=1), nothing)
    assert result.status == "failed" and "executions" in result.detail
    assert budget_result(BudgetUsage(), nothing).status == "passed"
    # unknown usage: INCONCLUSIVE (blocks activation)
    assert budget_result(None, spec).status == "inconclusive"


def test_concurrent_dataset_growth_is_serialized(tmp_path: Path) -> None:
    """Racing writers are serialized by the journal lock: lineage stays
    monotonic with exact parent linkage, and a writer that decided against
    a stale head refuses."""
    from concurrent.futures import ThreadPoolExecutor

    from strive.datasets import DatasetError, dataset_head

    store = _store(tmp_path)
    ensure_dataset_revision(store, TASK)

    def variant(i: int) -> Task:
        return dataclasses.replace(
            TASK,
            cases=TASK.cases
            + tuple(
                TaskCase(f"reg-{j}", f"case {j}: -{j} and {j}", 0, REGRESSION)
                for j in range(1, i + 2)
            ),
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(
            lambda i: ensure_dataset_revision(
                store, variant(i), reason=f"growth {i}"
            ),
            list(range(6)) * 2,  # repeats: idempotency under contention
        ))
    revisions = load_dataset_revisions(store)
    assert [r.revision for r in revisions] == list(range(1, len(revisions) + 1))
    assert [r.parent_revision for r in revisions] == [None] + [
        r.revision for r in revisions[:-1]
    ]
    # expected-head: a decision made against a stale view refuses
    stale_head = dataset_head(revisions[:1])
    with pytest.raises(DatasetError, match="stale dataset head"):
        ensure_dataset_revision(
            store, variant(40), reason="stale", expected_head=stale_head
        )
    # and the CURRENT head is accepted
    ensure_dataset_revision(
        store, variant(41), reason="fresh", expected_head=dataset_head(revisions)
    )


def test_dataset_crash_injection_torn_tail_and_interior_corruption(
    tmp_path: Path,
) -> None:
    from strive.datasets import DatasetError, _journal_path

    store = _store(tmp_path)
    ensure_dataset_revision(store, TASK)
    path = Path(_journal_path(store))
    good_bytes = path.read_bytes()

    # crash mid-append: a torn (unterminated) final line
    path.write_bytes(good_bytes + b'{"schema": "dataset-revision@1", "trunc')
    with pytest.raises(DatasetError, match="torn final line"):
        load_dataset_revisions(store)
    # ensure recovers UNDER THE LOCK: quarantine + truncate, then proceeds
    recovered = ensure_dataset_revision(store, _grown_task(), reason="post-crash")
    assert recovered.revision == 2
    quarantines = list(path.parent.glob(f"{path.name}.quarantine-*"))
    assert quarantines and b"trunc" in quarantines[0].read_bytes()

    # interior corruption (a bad line WITH newline) never auto-repairs
    lines = path.read_bytes().splitlines(keepends=True)
    path.write_bytes(lines[0] + b'{"not": "a revision"}\n' + b"".join(lines[1:]))
    with pytest.raises(DatasetError, match="corrupt"):
        load_dataset_revisions(store)
    with pytest.raises(DatasetError, match="corrupt"):
        ensure_dataset_revision(store, TASK)


def test_promote_grade_evidence_pins_verified_provenance(tmp_path: Path) -> None:
    """A modern promote-grade envelope decodes to the exact
    ResolvedHarnessManifest + ExecutionRecord, refs and fingerprints agree,
    and the manifest pins the exact TaskSpecVersion and DatasetRevision."""
    from strive.evidence import DatasetRevision as DatasetRevisionRecord
    from strive.evidence import TaskSpecVersion
    from strive.reader import ExecutionRecord
    from strive.revisions import ResolvedHarnessManifest

    store = _store(tmp_path)
    baseline = _promotable(store, "rev-provenance")
    assert baseline is not None
    st = state(store)
    link = next(
        l for l in reversed(st.evidence_links["rev-provenance"]) if l.kind == "selection"
    )
    envelope: SelectionDecision = codec.loads(
        store.objects.get_text(link.envelope_ref), SelectionDecision
    )
    for item in envelope.evidence:
        bundle: ValidationBundle = codec.loads(
            store.objects.get_text(item.bundle_ref), ValidationBundle
        )
        manifest: EvaluationManifest = codec.loads(
            store.objects.get_text(bundle.evaluation_manifest_ref),
            EvaluationManifest,
        )
        resolved = codec.loads(
            store.objects.get_text(manifest.resolved_manifest_ref),
            ResolvedHarnessManifest,
        )
        assert resolved.effective  # the exact resolved harness, not a record
        record = codec.loads(
            store.objects.get_text(manifest.execution_record_ref), ExecutionRecord
        )
        assert record.subject_revision_ref == st.retained["rev-provenance"].revision_ref
        assert record.base_resolved_ref == manifest.resolved_manifest_ref
        assert record.canonical_head
        spec: TaskSpecVersion = codec.loads(
            store.objects.get_text(manifest.task_spec_ref), TaskSpecVersion
        )
        assert spec.fingerprint == manifest.task_fingerprint
        dataset: DatasetRevisionRecord = codec.loads(
            store.objects.get_text(manifest.dataset_revision_ref),
            DatasetRevisionRecord,
        )
        assert dataset.fingerprint == manifest.dataset_fingerprint
