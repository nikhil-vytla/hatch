"""The evolution loop orchestrator (trusted kernel).

One cycle walks the loop end to end:

    execute -> observe -> evaluate -> diagnose -> propose -> validate
            -> accept/reject -> retain

Kernel invariants enforced here:
- evolvable code runs only in the sandbox, never in this process;
- diagnosis and proposal receive visible-split evidence only; proposal
  history is sanitized to aggregate outcomes (no case contents or ids from
  hidden splits);
- model calls go through the metered journaling adapter (budgets, latency,
  content-addressed prompt/completion artifacts);
- proposals are validated strictly and rejections journaled by kind; a
  proposal parented on a superseded generation is rejected as stale;
- every execution is charged to the trusted budget meter and attributed to
  the generation that served it;
- every failure is recorded data, never a controller exception;
- every candidate — accepted or rejected — is retained with lineage;
- a stall freeze (trusted monitor) halts adaptation but not evaluation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from strive import codec
from strive.budget import BudgetMeter
from strive.contracts import (
    ACTIVATION_DURABLE,
    ACTIVATION_PROVISIONAL,
    VISIBLE,
    Activation,
    BudgetSpec,
    BudgetUsage,
    Candidate,
    CycleRecord,
    Decision,
    Diagnosis,
    Evaluation,
    ExecutionReport,
    FAILURE_PROPOSAL_STALE,
    FailureRecord,
    Intervention,
    INTERVENTION_DRIFT_ACKNOWLEDGED,
    INTERVENTION_EXPIRY_REVERT,
    INTERVENTION_STALL_FREEZE,
    Generation,
    ProposalRecord,
)
from strive.diagnose import Diagnoser, SignatureDiagnoser, VisibleContext
from strive.evaluate import evaluate
from strive.events import EventLog, now_iso
from strive.model import MeteredJournalingAdapter, ModelAdapter
from strive.monitors import StallDetector
from strive.policy import PROVISIONAL_POLICY, AcceptancePolicy, get_policy
from strive.propose import (
    ProposalHistoryItem,
    ProposalRequest,
    Proposer,
    RegistryProposer,
    STRATEGY_CODE_SURFACE,
    screen_surface_update,
    screen_source,
)
from strive import lifecycle
from strive.promptgate import PromptComparisonEvidence
from strive.selection import ExecutionProvenance, RecordedAssessment
from strive.reader import MODE_CANARY, CandidateSubject, StateReader
from strive.revisions import HarnessRevision
from strive.sandbox import run_strategy
from strive.store import (
    LedgerEntry,
    Store,
    StoreError,
    derive_activation_before,
    derive_active_activation,
    derive_active_generation,
    derive_adaptation_frozen,
    derive_cycles,
    derive_cycles_since_activation,
    derive_generations,
)
from strive.tasks import Task


@dataclass
class LoopConfig:
    sandbox_timeout_s: float = 10.0
    budget: BudgetSpec = field(default_factory=BudgetSpec)
    policy_name: str = "paired-deterministic"
    diagnoser: Diagnoser = field(default_factory=SignatureDiagnoser)
    proposer: Proposer = field(default_factory=RegistryProposer)
    model_adapter: ModelAdapter | None = None
    model_max_tokens: int = 2048
    stall_window: int = 3
    history_limit: int = 5
    acknowledge_task_drift: bool = False
    # set when the proposer runs REAL model-generated code. With a secure
    # sandbox backend (below) the code is mechanically contained, so lifecycle
    # authority is GRANTED; without one, authority is refused (threat model)
    unsafe_model_code: bool = False
    # the sandbox boundary candidate code executes under. The default is the
    # honest fault-containment subprocess (fixtures/trusted code); set to a
    # secure backend (e.g. "deno-pyodide@1") to contain untrusted model code.
    sandbox_backend: str = "process-fault-only@1"


@dataclass(frozen=True)
class CycleReport:
    run_id: str
    generation_before: str
    evaluation: Evaluation
    frozen: bool
    diagnosis: Diagnosis | None
    proposal: ProposalRecord | None
    proposal_failure: FailureRecord | None
    candidate: Candidate | None
    candidate_evaluation: Evaluation | None
    decision: Decision | None
    generation_after: str


def _new_run_id(prefix: str = "run") -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{prefix}-{stamp}-{uuid.uuid4().hex[:6]}"


def guard_task_binding(
    store: Store,
    task: Task,
    *,
    mutating: bool,
    acknowledge_drift: bool = False,
    entries: "list[LedgerEntry] | None" = None,
) -> bool:
    """The one shared task-binding guard, called by every public operation.

    Verifies the store is bound to this task, and detects task-SPEC drift:
    once the store carries a `TaskSpecBound` record, drift means the task's
    SPEC identity changed (signature, catalog, description, version,
    scorer, environment) — the cases are dataset state, so DATASET GROWTH
    NEVER TRIPS THIS GUARD; it invalidates evidence instead and forces
    incumbent re-baselining through the activation gate. A store without a
    spec binding (pre-3C.2A.1 history) keeps the legacy case-inclusive
    comparison until its first clean convergence or acknowledged drift
    binds the spec. Drift blocks *mutating* operations unless explicitly
    acknowledged; read-only operations proceed. Returns True when
    acknowledged drift was present, so callers can journal it.
    """
    from strive.evidence import task_spec_fingerprint

    if store.task_id != task.task_id:
        raise StoreError(
            f"store is bound to task {store.task_id!r}, got {task.task_id!r}"
        )
    active = derive_active_generation(entries if entries is not None else store.entries())
    if active is None:
        return False
    bound = lifecycle.state(store).task_spec
    if bound is not None:
        spec_now = task_spec_fingerprint(task)
        if bound.spec_fingerprint == spec_now:
            return False  # dataset growth is NOT drift
        if mutating and not acknowledge_drift:
            raise StoreError(
                f"task-SPEC drift: the store is bound to spec fingerprint "
                f"{bound.spec_fingerprint[:12]}… but the current definition "
                f"of {task.task_id!r} has spec fingerprint {spec_now[:12]}… "
                "(the task's signature, catalog, version, scorer, or "
                "description changed — NOT its cases; dataset growth never "
                "requires this). Refusing to mutate. Re-run with "
                "--acknowledge-task-drift to re-bind (journaled), or restore "
                "the original task definition."
            )
        return mutating and acknowledge_drift
    # legacy (unbound) store: the pre-3C.2A.1 case-inclusive comparison
    if active.task_fingerprint == task.fingerprint():
        return False
    if mutating and not acknowledge_drift:
        raise StoreError(
            f"task-fingerprint drift: the active generation was created for "
            f"fingerprint {active.task_fingerprint[:12]}… but the current "
            f"definition of {task.task_id!r} fingerprints as "
            f"{task.fingerprint()[:12]}… (the task's cases or version changed "
            "and this store predates spec binding). Refusing to mutate. "
            "Re-run with --acknowledge-task-drift to proceed against the new "
            "definition (journaled), or restore the original task definition."
        )
    return mutating and acknowledge_drift


def guard_mutation(
    store: Store,
    task: Task,
    acknowledge_drift: bool,
    entries: "list[LedgerEntry] | None" = None,
) -> None:
    """The single entry point for mutating operations: task-binding + drift
    validation, plus durable journaling of a drift acknowledgement whenever —
    and only whenever — drift actually exists and was acknowledged. New
    mutating operations must call this, so the journaling cannot be forgotten.
    """
    drift_acknowledged = guard_task_binding(
        store, task, mutating=True, acknowledge_drift=acknowledge_drift,
        entries=entries,
    )
    if drift_acknowledged:
        store.append(
            Intervention(
                kind=INTERVENTION_DRIFT_ACKNOWLEDGED,
                reason=(
                    f"operator acknowledged task-fingerprint drift; proceeding "
                    f"against current fingerprint {task.fingerprint()[:12]}…"
                ),
                at=now_iso(),
            )
        )
        # the acknowledgement re-binds the store to the new SPEC identity
        try:
            lifecycle.bind_task_spec(store, task)
        except lifecycle.LifecycleError as exc:
            store._note_diagnostic(f"spec re-bind failed: {exc}")


def ensure_seeded(store: Store, task: Task) -> Generation:
    reader = StateReader(store, "seed")
    try:
        guard_task_binding(
            store, task, mutating=False, entries=reader.ledger_entries()
        )
        active = reader.read_active("seed-active")
        if active is None:
            record = store.add_generation(
                task.seed_source,
                task_fingerprint=task.fingerprint(),
                parent_id=None,
                origin="seed",
                surface=STRATEGY_CODE_SURFACE,
                weakness_id=None,
                decision=None,
            )
            reader.refresh()  # our own write; the activation carries its head
            store.activate(
                record.generation_id,
                reason="seed",
                policy="seed",
                expected_head=reader.canonical_head,
            )
            reader.refresh()
            active = record
        _converge_lifecycle(store, task)  # reconcile crash points + sync identities
        return active
    finally:
        reader.finish(None)


def _converge_lifecycle(store: Store, task: Task) -> None:
    """Reconcile unfinished activation operations and converge the lifecycle
    with generation-native history (backfilling identities and replaying the
    activation tail — never seeding only the root when the actual active
    state is later), then converge the evidence side: the current dataset
    revision is persisted and pre-envelope assessments gain their
    synthetic-but-lossless envelopes (migration 0005's ongoing form).
    Failures are loud diagnostics here so a wedged lifecycle never blocks
    generation-native reads; the divergence stays visible via
    `lifecycle.compat_parity`, and lifecycle MUTATIONS still fail closed."""
    from strive.datasets import ensure_dataset_revision

    try:
        lifecycle.reconcile(store)
        if lifecycle.sync_needed(store):
            lifecycle.sync_from_generations(store)
        _pin_default_prompt(store)
        ensure_dataset_revision(store, task)
        if lifecycle.evidence_links_needed(store):
            lifecycle.ensure_evidence_links(store, task)
        # bind the SPEC identity once — but never across unacknowledged
        # legacy drift: an unbound store whose active generation was
        # created under a DIFFERENT case-inclusive fingerprint keeps the
        # legacy guard until the operator acknowledges
        st = lifecycle.state(store)
        active_generation = store.active_generation()
        if st.task_spec is None and (
            active_generation is None
            or active_generation.task_fingerprint == task.fingerprint()
        ):
            lifecycle.bind_task_spec(store, task)
    except lifecycle.LifecycleError as exc:
        store._note_diagnostic(f"lifecycle convergence failed: {exc}")


def _pin_default_prompt(store: Store) -> None:
    """Pin the build's default proposal template INTO lifecycle state, once:
    a prompt-only composite child of the current active revision, installed
    through the recoverable activation op with a journaled structural
    override. Historical revisions then resolve their prompt from CAS —
    never from the current build's default string — and rollback restores
    the pinned historical text."""
    from strive.model_proposer import DEFAULT_PROPOSAL_TEMPLATE

    st = lifecycle.state(store)
    if st.breaker_open or st.journal_errors or st.open_intents:
        return
    if "rev-prompt-default" in st.retained:
        return  # pinned once; rollback below the pin is explicit legacy state
    active = st.active_revision_id
    if active is None:
        return
    resolved = lifecycle.materialize_active(store)
    if resolved is None:
        return
    if any(b.kind == "prompt" for b in resolved.effective):
        return  # a prompt is already bound (nothing legacy to pin)
    active_generation = store.active_generation()
    if active_generation is None:
        return
    revision, _ref = lifecycle.compose_revision(
        store,
        revision_id="rev-prompt-default",
        base_parent_id=active,
        parent_manifest_bindings=resolved.effective,
        surfaces={("prompt", "proposal-template"): DEFAULT_PROPOSAL_TEMPLATE},
        proposer="default-prompt-pin@1",
        summary="pin the built-in proposal template into lifecycle state",
        task_fingerprint=active_generation.task_fingerprint,
        origin="default-prompt-pin",
    )
    lifecycle.retain(
        store,
        revision,
        task_fingerprint=active_generation.task_fingerprint,
        generation_id=active_generation.generation_id,
    )
    lifecycle.run_activation_op(
        store,
        "rev-prompt-default",
        reason="promote",
        policy_ref="default-prompt-pin@1",
        override_reason=(
            "structural: pin the default proposal template into lifecycle "
            "state (no behavioral change; the served strategy is unchanged)"
        ),
    )


def _backend_is_secure(backend_name: str) -> bool:
    """True iff the named sandbox backend is available AND mechanically
    enforces every secure-execution capability — the floor for granting
    lifecycle authority to model-generated (untrusted) code. Fail-closed: an
    unavailable or unknown backend is not secure."""
    if backend_name == "process-fault-only@1":
        return False
    import strive.sandbox_backends  # noqa: F401 — register backends
    from strive.sandboxes import SandboxError, get_backend

    try:
        backend = get_backend(backend_name)
    except SandboxError:
        return False
    return backend.capabilities().secure


def _provenance_from_execution_record(
    store: Store,
    execution_record_ref: str,
    revision_id: str,
    run_id: str,
    sandbox_provenance_ref: str = "",
) -> "ExecutionProvenance":
    """The evidence provenance from the reader's pinned ExecutionRecord plus
    the sandbox provenance naming the boundary that executed the candidate;
    when the record is unavailable or carries no resolved baseline, pin
    fresh truthful provenance for the retained subject."""
    from strive import selection as selection_mod
    from strive.reader import ExecutionRecord

    if execution_record_ref:
        try:
            execution_record: ExecutionRecord = codec.loads(
                store.objects.get_text(execution_record_ref), ExecutionRecord
            )
            if execution_record.base_resolved_ref is not None:
                return selection_mod.ExecutionProvenance(
                    resolved_manifest_ref=execution_record.base_resolved_ref,
                    execution_record_ref=execution_record_ref,
                    sandbox_provenance_ref=sandbox_provenance_ref,
                )
        except Exception:  # noqa: BLE001 — fall through to fresh provenance
            pass
    return selection_mod.pin_execution_provenance(
        store, subject_revision_id=revision_id, operation="cycle", run_id=run_id,
        sandbox_provenance_ref=sandbox_provenance_ref,
    )


def _record_candidate_evidence(
    store: Store,
    task: Task,
    overlay: CandidateSubject,
    baseline_revision_id: str | None,
    candidate_generation_id: str,
    baseline_evaluation: Evaluation,
    candidate_evaluation: Evaluation,
    decision: Decision,
    policy_ref: str,
    run_id: str,
    events: EventLog,
    *,
    execution_record_ref: str,
    usage: BudgetUsage,
    budget: BudgetSpec,
    prompt_evidence_ref: str | None = None,
    prompt_improved: bool | None = None,
    sandbox_provenance_ref: str = "",
) -> "RecordedAssessment":
    """Persist the evaluated candidate's IDENTITY and EVIDENCE into the
    lifecycle BEFORE any served behavior changes: retain the exact evaluated
    revision (accepted or rejected), link its compatibility generation, and
    record the assessment with modern promote-grade envelopes — separate
    task/constraint(/prompt) bundles pinned to the exact execution
    provenance (the reader's ExecutionRecord, the resolved harness it ran
    under, and the sandbox boundary that executed it). Raises on failure —
    retention or evidence problems must surface before activation, not
    after."""
    from strive import selection as selection_mod

    revision: HarnessRevision = codec.loads(
        store.objects.get_text(overlay.revision_ref), HarnessRevision
    )
    revision_id = revision.ref.revision_id
    lifecycle.retain(
        store,
        revision,
        task_fingerprint=_provenance_fingerprint(store, revision),
        generation_id=candidate_generation_id,
    )
    provenance = _provenance_from_execution_record(
        store, execution_record_ref, revision_id, run_id, sandbox_provenance_ref
    )
    recorded = selection_mod.record_assessment(
        store,
        task,
        revision_id=revision_id,
        baseline_revision_id=baseline_revision_id,
        baseline_evaluation=baseline_evaluation,
        candidate_evaluation=candidate_evaluation,
        decision=decision,
        policy_ref=policy_ref,
        scope_manifest_ref=overlay.manifest_ref,
        provenance=provenance,
        usage=usage,
        budget=budget,
        prompt_evidence_ref=prompt_evidence_ref,
        prompt_improved=prompt_improved,
        run_id=run_id,
    )
    events.emit(
        "lifecycle_retained",
        revision_id=revision_id,
        accepted=decision.accepted,
        baseline_revision_id=baseline_revision_id,
        selection_ref=recorded.selection_ref,
    )
    return recorded


def _build_composite_overlay(
    store: Store,
    candidate: Candidate,
    proposal: ProposalRecord,
    lifecycle_baseline: str | None,
    proposer_ref: str,
    task: Task,
) -> CandidateSubject | None:
    """Build the ONE immutable candidate revision containing every proposed
    delta — strategy-code always, prompt/proposal-template when the proposal
    carries a prompt_update — BEFORE evaluation, against the lifecycle's
    active manifest (unchanged bindings carry over). The exact evaluated
    revision is what gets retained, selected, and activated; there is no
    post-evaluation reconstruction. None on failure (the caller refuses
    promotion of identity-less candidates)."""
    try:
        if lifecycle_baseline is None:
            return None
        resolved = lifecycle.materialize_active(store)
        if resolved is None:
            return None
        surfaces: dict[tuple[str, str], str] = {
            ("strategy-code", "solve"): proposal.source,
        }
        from strive.revisions import DESCRIPTOR_REGISTRY

        for update in proposal.surface_updates:
            kind = DESCRIPTOR_REGISTRY[update.descriptor_ref].kind
            surfaces[(kind, update.name)] = update.content
        revision, revision_ref = lifecycle.compose_revision(
            store,
            revision_id=f"rev-{candidate.candidate_id}",
            base_parent_id=lifecycle_baseline,
            parent_manifest_bindings=resolved.effective,
            surfaces=surfaces,
            proposer=proposer_ref,
            summary=proposal.summary,
            task_fingerprint=task.fingerprint(),
            weakness_id=candidate.weakness_id,
            origin="candidate-overlay",
        )
        return CandidateSubject(
            revision_ref=revision_ref,
            manifest_ref=revision.scope_manifest_ref,
            provenance_ref=revision.provenance_ref or "",
            source_ref=candidate.source_ref,
        )
    except Exception:  # noqa: BLE001 — construction failure = refusal path
        return None


def _prompt_surface_gate(
    store: Store,
    task: Task,
    proposal: ProposalRecord,
    request: ProposalRequest,
    task_decision: Decision,
    config: LoopConfig,
    events: EventLog,
) -> "tuple[PromptComparisonEvidence | None, str | None, Decision]":
    """The trusted prompt validator over a composite's prompt delta: matched
    proposer trials under candidate vs incumbent templates (same adapter,
    context, budgets, metered handle). Returns (evidence, evidence_ref,
    composite_decision). When no evidence can be produced (no adapter), the
    composite is not promotable — the prompt cannot piggyback."""
    from strive import promptgate

    update = proposal.surface_updates[0]
    if request.model is None:
        composite = Decision(
            accepted=False,
            reason=(
                "composite carries a prompt delta but no adapter is available "
                "to produce prompt-specific evidence; a prompt must not "
                "piggyback on code evidence"
            ),
            policy="prompt-comparison",
            policy_version=1,
            baseline_score=task_decision.baseline_score,
            candidate_score=task_decision.candidate_score,
            baseline_split_scores=dict(task_decision.baseline_split_scores),
            candidate_split_scores=dict(task_decision.candidate_split_scores),
            regressed_case_ids=task_decision.regressed_case_ids,
        )
        return None, None, composite
    evidence, evidence_ref = promptgate.compare_templates(
        store,
        task,
        incumbent_template=request.prompt_template,
        candidate_template=update.content,
        request=request,
        model=request.model,
        adapter_name=(
            type(config.model_adapter).__name__ if config.model_adapter else "none"
        ),
    )
    events.emit(
        "prompt_comparison",
        evidence_ref=evidence_ref,
        improved=evidence.improved,
        detail=evidence.detail,
    )
    return evidence, evidence_ref, promptgate.prompt_gate_decision(
        task_decision, evidence
    )


def _activate_code_only_sibling(
    store: Store,
    task: Task,
    candidate: Candidate,
    proposal: ProposalRecord,
    lifecycle_baseline: str | None,
    candidate_generation: Generation,
    baseline_evaluation: Evaluation,
    candidate_evaluation: Evaluation,
    task_decision: Decision,
    policy_ref: str,
    proposer_ref: str,
    run_id: str,
    *,
    usage: BudgetUsage,
    budget: BudgetSpec,
    gen_expected_active: str | None,
    gen_expected_head: str | None,
) -> str:
    """When the code passes the task gate but the bundled prompt delta earns
    no surface-specific benefit: retain and activate the code-only sibling
    revision. Its sole delta IS the artifact the sandbox executed, so the
    task evidence applies to it exactly; the composite stays retained as
    rejected evidence."""
    assert lifecycle_baseline is not None
    resolved = lifecycle.materialize_active(store)
    assert resolved is not None
    sibling, _ref = lifecycle.compose_revision(
        store,
        revision_id=f"rev-{candidate.candidate_id}-code",
        base_parent_id=lifecycle_baseline,
        parent_manifest_bindings=resolved.effective,
        surfaces={("strategy-code", "solve"): proposal.source},
        proposer=proposer_ref,
        summary=f"code-only sibling of rev-{candidate.candidate_id} "
        "(prompt delta earned no surface-specific evidence)",
        task_fingerprint=task.fingerprint(),
        weakness_id=candidate.weakness_id,
        origin="candidate-overlay",
    )
    from strive import selection as selection_mod

    lifecycle.retain(
        store,
        sibling,
        task_fingerprint=task.fingerprint(),
        generation_id=candidate_generation.generation_id,
    )
    # the sibling's own envelopes: its sole delta IS the executed artifact,
    # so the task evidence applies to it exactly; no prompt role is required
    # (or permitted) — the composite keeps the rejected prompt evidence.
    # Provenance is pinned fresh for the retained sibling (the sandbox ran
    # the identical strategy artifact as the composite overlay).
    provenance = selection_mod.pin_execution_provenance(
        store,
        subject_revision_id=sibling.ref.revision_id,
        operation="cycle",
        run_id=run_id,
        detail=(
            "code-only sibling of the executed composite overlay "
            "(identical strategy artifact)"
        ),
    )
    recorded = selection_mod.record_assessment(
        store,
        task,
        revision_id=sibling.ref.revision_id,
        baseline_revision_id=lifecycle_baseline,
        baseline_evaluation=baseline_evaluation,
        candidate_evaluation=candidate_evaluation,
        decision=task_decision,
        policy_ref=policy_ref,
        scope_manifest_ref=sibling.scope_manifest_ref,
        provenance=provenance,
        usage=usage,
        budget=budget,
        run_id=run_id,
    )
    lifecycle.run_activation_op(
        store,
        sibling.ref.revision_id,
        reason="evolved",
        policy_ref=policy_ref,
        decision_ref=recorded.selection_ref,
        gen_expected_active=gen_expected_active,
        gen_expected_head=gen_expected_head,
    )
    return sibling.ref.revision_id


def _provenance_fingerprint(store: Store, revision: "HarnessRevision") -> str:
    """Read the task fingerprint the revision's provenance recorded, so the
    lifecycle retention carries the same fingerprint as the artifact."""
    from strive.revisions import RevisionProvenance

    if revision.provenance_ref is None:
        return ""
    provenance = codec.loads(
        store.objects.get_text(revision.provenance_ref), RevisionProvenance
    )
    return provenance.task_fingerprint


def _execute_and_evaluate(
    store: Store,
    task: Task,
    generation: Generation,
    meter: BudgetMeter,
    config: LoopConfig,
    events: EventLog,
    reader: StateReader,
    subject: str,
    overlay: CandidateSubject | None = None,
    execution_record: dict[str, str] | None = None,
) -> Evaluation:
    """Charge, execute, attribute, and evaluate one generation. Never raises
    for candidate behavior: failures come back inside the Evaluation.

    Execution provenance is pinned BEFORE the artifact runs: the reader
    CAS-stores a per-subject ExecutionRecord naming the base resolved
    harness and the evaluated subject (active revision, retained revision,
    or candidate overlay) with exact heads (never blocking). The executed
    source comes through the read boundary — in canary mode it is the
    revision-materialized artifact, compared with the native value first.
    When the caller passes ``execution_record``, the CAS ref of that
    run-resolved record is returned in it (the evidence envelope's
    `resolved_manifest_ref`)."""
    record_ref = reader.record_execution(subject, generation, events, overlay=overlay)
    if execution_record is not None and record_ref is not None:
        execution_record["ref"] = record_ref
    denial = meter.request_execution()
    if denial is not None:
        events.emit(
            "execution_denied",
            generation_id=generation.generation_id,
            failure=codec.encode(denial),
        )
        return evaluate(
            task,
            ExecutionReport(
                ok=False, generation_id=generation.generation_id, failure=denial
            ),
        )

    # routine execution covers the selection cases only; the audit split is
    # excluded from every routine flow (see audit_generation)
    cases = task.selection_cases()
    source = reader.source_for_execution(subject, generation, overlay)
    if config.sandbox_backend == "process-fault-only@1":
        report = run_strategy(
            source,
            cases,
            generation_id=generation.generation_id,
            timeout_s=meter.execution_timeout_s(config.sandbox_timeout_s),
            output_bytes_cap=meter.execution_output_cap(),
        )
    else:
        # a chosen (secure) backend: EACH case in a fresh sandbox, candidate
        # sees only input_text; the boundary's provenance is captured for the
        # evidence and never silently downgraded (get_backend fails closed)
        import strive.sandbox_backends  # noqa: F401 — register backends
        from strive.sandboxes import SandboxLimits, get_backend, run_protected_suite

        backend = get_backend(config.sandbox_backend)
        outcomes, sandbox_provenance, denials = run_protected_suite(
            backend,
            source,
            cases,
            generation_id=generation.generation_id,
            limits=SandboxLimits(
                wall_time_s=meter.execution_timeout_s(config.sandbox_timeout_s),
                output_bytes=meter.execution_output_cap(),
            ),
        )
        report = ExecutionReport(
            ok=True,
            generation_id=generation.generation_id,
            outcomes=tuple(outcomes.values()),
            failure=None,
            wall_time_s=0.0,
            stdout_bytes=0,
        )
        if execution_record is not None:
            execution_record["sandbox_provenance_ref"] = store.objects.put_text(
                codec.dumps(sandbox_provenance)
            )
        for note in denials:
            events.emit("sandbox_denial", generation_id=generation.generation_id,
                        detail=note)
    meter.note_output_bytes(report.stdout_bytes)
    for outcome in report.outcomes:
        events.emit(
            "case_executed",
            generation_id=generation.generation_id,
            outcome=codec.encode(outcome),
        )
    if not report.ok and report.failure is not None:
        events.emit(
            "execution_failed",
            generation_id=generation.generation_id,
            failure=codec.encode(report.failure),
        )
    evaluation = evaluate(task, report, cases)
    events.emit(
        "evaluated",
        generation_id=generation.generation_id,
        evaluation=codec.encode(evaluation),
    )
    return evaluation


def _proposal_history(reader: StateReader, limit: int) -> tuple[ProposalHistoryItem, ...]:
    """Sanitized accepted/rejected history: visible-split scores and policy
    identity only. Decision *reasons* are excluded (they may cite hidden-split
    case ids) and so are overall/hidden-split scores (they are influenced by
    hidden evaluation data and must not flow back to proposers)."""
    items: list[ProposalHistoryItem] = []
    for generation in derive_generations(reader.ledger_entries()).values():
        decision = generation.decision
        if decision is None:
            continue
        verdict = "accepted" if decision.accepted else "rejected"
        baseline_visible = decision.baseline_split_scores.get(VISIBLE, 0.0)
        candidate_visible = decision.candidate_split_scores.get(VISIBLE, 0.0)
        items.append(
            ProposalHistoryItem(
                generation_id=generation.generation_id,
                weakness_id=generation.weakness_id,
                description=f"candidate for weakness {generation.weakness_id or 'n/a'}",
                accepted=decision.accepted,
                outcome=(
                    f"{verdict} by {decision.policy}@{decision.policy_version}: "
                    f"visible {baseline_visible:.3f} -> {candidate_visible:.3f}"
                ),
            )
        )
    return tuple(items[-limit:])


def _resolve_provisional(store: Store, reader: StateReader, events: EventLog) -> None:
    """Expire or confirm a provisional activation whose window has elapsed.
    Reads come from the operation's coherent snapshot; the reader refreshes
    after any activation this writes."""
    entries = reader.ledger_entries()
    activation = derive_active_activation(entries)
    if activation is None or activation.mode != ACTIVATION_PROVISIONAL:
        return
    window = derive_cycles_since_activation(entries, activation)
    assert activation.expires_after_cycles is not None
    if len(window) < activation.expires_after_cycles:
        return
    scores = [c.overall_score for c in window]
    baseline = activation.baseline_score if activation.baseline_score is not None else 0.0
    if PROVISIONAL_POLICY.confirm(scores, baseline):
        store.activate(
            activation.generation_id,
            reason="confirmed",
            policy=f"{PROVISIONAL_POLICY.name}@{PROVISIONAL_POLICY.version}",
            expected_head=reader.canonical_head,
        )
        reader.refresh()
        events.emit(
            "provisional_confirmed",
            generation_id=activation.generation_id,
            window_scores=list(scores),
            baseline_score=baseline,
        )
        return
    previous = derive_activation_before(entries, activation)
    if previous is None:
        raise StoreError(
            f"provisional activation of {activation.generation_id} has no "
            "predecessor to revert to"
        )
    store.append(
        Intervention(
            kind=INTERVENTION_EXPIRY_REVERT,
            reason=(
                f"provisional {activation.generation_id} expired unconfirmed: "
                f"window {scores} vs baseline {baseline:.3f}"
            ),
            at=now_iso(),
        )
    )
    reader.refresh()  # our own write; the revert activation carries its head
    store.activate(
        previous.generation_id,
        reason="expired-reverted",
        policy=f"{PROVISIONAL_POLICY.name}@{PROVISIONAL_POLICY.version}",
        expected_head=reader.canonical_head,
    )
    reader.refresh()
    events.emit(
        "provisional_reverted",
        from_generation=activation.generation_id,
        to_generation=previous.generation_id,
        window_scores=list(scores),
        baseline_score=baseline,
    )


def resolve_active_prompt(store: Store) -> tuple[str, str, str | None, str]:
    """The ACTIVE prompt/proposal-template surface, resolved from the native
    lifecycle's manifest — no static-template assumption. Returns
    (template_text, prompt_ref, active_revision_id, source) where source is
    "revision" (manifest-bound; the normal case once the default is pinned
    into lifecycle state) or "legacy-default" (explicitly unmigrated
    pre-prompt history ONLY). Corruption, a missing artifact, or an invalid
    template is a structured failure — never a silent fallback."""
    from strive.cas import ObjectCorruption, ObjectMissing
    from strive.model_proposer import DEFAULT_PROPOSAL_TEMPLATE, validate_prompt_template

    resolved = lifecycle.materialize_active(store)  # LifecycleError propagates
    if resolved is not None:
        binding = next(
            (
                b
                for b in resolved.effective
                if (b.kind, b.name) == ("prompt", "proposal-template")
            ),
            None,
        )
        if binding is not None and binding.binding.content_ref is not None:
            try:
                text = store.objects.get_text(binding.binding.content_ref)
            except (ObjectMissing, ObjectCorruption) as exc:
                raise StoreError(
                    f"active prompt artifact unavailable: {exc}"
                ) from None
            rejection = validate_prompt_template(text)
            if rejection is not None:
                raise StoreError(
                    f"active prompt template is invalid: {rejection}"
                )
            return (
                text,
                binding.binding.content_ref,
                resolved.contributions[0].revision.revision_id,
                "revision",
            )
    # explicitly unmigrated legacy state: no revision in this lifecycle has
    # ever bound a prompt (pre-prompt history). The pin step in seeding
    # normally removes this case on the next operation.
    default_ref = store.objects.put_text(DEFAULT_PROPOSAL_TEMPLATE)
    active = lifecycle.active_revision_id(store)
    return DEFAULT_PROPOSAL_TEMPLATE, default_ref, active, "legacy-default"


def _proposal_stage(
    store: Store,
    task: Task,
    ctx: VisibleContext,
    diagnosis: Diagnosis,
    meter: BudgetMeter,
    config: LoopConfig,
    events: EventLog,
    reader: StateReader,
) -> tuple[ProposalRecord | None, FailureRecord | None, ProposalRequest]:
    """Run the proposer, then kernel-side checks: staleness (generation id,
    active prompt, lifecycle head), the forbidden-source screen, and the
    generic surface-update screen. Every rejection is journaled with its
    distinct kind. The request (with its pinned state and metered model
    handle) is returned so the composite prompt gate can run matched trials
    under the SAME conditions and budgets."""
    model_handle = None
    if config.model_adapter is not None:
        model_handle = MeteredJournalingAdapter(
            config.model_adapter, meter, events, store.objects
        )
    # the active prompt surface + the pinned lifecycle state, journaled for
    # EVERY model request and carried in the request for staleness checks
    prompt_template, prompt_ref, prompt_revision, prompt_source = (
        resolve_active_prompt(store)
    )
    from strive.revisions import current_descriptor

    lifecycle_head = lifecycle.state(store).head
    events.emit(
        "prompt_resolved",
        prompt_ref=prompt_ref,
        prompt_source=prompt_source,
        active_revision=prompt_revision,
        lifecycle_head=lifecycle_head,
    )
    usage = meter.usage()
    request = ProposalRequest(
        ctx=ctx,
        diagnosis=diagnosis,
        task_description=task.description,
        task_signature=task.signature,
        primitive_catalog=task.primitive_catalog,
        history=_proposal_history(reader, config.history_limit),
        max_output_tokens=config.model_max_tokens,
        model_calls_remaining=max(0, config.budget.model_calls - usage.model_calls - 1),
        executions_remaining=max(0, config.budget.executions - usage.executions),
        model=model_handle,
        prompt_template=prompt_template,
        prompt_ref=prompt_ref,
        prompt_descriptor_ref=current_descriptor("prompt").descriptor_ref,
        parent_revision_id=prompt_revision,
        lifecycle_head=lifecycle_head,
    )
    result = config.proposer.propose(request)

    if result.failure is not None:
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(result.failure),
        )
        return None, result.failure, request
    assert result.proposal is not None
    proposal = result.proposal

    # staleness: re-read the incumbent through the read boundary's explicit
    # staleness re-read; a slow proposal must not apply to a generation that
    # is no longer active — and the PROMPT/LIFECYCLE state pinned in the
    # request must be unchanged too, even when the generation id is not
    current = reader.recheck_active_for_staleness()
    current_id = current.generation_id if current is not None else "(none)"
    stale_detail: str | None = None
    if current_id != proposal.parent_generation_id:
        stale_detail = (
            f"proposal parented on {proposal.parent_generation_id} but the "
            f"active generation is now {current_id}"
        )
    else:
        _t, prompt_ref_now, _rev, _src = resolve_active_prompt(store)
        head_now = lifecycle.state(store).head
        if prompt_ref_now != request.prompt_ref:
            stale_detail = (
                "the active prompt changed during the model call "
                f"({request.prompt_ref[:12]}… -> {prompt_ref_now[:12]}…)"
            )
        elif head_now != request.lifecycle_head:
            stale_detail = (
                "the lifecycle head advanced during the model call "
                f"({request.lifecycle_head.split(':')[0]} -> "
                f"{head_now.split(':')[0]})"
            )
    if stale_detail is not None:
        stale = FailureRecord(kind=FAILURE_PROPOSAL_STALE, detail=stale_detail)
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(stale),
        )
        return None, stale, request

    screen = screen_source(proposal.source, task.primitive_catalog)
    if screen is not None:
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(screen),
        )
        return None, screen, request

    if proposal.surface_updates:
        hidden_texts = tuple(
            value
            for case in task.cases
            if case.split != VISIBLE
            for value in (case.input_text, case.case_id)
        )
        for update in proposal.surface_updates:
            update_screen = screen_surface_update(update, hidden_texts)
            if update_screen is not None:
                events.emit(
                    "proposal_rejected",
                    proposer=config.proposer.name,
                    failure=codec.encode(update_screen),
                )
                return None, update_screen, request

    events.emit(
        "proposal",
        proposer=config.proposer.name,
        proposal=codec.encode(proposal),
        source_ref=store.objects.put_text(proposal.source),
    )
    return proposal, None, request


def run_cycle(store: Store, task: Task, config: LoopConfig | None = None) -> CycleReport:
    config = config or LoopConfig()
    policy: AcceptancePolicy = get_policy(config.policy_name)
    ensure_seeded(store, task)

    run_id = _new_run_id()
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    meter = BudgetMeter(config.budget)
    events_semantics = meter.semantics()

    reader = StateReader(store, "cycle", run_id=run_id)
    status = "ok"
    try:
        # threat model: candidate code runs without host-enforced filesystem
        # confinement, so real model-generated code could tamper with the
        # reader control/evidence journal — canary mode is refused outright
        if config.unsafe_model_code and reader.mode == MODE_CANARY:
            status = "rejected"
            raise StoreError(
                "revision-canary mode is refused for real model-generated "
                "code: the sandbox does not confine filesystem access, so "
                "candidate code could tamper with reader control and "
                "evidence. Run `strive reader kill` first, or use the "
                "offline scripted fixture."
            )
        guard_mutation(
            store, task, config.acknowledge_task_drift,
            entries=reader.ledger_entries(),
        )
        if config.acknowledge_task_drift:
            reader.refresh()  # the guard may have journaled an acknowledgement
        _resolve_provisional(store, reader, events)
        # the exact native read, paired through the read boundary before use
        active = reader.read_active("cycle-baseline")
        assert active is not None
        freeze = derive_adaptation_frozen(reader.ledger_entries())
        frozen = freeze is not None

        events.emit(
            "cycle_started",
            task_id=task.task_id,
            task_fingerprint=task.fingerprint(),
            generation_id=active.generation_id,
            policy=f"{policy.name}@{policy.version}",
            proposer=config.proposer.name,
            frozen=frozen,
            budget_semantics=events_semantics,
        )

        evaluation = _execute_and_evaluate(
            store, task, active, meter, config, events, reader, "cycle-baseline"
        )

        diagnosis: Diagnosis | None = None
        proposal: ProposalRecord | None = None
        proposal_failure: FailureRecord | None = None
        candidate: Candidate | None = None
        candidate_evaluation: Evaluation | None = None
        decision: Decision | None = None
        candidate_generation: Generation | None = None

        if frozen:
            assert freeze is not None
            events.emit("adaptation_frozen", reason=freeze.reason)
            reader.note_not_applicable("cycle-candidate-overlay", "adaptation frozen")
            reader.note_not_applicable("cycle-candidate-retained", "adaptation frozen")
        else:
            ctx = VisibleContext(
                task_id=task.task_id,
                cases=task.visible_cases(),
                evaluation=evaluation.visible_view(),
                parent_generation_id=active.generation_id,
                parent_source=reader.source_for_execution(
                    "cycle-baseline", active
                ),
            )
            diagnosis = config.diagnoser.diagnose(ctx)
            if diagnosis is None:
                events.emit("no_weakness_detected")
                reader.add_fact("no-candidate")
                reader.note_not_applicable(
                    "cycle-candidate-overlay", "no weakness detected"
                )
                reader.note_not_applicable(
                    "cycle-candidate-retained", "no weakness detected"
                )
            else:
                events.emit("weakness_detected", diagnosis=codec.encode(diagnosis))
                proposal, proposal_failure, proposal_request = _proposal_stage(
                    store, task, ctx, diagnosis, meter, config, events, reader
                )
                if proposal is None:
                    assert proposal_failure is not None
                    reader.note_not_applicable(
                        "cycle-candidate-overlay",
                        f"proposal rejected: {proposal_failure.kind}",
                    )
                    reader.note_not_applicable(
                        "cycle-candidate-retained",
                        f"proposal rejected: {proposal_failure.kind}",
                    )
                else:
                    candidate = Candidate(
                        candidate_id=f"cand-{uuid.uuid4().hex[:8]}",
                        parent_generation_id=proposal.parent_generation_id,
                        surface=proposal.surface,
                        weakness_id=diagnosis.weakness_id,
                        description=proposal.summary,
                        source_ref=store.objects.put_text(proposal.source),
                    )
                    events.emit(
                        "candidate_proposed", candidate=codec.encode(candidate)
                    )

                    # the immutable, UNACTIVATED candidate revision — created
                    # before evaluation; the evaluated subject is exactly this
                    proposer_ref = (
                        config.proposer.name
                        if "@" in config.proposer.name
                        else f"{config.proposer.name}@0"
                    )
                    # the native lifecycle's active revision is the overlay's
                    # base parent, so the evaluated revision's lineage is the
                    # canonical one (not the generation-derived id)
                    lifecycle_baseline = lifecycle.active_revision_id(store)
                    overlay = _build_composite_overlay(
                        store, candidate, proposal, lifecycle_baseline,
                        proposer_ref, task,
                    )
                    if overlay is None:
                        # no silent derived->native path: recorded, and in
                        # canary the breaker opens BEFORE any execution
                        reader.overlay_failure(
                            "cycle-candidate-overlay",
                            "candidate revision/manifest construction failed",
                        )
                    else:
                        reader.check_candidate_overlay(
                            "cycle-candidate-overlay", candidate.source_ref, overlay
                        )
                        events.emit(
                            "candidate_overlay",
                            candidate_id=candidate.candidate_id,
                            revision_ref=overlay.revision_ref,
                            manifest_ref=overlay.manifest_ref,
                        )

                    candidate_probe = Generation(
                        generation_id=f"candidate:{candidate.candidate_id}",
                        task_id=task.task_id,
                        task_fingerprint=task.fingerprint(),
                        parent_id=active.generation_id,
                        origin="candidate",
                        surface=candidate.surface,
                        weakness_id=candidate.weakness_id,
                        created_at=now_iso(),
                        source_ref=candidate.source_ref,
                    )
                    candidate_execution_record: dict[str, str] = {}
                    candidate_evaluation = _execute_and_evaluate(
                        store, task, candidate_probe, meter, config, events,
                        reader, "cycle-candidate-overlay", overlay=overlay,
                        execution_record=candidate_execution_record,
                    )
                    decision = policy.decide(evaluation, candidate_evaluation)
                    events.emit("decision", decision=codec.encode(decision))

                    candidate_generation = store.add_generation(
                        store.objects.get_text(candidate.source_ref),
                        task_fingerprint=task.fingerprint(),
                        parent_id=active.generation_id,
                        origin="evolved",
                        surface=candidate.surface,
                        weakness_id=candidate.weakness_id,
                        decision=decision,
                    )
                    reader.refresh()  # our own write
                    # the retained candidate, paired with its just-mirrored
                    # revision before it can be activated — AND verified
                    # content-identical to the exact evaluated overlay
                    reader.read_generation(
                        "cycle-candidate-retained",
                        candidate_generation.generation_id,
                    )
                    if overlay is not None:
                        reader.check_retained_matches_overlay(
                            "cycle-candidate-retained", overlay, candidate_generation
                        )
                        reader.record_retention(
                            candidate.candidate_id,
                            overlay,
                            candidate_generation,
                            decision,
                            events,
                        )
                    reader.add_fact(
                        "decision-accepted" if decision.accepted else "decision-rejected"
                    )
                    events.emit(
                        "retained",
                        generation_id=candidate_generation.generation_id,
                        accepted=decision.accepted,
                    )
                    policy_ref = f"{policy.name}@{policy.version}"
                    secure_backend = _backend_is_secure(config.sandbox_backend)
                    if config.unsafe_model_code and not secure_backend:
                        # threat model: without a secure backend, candidate
                        # code ran on the fault-only boundary (it could read
                        # the repo/ledger and open sockets), so lifecycle
                        # AUTHORITY is refused — served behavior evolves
                        # generation-native only, and the gap stays visible
                        # via compat_parity until a later contained run's
                        # convergence backfills it. With a secure backend the
                        # code was mechanically contained and falls through to
                        # the native lifecycle path below.
                        store._note_diagnostic(
                            "lifecycle authority refused for unsafe "
                            "model-generated code with no secure sandbox "
                            "backend; generation-native only"
                        )
                        if decision.accepted:
                            store.activate(
                                candidate_generation.generation_id,
                                reason="evolved",
                                policy=policy_ref,
                                expected_active=active.generation_id,
                                expected_head=reader.canonical_head,
                            )
                            reader.refresh()
                            events.emit(
                                "activated",
                                generation_id=candidate_generation.generation_id,
                                mode=ACTIVATION_DURABLE,
                            )
                    elif overlay is None:
                        # the evaluated identity cannot be retained: an
                        # accepted candidate must NOT be promoted as an
                        # identity-less replacement; a rejected one just
                        # leaves a loud, parity-visible gap
                        if decision.accepted:
                            raise StoreError(
                                "candidate overlay unavailable; refusing to "
                                "promote a candidate whose evaluated identity "
                                "cannot be retained"
                            )
                        store._note_diagnostic(
                            "candidate overlay unavailable; the rejected "
                            "candidate has no lifecycle identity"
                        )
                    else:
                        # native lifecycle: persist the EXACT evaluated
                        # revision's identity + evidence BEFORE any served
                        # behavior changes; the accepted candidate is then
                        # activated as that same revision through one
                        # recoverable cross-journal operation — never a
                        # replacement built after evaluation
                        assert candidate_evaluation is not None
                        # SURFACE-SPECIFIC EVIDENCE: a prompt delta must earn
                        # its own trusted verdict; it never piggybacks on the
                        # bundled code's task scores
                        composite_decision = decision
                        prompt_evidence = None
                        prompt_evidence_ref: str | None = None
                        if proposal.surface_updates:
                            prompt_evidence, prompt_evidence_ref, composite_decision = (
                                _prompt_surface_gate(
                                    store, task, proposal, proposal_request,
                                    decision, config, events,
                                )
                            )
                        selection_policy_ref = (
                            f"{composite_decision.policy}@"
                            f"{composite_decision.policy_version}"
                        )
                        recorded = _record_candidate_evidence(
                            store,
                            task,
                            overlay,
                            lifecycle_baseline,
                            candidate_generation.generation_id,
                            evaluation,
                            candidate_evaluation,
                            composite_decision,
                            selection_policy_ref,
                            run_id,
                            events,
                            execution_record_ref=candidate_execution_record.get(
                                "ref", ""
                            ),
                            usage=meter.usage(),
                            budget=config.budget,
                            prompt_evidence_ref=prompt_evidence_ref,
                            prompt_improved=(
                                prompt_evidence.improved
                                if prompt_evidence is not None
                                else None
                            ),
                            sandbox_provenance_ref=candidate_execution_record.get(
                                "sandbox_provenance_ref", ""
                            ),
                        )
                        revision_id = recorded.revision_id
                        if prompt_evidence is not None and prompt_evidence_ref:
                            lifecycle.record_surface_evidence(
                                store,
                                revision_id,
                                surface="prompt",
                                evidence_ref=prompt_evidence_ref,
                                improved=prompt_evidence.improved,
                                run_id=run_id,
                                bundle_ref=recorded.prompt_bundle_ref,
                            )
                        if composite_decision.accepted:
                            # activation cites the exact SelectionDecision
                            lifecycle.run_activation_op(
                                store,
                                revision_id,
                                reason="evolved",
                                policy_ref=selection_policy_ref,
                                decision_ref=recorded.selection_ref,
                                gen_expected_active=active.generation_id,
                                gen_expected_head=reader.canonical_head,
                            )
                            reader.refresh()
                            events.emit(
                                "activated",
                                generation_id=candidate_generation.generation_id,
                                mode=ACTIVATION_DURABLE,
                            )
                            events.emit(
                                "lifecycle_activated", revision_id=revision_id
                            )
                        elif decision.accepted:
                            # the CODE passed but the prompt delta earned no
                            # surface-specific benefit: activate the code-only
                            # sibling (the same executed artifact, prompt
                            # unchanged) and keep the composite retained as
                            # rejected evidence
                            sibling_id = _activate_code_only_sibling(
                                store, task, candidate, proposal,
                                lifecycle_baseline, candidate_generation,
                                evaluation, candidate_evaluation, decision,
                                policy_ref, proposer_ref, run_id,
                                usage=meter.usage(),
                                budget=config.budget,
                                gen_expected_active=active.generation_id,
                                gen_expected_head=reader.canonical_head,
                            )
                            reader.refresh()
                            events.emit(
                                "activated",
                                generation_id=candidate_generation.generation_id,
                                mode=ACTIVATION_DURABLE,
                            )
                            events.emit(
                                "lifecycle_activated", revision_id=sibling_id
                            )
                            events.emit(
                                "composite_demoted",
                                composite_revision_id=revision_id,
                                activated_revision_id=sibling_id,
                                reason=composite_decision.reason,
                            )

        usage = meter.usage()
        cycle = CycleRecord(
            run_id=run_id,
            at=now_iso(),
            task_id=task.task_id,
            task_fingerprint=task.fingerprint(),
            generation_id=active.generation_id,
            overall_score=evaluation.overall_score,
            split_scores=dict(evaluation.split_scores),
            weakness_id=diagnosis.weakness_id if diagnosis else None,
            candidate_generation_id=(
                candidate_generation.generation_id if candidate_generation else None
            ),
            accepted=decision.accepted if decision else None,
            frozen=frozen,
            usage=usage,
        )
        store.append(cycle)
        reader.refresh()
        events.emit("cycle_completed", usage=codec.encode(usage))

        if not frozen:
            verdict = StallDetector(config.stall_window).check(
                derive_cycles(reader.ledger_entries())
            )
            if verdict.stalled:
                store.append(
                    Intervention(
                        kind=INTERVENTION_STALL_FREEZE,
                        reason=verdict.reason,
                        at=now_iso(),
                        run_id=run_id,
                    )
                )
                reader.refresh()
                events.emit("stall_freeze", reason=verdict.reason)

        after = reader.native_active()
        assert after is not None
        return CycleReport(
            run_id=run_id,
            generation_before=active.generation_id,
            evaluation=evaluation,
            frozen=frozen,
            diagnosis=diagnosis,
            proposal=proposal,
            proposal_failure=proposal_failure,
            candidate=candidate,
            candidate_evaluation=candidate_evaluation,
            decision=decision,
            generation_after=after.generation_id,
        )
    except BaseException as exc:
        status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(events, status)  # durable evidence, even on failure


# -- kernel operations used by the CLI ------------------------------------------


@dataclass(frozen=True)
class AuditReport:
    generation_id: str
    evaluation: Evaluation


def audit_generation(
    store: Store,
    task: Task,
    generation_id: str | None = None,
    config: LoopConfig | None = None,
) -> AuditReport:
    """Evaluate a generation on the final audit holdout, on demand.

    This is deliberately NOT part of any routine cycle or promotion decision:
    the audit split exists so there is evaluation data that candidate
    selection has never been able to overfit. Each audit is journaled.
    """
    config = config or LoopConfig()
    guard_task_binding(store, task, mutating=False)
    run_id = _new_run_id("audit")
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    reader = StateReader(store, "audit", run_id=run_id)
    status = "ok"
    try:
        # the exact native read, paired before use
        generation = (
            reader.read_generation("audit-target", generation_id)
            if generation_id is not None
            else reader.read_active("audit-target")
        )
        if generation is None:
            raise StoreError("no active generation to audit")
        cases = task.audit_cases()
        if not cases:
            raise StoreError(f"task {task.task_id!r} declares no audit cases")
        meter = BudgetMeter(config.budget)
        denial = meter.request_execution()
        if denial is not None:
            status = "denied"
            raise StoreError(f"audit denied by budget: {denial.detail}")
        reader.record_execution("audit-target", generation, events)
        report = run_strategy(
            reader.source_for_execution("audit-target", generation),
            cases,
            generation_id=generation.generation_id,
            timeout_s=meter.execution_timeout_s(config.sandbox_timeout_s),
            output_bytes_cap=meter.execution_output_cap(),
        )
        evaluation = evaluate(task, report, cases)
        events.emit(
            "audited",
            generation_id=generation.generation_id,
            evaluation=codec.encode(evaluation),
        )
        reader.add_fact("audit")
        return AuditReport(
            generation_id=generation.generation_id, evaluation=evaluation
        )
    except BaseException as exc:
        if status == "ok":
            status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(events, status)


@dataclass(frozen=True)
class CompareReport:
    left_id: str
    right_id: str
    left: Evaluation
    right: Evaluation
    decision: Decision


def compare_generations(
    store: Store, task: Task, left_id: str, right_id: str, config: LoopConfig | None = None
) -> CompareReport:
    """Paired evaluation of two retained generations under the acceptance policy
    (left = incumbent/baseline, right = candidate)."""
    config = config or LoopConfig()
    guard_task_binding(store, task, mutating=False)
    policy = get_policy(config.policy_name)
    run_id = _new_run_id("compare")
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    meter = BudgetMeter(config.budget)
    reader = StateReader(store, "compare", run_id=run_id)
    status = "ok"
    try:
        # the exact native reads, paired through the boundary before use
        left = reader.read_generation("compare-left", left_id)
        right = reader.read_generation("compare-right", right_id)
        left_eval = _execute_and_evaluate(
            store, task, left, meter, config, events, reader, "compare-left"
        )
        right_eval = _execute_and_evaluate(
            store, task, right, meter, config, events, reader, "compare-right"
        )
        decision = policy.decide(left_eval, right_eval)
        reader.add_fact(
            "decision-accepted" if decision.accepted else "decision-rejected"
        )
        events.emit("decision", decision=codec.encode(decision))
        return CompareReport(
            left_id=left_id, right_id=right_id, left=left_eval, right=right_eval,
            decision=decision,
        )
    except BaseException as exc:
        status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(events, status)


def promote_generation(
    store: Store,
    task: Task,
    generation_id: str,
    *,
    provisional: bool = False,
    expires_after_cycles: int = 3,
    config: LoopConfig | None = None,
) -> tuple[Activation, Decision | None]:
    """Manually promote a retained generation.

    Durable promotion demands paired evidence against the incumbent under the
    acceptance policy; a rejection refuses to activate. Provisional promotion
    (low-risk path) activates immediately but scoped, monitored, and expiring:
    it must be confirmed by its observation window or it reverts.
    """
    config = config or LoopConfig()
    guard_mutation(store, task, config.acknowledge_task_drift)
    reader = StateReader(store, "promote")
    status = "ok"
    try:
        # the exact native reads, paired through the boundary before use
        target = reader.read_generation("promote-target", generation_id)
        active = reader.read_active("promote-incumbent")
        if active is None:
            raise StoreError("no active generation; run a cycle first")
        if target.generation_id == active.generation_id:
            raise StoreError(f"{generation_id} is already active")
        previously_active = any(
            isinstance(e, Activation) and e.generation_id == generation_id
            for e in reader.ledger_entries()
        )
        reader.add_fact("re-promotion" if previously_active else "promotion")

        if provisional:
            if target.surface == STRATEGY_CODE_SURFACE:
                raise StoreError(
                    "provisional activation is not allowed for executable "
                    "strategy-code: until risk-aware surface descriptors exist, "
                    "the provisional path is reserved for explicitly low-risk "
                    "non-code surfaces; use durable promotion (paired evidence) "
                    "instead"
                )
            recent = derive_cycles(reader.ledger_entries())
            baseline_score = recent[-1].overall_score if recent else 0.0
            activation = store.activate(
                generation_id,
                reason="promote",
                mode=ACTIVATION_PROVISIONAL,
                expires_after_cycles=expires_after_cycles,
                baseline_score=baseline_score,
                policy=f"{PROVISIONAL_POLICY.name}@{PROVISIONAL_POLICY.version}",
                expected_active=active.generation_id,
                expected_head=reader.canonical_head,
            )
            reader.refresh()
            return activation, None

        # paired evidence — activation itself remains generation-native
        compare = compare_generations(
            store, task, active.generation_id, generation_id, config
        )
        if not compare.decision.accepted:
            status = "rejected"
            raise StoreError(
                f"promotion refused by policy {compare.decision.policy}@"
                f"{compare.decision.policy_version}: {compare.decision.reason}"
            )
        try:
            activation = store.activate(
                generation_id,
                reason="promote",
                policy=f"{compare.decision.policy}@{compare.decision.policy_version}",
                expected_active=active.generation_id,
                expected_head=reader.canonical_head,
            )
        except StoreError as exc:
            if "stale read head" in str(exc):
                status = "stale"
            raise
        reader.refresh()
        return activation, compare.decision
    except BaseException as exc:
        if status == "ok":
            status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(None, status)


def rollback_generation(store: Store) -> Generation:
    """Roll back to the active generation's parent, with the exact native
    reads (the active generation and the parent being restored) paired
    through the read boundary before use. The mutation carries the reader's
    expected head: a rollback decided against a stale read refuses."""
    reader = StateReader(store, "rollback")
    status = "ok"
    try:
        reader.read_active("rollback-active")
        reader.read_rollback_target("rollback-parent")
        reader.add_fact("rollback")
        try:
            restored = store.rollback(expected_head=reader.canonical_head)
        except StoreError as exc:
            if "stale read head" in str(exc):
                status = "stale"
            raise
        reader.refresh()
        return restored
    except BaseException as exc:
        if status == "ok":
            status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(None, status)


@dataclass(frozen=True)
class ReplayReport:
    run_id: str
    generation_id: str
    task_drift: bool
    recorded_score: float
    replayed_score: float
    matches: bool
    split_diffs: dict[str, float]
    candidate_generation_id: str | None
    candidate_replayed_score: float | None
    decision_matches: bool | None
    # evidence-envelope replay: the candidate's recorded ValidationBundle
    # metrics recomputed from the re-executed evaluation and diffed —
    # "compare beyond the boolean" over the envelope, not just the verdict
    bundle_checked: bool = False
    bundle_metric_diffs: dict[str, float] | None = None
    bundle_matches: bool | None = None


def replay_run(
    store: Store, task: Task, run_id: str, config: LoopConfig | None = None
) -> ReplayReport:
    """Execution-and-decision replay of a recorded cycle (offline).

    Precisely scoped: re-executes the baseline (and candidate, if the cycle
    produced one) from content-addressed sources and re-runs the *recorded*
    acceptance policy, checking that scores and the accept/reject decision
    reproduce. It does NOT replay diagnosis, prompt reconstruction, recorded
    completion injection, proposal parsing, or the source screen — full-cycle
    replay is deferred work (see HANDOFF). No proposer or model is consulted.
    """
    config = config or LoopConfig()
    guard_task_binding(store, task, mutating=False)
    replay_id = _new_run_id("replay")
    events = EventLog(store.runs_dir / replay_id / "events.jsonl", replay_id)
    reader = StateReader(store, "replay", run_id=replay_id)
    status = "ok"
    try:
        cycle = next(
            (
                c
                for c in derive_cycles(reader.ledger_entries())
                if c.run_id == run_id
            ),
            None,
        )
        if cycle is None:
            raise StoreError(f"unknown run for task {store.task_id!r}: {run_id}")
        task_drift = cycle.task_fingerprint != task.fingerprint()
        # the exact native read, paired through the boundary before use
        generation = reader.read_generation("replay-baseline", cycle.generation_id)
        meter = BudgetMeter(config.budget)
        evaluation = _execute_and_evaluate(
            store, task, generation, meter, config, events, reader,
            "replay-baseline",
        )
        split_diffs = {
            split: round(evaluation.split_scores.get(split, 0.0) - recorded, 6)
            for split, recorded in cycle.split_scores.items()
        }
        matches = (not task_drift) and evaluation.overall_score == cycle.overall_score

        candidate_replayed_score: float | None = None
        decision_matches: bool | None = None
        bundle_checked = False
        bundle_metric_diffs: dict[str, float] | None = None
        bundle_matches: bool | None = None
        if cycle.candidate_generation_id is None:
            reader.note_not_applicable("replay-candidate", "cycle had no candidate")
        else:
            candidate_generation = reader.read_generation(
                "replay-candidate", cycle.candidate_generation_id
            )
            candidate_evaluation = _execute_and_evaluate(
                store, task, candidate_generation, meter, config, events,
                reader, "replay-candidate",
            )
            candidate_replayed_score = candidate_evaluation.overall_score
            recorded_decision = candidate_generation.decision
            if recorded_decision is not None:
                try:
                    policy = get_policy(recorded_decision.policy)
                except KeyError:
                    raise StoreError(
                        f"recorded policy {recorded_decision.policy!r} is unknown to "
                        "this build; refusing decision replay"
                    ) from None
                if policy.version != recorded_decision.policy_version:
                    raise StoreError(
                        f"recorded policy {recorded_decision.policy}@"
                        f"{recorded_decision.policy_version} is unavailable (this "
                        f"build provides @{policy.version}); refusing decision "
                        "replay rather than comparing across policy versions"
                    )
                replayed_decision = policy.decide(evaluation, candidate_evaluation)
                # compare beyond the boolean: verdict, both scores, regressions
                decision_matches = (
                    replayed_decision.accepted == recorded_decision.accepted
                    and replayed_decision.baseline_score
                    == recorded_decision.baseline_score
                    and replayed_decision.candidate_score
                    == recorded_decision.candidate_score
                    and replayed_decision.regressed_case_ids
                    == recorded_decision.regressed_case_ids
                )

            # evidence-envelope replay: recompute the recorded task bundle's
            # candidate metrics from the re-executed evaluation and diff them
            from strive import validators as validator_registry
            from strive.evidence import ValidationBundle

            lifecycle_state = lifecycle.state(store)
            for revision_id_ in (
                r
                for r, g in lifecycle_state.links.items()
                if g == cycle.candidate_generation_id
            ):
                for link in lifecycle_state.evidence_links.get(revision_id_, ()):
                    if link.kind != "evaluation":
                        continue
                    try:
                        bundle: ValidationBundle = codec.loads(
                            store.objects.get_text(link.envelope_ref),
                            ValidationBundle,
                        )
                    except Exception:  # noqa: BLE001 — unreadable bundle: skip
                        continue
                    recorded_result = next(
                        (
                            r
                            for r in bundle.results
                            if r.subject_role == "candidate"
                        ),
                        None,
                    )
                    if recorded_result is None:
                        continue
                    recomputed = validator_registry.task_suite_result(
                        store, candidate_evaluation, subject_role="candidate"
                    )
                    bundle_metric_diffs = {
                        key: round(
                            recomputed.metrics.get(key, 0.0) - recorded_value, 6
                        )
                        for key, recorded_value in recorded_result.metrics.items()
                    }
                    bundle_matches = all(
                        diff == 0.0 for diff in bundle_metric_diffs.values()
                    )
                    bundle_checked = True

        reader.add_fact("replay")
        return ReplayReport(
            run_id=run_id,
            generation_id=cycle.generation_id,
            task_drift=task_drift,
            recorded_score=cycle.overall_score,
            replayed_score=evaluation.overall_score,
            matches=matches,
            split_diffs=split_diffs,
            candidate_generation_id=cycle.candidate_generation_id,
            candidate_replayed_score=candidate_replayed_score,
            decision_matches=decision_matches,
            bundle_checked=bundle_checked,
            bundle_metric_diffs=bundle_metric_diffs,
            bundle_matches=bundle_matches,
        )
    except BaseException as exc:
        status = f"error:{type(exc).__name__}"
        raise
    finally:
        reader.finish(events, status)
