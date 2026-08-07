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
    Candidate,
    CycleRecord,
    Decision,
    Diagnosis,
    Evaluation,
    ExecutionReport,
    FAILURE_PROPOSAL_STALE,
    FailureRecord,
    Intervention,
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
    screen_source,
)
from strive.sandbox import run_strategy
from strive.store import Store, StoreError
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


def ensure_seeded(store: Store, task: Task) -> Generation:
    if store.task_id != task.task_id:
        raise StoreError(
            f"store is bound to task {store.task_id!r}, got {task.task_id!r}"
        )
    active = store.active_generation()
    if active is not None:
        return active
    record = store.add_generation(
        task.seed_source,
        task_fingerprint=task.fingerprint(),
        parent_id=None,
        origin="seed",
        surface=STRATEGY_CODE_SURFACE,
        weakness_id=None,
        decision=None,
    )
    store.activate(record.generation_id, reason="seed", policy="seed")
    return record


def _execute_and_evaluate(
    store: Store,
    task: Task,
    generation: Generation,
    meter: BudgetMeter,
    config: LoopConfig,
    events: EventLog,
) -> Evaluation:
    """Charge, execute, attribute, and evaluate one generation. Never raises
    for candidate behavior: failures come back inside the Evaluation."""
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
    report = run_strategy(
        store.source_of(generation),
        cases,
        generation_id=generation.generation_id,
        timeout_s=meter.execution_timeout_s(config.sandbox_timeout_s),
        output_bytes_cap=meter.execution_output_cap(),
    )
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


def _proposal_history(store: Store, limit: int) -> tuple[ProposalHistoryItem, ...]:
    """Sanitized accepted/rejected history: visible-split scores and policy
    identity only. Decision *reasons* are excluded (they may cite hidden-split
    case ids) and so are overall/hidden-split scores (they are influenced by
    hidden evaluation data and must not flow back to proposers)."""
    items: list[ProposalHistoryItem] = []
    for generation in store.generations().values():
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


def _resolve_provisional(store: Store, events: EventLog) -> None:
    """Expire or confirm a provisional activation whose window has elapsed."""
    activation = store.active_activation()
    if activation is None or activation.mode != ACTIVATION_PROVISIONAL:
        return
    window = store.cycles_since_activation(activation)
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
        )
        events.emit(
            "provisional_confirmed",
            generation_id=activation.generation_id,
            window_scores=list(scores),
            baseline_score=baseline,
        )
        return
    previous = store.activation_before(activation)
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
    store.activate(
        previous.generation_id,
        reason="expired-reverted",
        policy=f"{PROVISIONAL_POLICY.name}@{PROVISIONAL_POLICY.version}",
    )
    events.emit(
        "provisional_reverted",
        from_generation=activation.generation_id,
        to_generation=previous.generation_id,
        window_scores=list(scores),
        baseline_score=baseline,
    )


def _proposal_stage(
    store: Store,
    task: Task,
    ctx: VisibleContext,
    diagnosis: Diagnosis,
    meter: BudgetMeter,
    config: LoopConfig,
    events: EventLog,
) -> tuple[ProposalRecord | None, FailureRecord | None]:
    """Run the proposer, then kernel-side checks: staleness and the forbidden-
    source screen. Every rejection is journaled with its distinct kind."""
    model_handle = None
    if config.model_adapter is not None:
        model_handle = MeteredJournalingAdapter(
            config.model_adapter, meter, events, store.objects
        )
    usage = meter.usage()
    request = ProposalRequest(
        ctx=ctx,
        diagnosis=diagnosis,
        task_description=task.description,
        task_signature=task.signature,
        primitive_catalog=task.primitive_catalog,
        history=_proposal_history(store, config.history_limit),
        max_output_tokens=config.model_max_tokens,
        model_calls_remaining=max(0, config.budget.model_calls - usage.model_calls - 1),
        executions_remaining=max(0, config.budget.executions - usage.executions),
        model=model_handle,
    )
    result = config.proposer.propose(request)

    if result.failure is not None:
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(result.failure),
        )
        return None, result.failure
    assert result.proposal is not None
    proposal = result.proposal

    # staleness: re-read the incumbent; a slow proposal must not apply to a
    # generation that is no longer active
    current = store.active_generation()
    current_id = current.generation_id if current is not None else "(none)"
    if current_id != proposal.parent_generation_id:
        stale = FailureRecord(
            kind=FAILURE_PROPOSAL_STALE,
            detail=(
                f"proposal parented on {proposal.parent_generation_id} but the "
                f"active generation is now {current_id}"
            ),
        )
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(stale),
        )
        return None, stale

    screen = screen_source(proposal.source, task.primitive_catalog)
    if screen is not None:
        events.emit(
            "proposal_rejected",
            proposer=config.proposer.name,
            failure=codec.encode(screen),
        )
        return None, screen

    events.emit(
        "proposal",
        proposer=config.proposer.name,
        proposal=codec.encode(proposal),
        source_ref=store.objects.put_text(proposal.source),
    )
    return proposal, None


def run_cycle(store: Store, task: Task, config: LoopConfig | None = None) -> CycleReport:
    config = config or LoopConfig()
    policy: AcceptancePolicy = get_policy(config.policy_name)
    ensure_seeded(store, task)

    run_id = _new_run_id()
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    meter = BudgetMeter(config.budget)

    _resolve_provisional(store, events)
    active = store.active_generation()
    assert active is not None
    freeze = store.adaptation_frozen()
    frozen = freeze is not None

    events.emit(
        "cycle_started",
        task_id=task.task_id,
        task_fingerprint=task.fingerprint(),
        generation_id=active.generation_id,
        policy=f"{policy.name}@{policy.version}",
        proposer=config.proposer.name,
        frozen=frozen,
    )

    evaluation = _execute_and_evaluate(store, task, active, meter, config, events)

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
    else:
        ctx = VisibleContext(
            task_id=task.task_id,
            cases=task.visible_cases(),
            evaluation=evaluation.visible_view(),
            parent_generation_id=active.generation_id,
            parent_source=store.source_of(active),
        )
        diagnosis = config.diagnoser.diagnose(ctx)
        if diagnosis is None:
            events.emit("no_weakness_detected")
        else:
            events.emit("weakness_detected", diagnosis=codec.encode(diagnosis))
            proposal, proposal_failure = _proposal_stage(
                store, task, ctx, diagnosis, meter, config, events
            )
            if proposal is not None:
                candidate = Candidate(
                    candidate_id=f"cand-{uuid.uuid4().hex[:8]}",
                    parent_generation_id=proposal.parent_generation_id,
                    surface=proposal.surface,
                    weakness_id=diagnosis.weakness_id,
                    description=proposal.summary,
                    source_ref=store.objects.put_text(proposal.source),
                )
                events.emit("candidate_proposed", candidate=codec.encode(candidate))

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
                candidate_evaluation = _execute_and_evaluate(
                    store, task, candidate_probe, meter, config, events
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
                events.emit(
                    "retained",
                    generation_id=candidate_generation.generation_id,
                    accepted=decision.accepted,
                )
                if decision.accepted:
                    store.activate(
                        candidate_generation.generation_id,
                        reason="evolved",
                        policy=f"{policy.name}@{policy.version}",
                        expected_active=active.generation_id,
                    )
                    events.emit(
                        "activated",
                        generation_id=candidate_generation.generation_id,
                        mode=ACTIVATION_DURABLE,
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
    events.emit("cycle_completed", usage=codec.encode(usage))

    if not frozen:
        verdict = StallDetector(config.stall_window).check(store.cycles())
        if verdict.stalled:
            store.append(
                Intervention(
                    kind=INTERVENTION_STALL_FREEZE,
                    reason=verdict.reason,
                    at=now_iso(),
                    run_id=run_id,
                )
            )
            events.emit("stall_freeze", reason=verdict.reason)

    after = store.active_generation()
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
    generation = (
        store.generation(generation_id)
        if generation_id is not None
        else store.active_generation()
    )
    if generation is None:
        raise StoreError("no active generation to audit")
    cases = task.audit_cases()
    if not cases:
        raise StoreError(f"task {task.task_id!r} declares no audit cases")
    run_id = _new_run_id("audit")
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    meter = BudgetMeter(config.budget)
    denial = meter.request_execution()
    if denial is not None:
        raise StoreError(f"audit denied by budget: {denial.detail}")
    report = run_strategy(
        store.source_of(generation),
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
    return AuditReport(generation_id=generation.generation_id, evaluation=evaluation)


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
    policy = get_policy(config.policy_name)
    run_id = _new_run_id("compare")
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id)
    meter = BudgetMeter(config.budget)
    left_eval = _execute_and_evaluate(
        store, task, store.generation(left_id), meter, config, events
    )
    right_eval = _execute_and_evaluate(
        store, task, store.generation(right_id), meter, config, events
    )
    decision = policy.decide(left_eval, right_eval)
    events.emit("decision", decision=codec.encode(decision))
    return CompareReport(
        left_id=left_id, right_id=right_id, left=left_eval, right=right_eval, decision=decision
    )


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
    target = store.generation(generation_id)
    active = store.active_generation()
    if active is None:
        raise StoreError("no active generation; run a cycle first")
    if target.generation_id == active.generation_id:
        raise StoreError(f"{generation_id} is already active")

    if provisional:
        if target.surface == STRATEGY_CODE_SURFACE:
            raise StoreError(
                "provisional activation is not allowed for executable "
                "strategy-code: until risk-aware surface descriptors exist, "
                "the provisional path is reserved for explicitly low-risk "
                "non-code surfaces; use durable promotion (paired evidence) "
                "instead"
            )
        recent = store.cycles()
        baseline_score = recent[-1].overall_score if recent else 0.0
        activation = store.activate(
            generation_id,
            reason="promote",
            mode=ACTIVATION_PROVISIONAL,
            expires_after_cycles=expires_after_cycles,
            baseline_score=baseline_score,
            policy=f"{PROVISIONAL_POLICY.name}@{PROVISIONAL_POLICY.version}",
            expected_active=active.generation_id,
        )
        return activation, None

    compare = compare_generations(
        store, task, active.generation_id, generation_id, config
    )
    if not compare.decision.accepted:
        raise StoreError(
            f"promotion refused by policy {compare.decision.policy}@"
            f"{compare.decision.policy_version}: {compare.decision.reason}"
        )
    activation = store.activate(
        generation_id,
        reason="promote",
        policy=f"{compare.decision.policy}@{compare.decision.policy_version}",
        expected_active=active.generation_id,
    )
    return activation, compare.decision


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
    cycle = store.cycle(run_id)
    task_drift = cycle.task_fingerprint != task.fingerprint()
    generation = store.generation(cycle.generation_id)
    replay_id = _new_run_id("replay")
    events = EventLog(store.runs_dir / replay_id / "events.jsonl", replay_id)
    meter = BudgetMeter(config.budget)
    evaluation = _execute_and_evaluate(store, task, generation, meter, config, events)
    split_diffs = {
        split: round(evaluation.split_scores.get(split, 0.0) - recorded, 6)
        for split, recorded in cycle.split_scores.items()
    }
    matches = (not task_drift) and evaluation.overall_score == cycle.overall_score

    candidate_replayed_score: float | None = None
    decision_matches: bool | None = None
    if cycle.candidate_generation_id is not None:
        candidate_generation = store.generation(cycle.candidate_generation_id)
        candidate_evaluation = _execute_and_evaluate(
            store, task, candidate_generation, meter, config, events
        )
        candidate_replayed_score = candidate_evaluation.overall_score
        recorded_decision = candidate_generation.decision
        if recorded_decision is not None:
            policy = get_policy(recorded_decision.policy)
            replayed_decision = policy.decide(evaluation, candidate_evaluation)
            decision_matches = replayed_decision.accepted == recorded_decision.accepted

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
    )
