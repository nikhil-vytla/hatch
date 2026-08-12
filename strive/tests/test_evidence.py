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
from strive.revisions import RevisionActivation
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
    # and the backfilled evidence now authorizes activation
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
