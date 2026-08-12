"""Building validation bundles and policy-neutral selection decisions.

This module turns the kernel's existing trusted mechanisms into the
ADR-0004 envelopes: evaluation manifests pin everything an assessment ran
under; bundles carry role-bound validator results with flat metrics and
CAS artifacts; selection decisions link typed evidence per role. It also
owns the SYNTHETIC-BUT-LOSSLESS mapping from legacy records (`Evaluation`
+ `Decision` + `SurfaceEvidence`) used by migration 0005 and by callers
that still record legacy-shaped assessments — original bytes and refs are
preserved untouched; the envelope is derived alongside them.
"""

from __future__ import annotations

import platform
from dataclasses import dataclass

from strive import codec, validators
from strive.contracts import BudgetSpec, BudgetUsage, Decision, Evaluation
from strive.datasets import dataset_revision_ref, ensure_dataset_revision
from strive.events import now_iso
from strive.evidence import (
    DISPOSITION_PROMOTE,
    DISPOSITION_REJECT,
    store_task_spec,
    DecisionEvidence,
    EvaluationManifest,
    FUNCTION_TASK_ENVIRONMENT,
    FUNCTION_TASK_SCORER,
    ROLE_CONSTRAINT,
    ROLE_PROMPT,
    ROLE_TASK,
    SelectionDecision,
    ValidationBundle,
    ValidatorResult,
    objective_spec_ref,
    validate_bundle,
    validate_selection,
)
from strive.revisions import LEVEL_TASK, RevisionRef, ScopeRef
from strive.tasks import Task

STRIVE_TOOL_VERSION = "strive-evidence@1"


def _runtime() -> str:
    return f"cpython-{platform.python_version()}"


def build_evaluation_manifest(
    store: object,
    task: Task,
    *,
    resolved_manifest_ref: str,
    validator_refs: tuple[str, ...],
    budget: BudgetSpec,
    seeds: tuple[int, ...] = (),
    execution_record_ref: str = "",
) -> tuple[EvaluationManifest, str]:
    """Pin everything the assessment ran under — by exact REF, not
    fingerprint alone: the TaskSpecVersion and the CURRENT DatasetRevision
    are CAS-published and referenced, with their fingerprints pinned
    alongside (the activation gate verifies ref-vs-fingerprint agreement).
    The dataset revision is the current persisted one (appended first if
    the task's data is new) — which is exactly what makes stale evidence
    visible. `resolved_manifest_ref` must be the ResolvedHarnessManifest
    the evaluation executed under (or "" for historical/inferred
    envelopes, which never authorize fresh promotion)."""
    for ref in validator_refs:
        validators.get_validator(ref)  # manifests never pin unknown validators
    dataset = ensure_dataset_revision(store, task)
    spec, spec_ref = store_task_spec(store, task)
    manifest = EvaluationManifest(
        resolved_manifest_ref=resolved_manifest_ref,
        execution_record_ref=execution_record_ref,
        objective_spec_ref=objective_spec_ref(store),
        task_spec_ref=spec_ref,
        dataset_revision_ref=dataset_revision_ref(store, dataset),
        task_fingerprint=spec.fingerprint,
        dataset_fingerprint=dataset.fingerprint,
        environment=FUNCTION_TASK_ENVIRONMENT,
        scorer=FUNCTION_TASK_SCORER,
        tool_versions={"strive": STRIVE_TOOL_VERSION},
        runtime=_runtime(),
        seeds=seeds,
        validators=validator_refs,
        budget=budget,
    )
    objects = getattr(store, "objects")
    return manifest, objects.put_text(codec.dumps(manifest))


def _subject_ref(store: object, revision_id: str) -> RevisionRef:
    return RevisionRef(
        ScopeRef(LEVEL_TASK, str(getattr(store, "task_id"))), revision_id
    )


def _store_bundle(store: object, bundle: ValidationBundle) -> str:
    validate_bundle(bundle)
    objects = getattr(store, "objects")
    ref: str = objects.put_text(codec.dumps(bundle))
    return ref


def build_task_bundle(
    store: object,
    task: Task,
    *,
    subject_revision_id: str,
    resolved_manifest_ref: str,
    baseline_evaluation: Evaluation | None,
    candidate_evaluation: Evaluation,
    decision: Decision,
    budget: BudgetSpec,
    seeds: tuple[int, ...] = (),
    execution_record_ref: str = "",
) -> tuple[ValidationBundle, str]:
    """The task-role bundle: baseline suite, candidate suite, and the paired
    comparison — per-case outcomes and regression ids in CAS artifacts."""
    results: list[ValidatorResult] = []
    if baseline_evaluation is not None:
        results.append(
            validators.task_suite_result(
                store, baseline_evaluation, subject_role="baseline"
            )
        )
    results.append(
        validators.task_suite_result(
            store, candidate_evaluation, subject_role="candidate"
        )
    )
    results.append(validators.paired_comparison_result(store, decision))
    _manifest, manifest_ref = build_evaluation_manifest(
        store,
        task,
        resolved_manifest_ref=resolved_manifest_ref,
        validator_refs=(validators.TASK_SUITE.ref, validators.PAIRED_COMPARISON.ref),
        budget=budget,
        seeds=seeds,
        execution_record_ref=execution_record_ref,
    )
    bundle = ValidationBundle(
        role=ROLE_TASK,
        evaluation_manifest_ref=manifest_ref,
        subject=_subject_ref(store, subject_revision_id),
        results=tuple(results),
        feedback=candidate_evaluation.feedback,
        at=now_iso(),
    )
    return bundle, _store_bundle(store, bundle)


def build_prompt_bundle(
    store: object,
    task: Task,
    *,
    subject_revision_id: str,
    resolved_manifest_ref: str,
    prompt_evidence_ref: str,
    improved: bool,
    detail: str,
    budget: BudgetSpec,
    execution_record_ref: str = "",
) -> tuple[ValidationBundle, str]:
    """The prompt-role bundle: the trusted template comparison, linked to
    the exact composite revision — never derived from code scores."""
    _manifest, manifest_ref = build_evaluation_manifest(
        store,
        task,
        resolved_manifest_ref=resolved_manifest_ref,
        validator_refs=(validators.PROMPT_COMPARISON.ref,),
        budget=budget,
        execution_record_ref=execution_record_ref,
    )
    bundle = ValidationBundle(
        role=ROLE_PROMPT,
        evaluation_manifest_ref=manifest_ref,
        subject=_subject_ref(store, subject_revision_id),
        results=(
            validators.prompt_comparison_result(
                prompt_evidence_ref, improved=improved, detail=detail
            ),
        ),
        feedback=detail,
        at=now_iso(),
    )
    return bundle, _store_bundle(store, bundle)


def build_constraint_bundle(
    store: object,
    task: Task,
    *,
    subject_revision_id: str,
    resolved_manifest_ref: str,
    screen_rejection_kind: str | None,
    screen_detail: str,
    usage: BudgetUsage | None,
    budget: BudgetSpec,
    execution_record_ref: str = "",
) -> tuple[ValidationBundle, str]:
    """The constraint-role bundle: source screening + budget ceilings. An
    inconclusive result here blocks activation."""
    _manifest, manifest_ref = build_evaluation_manifest(
        store,
        task,
        resolved_manifest_ref=resolved_manifest_ref,
        validator_refs=(
            validators.SOURCE_SCREEN.ref,
            validators.BUDGET_WITHIN_SPEC.ref,
        ),
        budget=budget,
        execution_record_ref=execution_record_ref,
    )
    results = (
        validators.source_screen_result(screen_rejection_kind, screen_detail),
        validators.budget_result(usage, budget),
    )
    bundle = ValidationBundle(
        role=ROLE_CONSTRAINT,
        evaluation_manifest_ref=manifest_ref,
        subject=_subject_ref(store, subject_revision_id),
        results=results,
        feedback=screen_detail,
        at=now_iso(),
    )
    return bundle, _store_bundle(store, bundle)


def build_selection_decision(
    store: object,
    *,
    policy_ref: str,
    disposition: str,
    subject_revision_id: str,
    incumbent_revision_id: str | None,
    evidence: tuple[DecisionEvidence, ...],
    rationale: str,
) -> tuple[SelectionDecision, str]:
    decision = SelectionDecision(
        policy_ref=policy_ref,
        objective_spec_ref=objective_spec_ref(store),
        disposition=disposition,
        subject=_subject_ref(store, subject_revision_id),
        incumbent=(
            _subject_ref(store, incumbent_revision_id)
            if incumbent_revision_id is not None
            else None
        ),
        evidence=evidence,
        rationale=rationale,
        at=now_iso(),
    )
    validate_selection(decision)
    objects = getattr(store, "objects")
    return decision, objects.put_text(codec.dumps(decision))


def synthesize_evaluation_bundle(
    store: object,
    task: Task,
    *,
    revision_id: str,
    evaluation_ref: str,
) -> str:
    """The lossless task-role envelope one legacy `RevisionEvaluated`
    implies: a candidate suite result whose artifact IS the original
    evaluation ref (byte-identical, never rewritten)."""
    objects = getattr(store, "objects")
    evaluation: Evaluation = codec.loads(
        objects.get_text(evaluation_ref), Evaluation
    )
    suite = validators.task_suite_result(store, evaluation, subject_role="candidate")
    suite = ValidatorResult(
        validator=suite.validator,
        subject_role=suite.subject_role,
        status=suite.status,
        metrics=suite.metrics,
        detail=suite.detail,
        artifact_ref=evaluation_ref,
    )
    _manifest, manifest_ref = build_evaluation_manifest(
        store,
        task,
        resolved_manifest_ref="",
        validator_refs=(validators.TASK_SUITE.ref,),
        budget=BudgetSpec(),
    )
    bundle = ValidationBundle(
        role=ROLE_TASK,
        evaluation_manifest_ref=manifest_ref,
        subject=_subject_ref(store, revision_id),
        results=(suite,),
        feedback=evaluation.feedback,
        at=now_iso(),
    )
    return _store_bundle(store, bundle)


@dataclass(frozen=True)
class ExecutionProvenance:
    """The provenance pair every promote-authorizing manifest pins: the
    exact ResolvedHarnessManifest the evaluation executed under and the
    per-execution ExecutionRecord naming the subject."""

    resolved_manifest_ref: str
    execution_record_ref: str


def pin_execution_provenance(
    store: object,
    *,
    subject_revision_id: str,
    operation: str,
    run_id: str | None = None,
    detail: str = "harness-internal metered evaluation (no StateReader)",
) -> ExecutionProvenance:
    """Pin truthful execution provenance for a harness-internal evaluation
    path that does not run through `StateReader` (the experiment's metered
    gate, lifecycle fixtures): the ACTIVE resolved manifest as the baseline
    harness, the retained subject revision by its exact CAS ref, and the
    live journal head. This constructs a record of what IS — the
    activation gate then verifies the same agreements it verifies for
    reader-produced records."""
    from strive import lifecycle
    from strive.reader import ExecutionRecord

    ctx = lifecycle.lifecycle(store)
    st = lifecycle.state(store)
    record_entry = st.retained.get(subject_revision_id)
    if record_entry is None:
        raise ValueError(f"subject {subject_revision_id} is not retained")
    resolved = lifecycle.materialize_active(store)
    if resolved is None:
        raise ValueError("no active revision to resolve the baseline harness")
    resolved_ref = ctx.objects.put_text(codec.dumps(resolved))
    revision = lifecycle.load_revision(ctx, record_entry.revision_ref)
    execution_record = ExecutionRecord(
        operation=operation,
        subject=subject_revision_id,
        subject_kind="candidate-overlay",
        subject_revision_ref=record_entry.revision_ref,
        base_resolved_ref=resolved_ref,
        effective_manifest_ref=revision.scope_manifest_ref,
        canonical_head=st.head,
        mirror_head="",
        op_id=f"assess-{subject_revision_id}",
        detail=detail,
        at=now_iso(),
        run_id=run_id,
    )
    return ExecutionProvenance(
        resolved_manifest_ref=resolved_ref,
        execution_record_ref=ctx.objects.put_text(codec.dumps(execution_record)),
    )


@dataclass(frozen=True)
class RecordedAssessment:
    """What one full assessment persisted: the legacy decision ref, the
    SelectionDecision envelope (which activation cites), and the per-role
    bundle refs."""

    revision_id: str
    evaluation_ref: str
    decision_ref: str
    selection_ref: str
    task_bundle_ref: str
    constraint_bundle_ref: str
    prompt_bundle_ref: str | None


def record_assessment(
    store: object,
    task: Task,
    *,
    revision_id: str,
    baseline_revision_id: str | None,
    baseline_evaluation: Evaluation | None,
    candidate_evaluation: Evaluation,
    decision: Decision,
    policy_ref: str,
    scope_manifest_ref: str,
    provenance: ExecutionProvenance,
    usage: BudgetUsage,
    budget: BudgetSpec,
    seeds: tuple[int, ...] = (),
    screen_rejection_kind: str | None = None,
    screen_detail: str = "kernel source screen passed before evaluation",
    prompt_evidence_ref: str | None = None,
    prompt_improved: bool | None = None,
    run_id: str | None = None,
) -> RecordedAssessment:
    """Record one REAL assessment with modern promote-grade envelopes:
    separate task/constraint(/prompt) bundles pinned to the exact execution
    provenance, a SelectionDecision linking them by role, and the lifecycle
    evaluation + selection records carrying the envelope refs. The shared
    path for the loop, the experiment, and lifecycle fixtures — the only
    evidence the activation gate accepts for a fresh promotion."""
    from strive import lifecycle
    from strive.evidence import DecisionEvidence

    evaluation_ref_ = getattr(store, "objects").put_text(
        codec.dumps(candidate_evaluation)
    )
    decision_ref_ = getattr(store, "objects").put_text(codec.dumps(decision))
    _tb, task_bundle_ref = build_task_bundle(
        store,
        task,
        subject_revision_id=revision_id,
        resolved_manifest_ref=provenance.resolved_manifest_ref,
        baseline_evaluation=baseline_evaluation,
        candidate_evaluation=candidate_evaluation,
        decision=decision,
        budget=budget,
        seeds=seeds,
        execution_record_ref=provenance.execution_record_ref,
    )
    _cb, constraint_bundle_ref = build_constraint_bundle(
        store,
        task,
        subject_revision_id=revision_id,
        resolved_manifest_ref=provenance.resolved_manifest_ref,
        screen_rejection_kind=screen_rejection_kind,
        screen_detail=screen_detail,
        usage=usage,
        budget=budget,
        execution_record_ref=provenance.execution_record_ref,
    )
    evidence = [
        DecisionEvidence(role=ROLE_TASK, bundle_ref=task_bundle_ref),
        DecisionEvidence(role=ROLE_CONSTRAINT, bundle_ref=constraint_bundle_ref),
    ]
    prompt_bundle_ref: str | None = None
    if prompt_evidence_ref is not None and prompt_improved is not None:
        _pb, prompt_bundle_ref = build_prompt_bundle(
            store,
            task,
            subject_revision_id=revision_id,
            resolved_manifest_ref=provenance.resolved_manifest_ref,
            prompt_evidence_ref=prompt_evidence_ref,
            improved=prompt_improved,
            detail="trusted prompt-vs-prompt comparison (see artifact)",
            budget=budget,
            execution_record_ref=provenance.execution_record_ref,
        )
        evidence.append(
            DecisionEvidence(role=ROLE_PROMPT, bundle_ref=prompt_bundle_ref)
        )
    _sd, selection_ref = build_selection_decision(
        store,
        policy_ref=policy_ref,
        disposition=(
            DISPOSITION_PROMOTE if decision.accepted else DISPOSITION_REJECT
        ),
        subject_revision_id=revision_id,
        incumbent_revision_id=baseline_revision_id,
        evidence=tuple(evidence),
        rationale=decision.reason,
    )
    lifecycle.record_evaluation(
        store,
        revision_id,
        baseline_revision_id=baseline_revision_id,
        evaluation_ref=evaluation_ref_,
        manifest_ref=scope_manifest_ref,
        run_id=run_id,
        bundle_ref=task_bundle_ref,
    )
    lifecycle.record_selection(
        store,
        revision_id,
        baseline_revision_id=baseline_revision_id,
        evaluation_ref=evaluation_ref_,
        decision_ref=decision_ref_,
        policy_ref=policy_ref,
        accepted=decision.accepted,
        run_id=run_id,
        selection_ref=selection_ref,
    )
    return RecordedAssessment(
        revision_id=revision_id,
        evaluation_ref=evaluation_ref_,
        decision_ref=decision_ref_,
        selection_ref=selection_ref,
        task_bundle_ref=task_bundle_ref,
        constraint_bundle_ref=constraint_bundle_ref,
        prompt_bundle_ref=prompt_bundle_ref,
    )


# -- the synthetic-but-lossless legacy mapping (ADR-0004 compatibility) ---------------------------


@dataclass(frozen=True)
class SynthesizedSelection:
    selection_ref: str
    task_bundle_ref: str
    constraint_bundle_ref: str
    prompt_bundle_ref: str | None


def synthesize_selection(
    store: object,
    task: Task,
    *,
    revision_id: str,
    baseline_revision_id: str | None,
    evaluation_ref: str,
    decision_ref: str,
    policy_ref: str,
    prompt_evidence_ref: str | None = None,
    prompt_improved: bool | None = None,
    usage: BudgetUsage | None = None,
    budget: BudgetSpec | None = None,
) -> SynthesizedSelection:
    """Derive the envelope a legacy-shaped assessment implies, LOSSLESSLY:
    the original `Evaluation` and `Decision` bytes become the CAS artifacts
    of the task bundle's results (their refs are preserved, never
    rewritten). The constraint bundle records the structural invariant that
    a candidate reaching evaluation passed the kernel screen; budget usage
    is carried when known. A prompt bundle is synthesized ONLY from real
    recorded `SurfaceEvidence` — never invented."""
    objects = getattr(store, "objects")
    evaluation: Evaluation = codec.loads(
        objects.get_text(evaluation_ref), Evaluation
    )
    decision: Decision = codec.loads(objects.get_text(decision_ref), Decision)
    effective_budget = budget if budget is not None else BudgetSpec()

    candidate_suite = validators.task_suite_result(
        store, evaluation, subject_role="candidate"
    )
    # preserve the ORIGINAL evaluation ref as the artifact (byte-identical)
    candidate_suite = ValidatorResult(
        validator=candidate_suite.validator,
        subject_role=candidate_suite.subject_role,
        status=candidate_suite.status,
        metrics=candidate_suite.metrics,
        detail=candidate_suite.detail,
        artifact_ref=evaluation_ref,
    )
    comparison = validators.paired_comparison_result(store, decision)
    comparison = ValidatorResult(
        validator=comparison.validator,
        subject_role=comparison.subject_role,
        status=comparison.status,
        metrics=comparison.metrics,
        detail=comparison.detail,
        artifact_ref=decision_ref,
    )
    _tm, task_manifest_ref = build_evaluation_manifest(
        store,
        task,
        resolved_manifest_ref="",
        validator_refs=(validators.TASK_SUITE.ref, validators.PAIRED_COMPARISON.ref),
        budget=effective_budget,
    )
    task_bundle = ValidationBundle(
        role=ROLE_TASK,
        evaluation_manifest_ref=task_manifest_ref,
        subject=_subject_ref(store, revision_id),
        results=(candidate_suite, comparison),
        feedback=evaluation.feedback,
        at=now_iso(),
    )
    task_bundle_ref = _store_bundle(store, task_bundle)

    _cb, constraint_bundle_ref = build_constraint_bundle(
        store,
        task,
        subject_revision_id=revision_id,
        resolved_manifest_ref="",
        screen_rejection_kind=None,
        screen_detail=(
            "structural invariant: a candidate that reached evaluation passed "
            "the kernel source screen (synthesized from legacy records)"
        ),
        usage=usage if usage is not None else BudgetUsage(),
        budget=effective_budget,
    )

    prompt_bundle_ref: str | None = None
    evidence = [
        DecisionEvidence(role=ROLE_TASK, bundle_ref=task_bundle_ref),
        DecisionEvidence(role=ROLE_CONSTRAINT, bundle_ref=constraint_bundle_ref),
    ]
    if prompt_evidence_ref is not None and prompt_improved is not None:
        _pb, prompt_bundle_ref = build_prompt_bundle(
            store,
            task,
            subject_revision_id=revision_id,
            resolved_manifest_ref="",
            prompt_evidence_ref=prompt_evidence_ref,
            improved=prompt_improved,
            detail="synthesized from recorded surface evidence",
            budget=effective_budget,
        )
        evidence.append(
            DecisionEvidence(role=ROLE_PROMPT, bundle_ref=prompt_bundle_ref)
        )

    _sd, selection_ref = build_selection_decision(
        store,
        policy_ref=policy_ref if "@" in policy_ref else f"{policy_ref}@0",
        disposition=(
            DISPOSITION_PROMOTE if decision.accepted else DISPOSITION_REJECT
        ),
        subject_revision_id=revision_id,
        incumbent_revision_id=baseline_revision_id,
        evidence=tuple(evidence),
        rationale=decision.reason,
    )
    return SynthesizedSelection(
        selection_ref=selection_ref,
        task_bundle_ref=task_bundle_ref,
        constraint_bundle_ref=constraint_bundle_ref,
        prompt_bundle_ref=prompt_bundle_ref,
    )


__all__ = [
    "STRIVE_TOOL_VERSION",
    "ExecutionProvenance",
    "RecordedAssessment",
    "SynthesizedSelection",
    "build_constraint_bundle",
    "build_evaluation_manifest",
    "build_prompt_bundle",
    "build_selection_decision",
    "build_task_bundle",
    "pin_execution_provenance",
    "record_assessment",
    "synthesize_evaluation_bundle",
    "synthesize_selection",
]
