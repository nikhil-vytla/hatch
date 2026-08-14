"""Stage-3C.1: the prompt-surface composite evolution experiment.

The question: does the prompt/proposal-template surface CAUSALLY change
proposer behavior through the real pipeline, and can a SELF-PRODUCED
prompt+code composite earn activation on BOTH surfaces' evidence?

Design: matched arms from the same baseline, adapter, parameters, and
budgets, differing ONLY in the controlled variable. The deterministic
`prompt_sensitive_adapter` is an instruction follower whose output is a
function of the prompt content — the INCUMBENT template withholds failing
input excerpts ({failing_case_ids}: ids + feedback only), the CANDIDATE
template surfaces them ({failing_cases}). Both strategy variants are
author-written fixtures: the offline experiment proves CAUSAL PIPELINE
WIRING (the artifact is consumed and changes behavior), not model
capability. Genuine model-driven prompt improvement is claimed only from a
recorded real-model run (opt-in, env-configured, labeled single-trial
unless repeated paired trials run), and a real-model failure is an honest
result.

Arms:
- A  incumbent prompt (live cycle)  → valid proposal, unsigned fix, the
     task gate REJECTS it — the incumbent prompt's measurable failure;
- B  candidate prompt (live cycle)  → same adapter/baseline/budgets, only
     the active prompt differs; valid proposal, signed fix, ACCEPTED;
- C  prompt-only ablation           → task gate REJECTS (a prompt change
     cannot move execution scores); retained as rejected evidence;
- D  code-only ablation             → task gate ACCEPTS;
- E  the TWO-STAGE SELF-PRODUCED composite: (1) the proposer, under the
     incumbent prompt, proposes prompt p1; (2) p1 generates strategy s1 in
     a fresh, fixed-budget call; (3) the immutable p1+s1 revision is built
     BEFORE evaluation, then task-gated (code evidence) AND prompt-gated
     (the trusted `promptgate` comparison — prompt evidence). The same
     revision id is proposed, evaluated, retained, selected, activated,
     restarted, replayed, and rolled back. D matches E on task score, so E
     activates only because its prompt evidence proves an additional
     objective benefit — neither surface piggybacks on the other.

Arm setup note, stated plainly: the sparse incumbent template is INSTALLED
as each arm's initial condition through a journaled operator override (the
experiment's controlled starting state). The claimed evolution in arm E is
what happens AFTER that: prompt p1 and strategy s1 are both self-produced
by the proposer pipeline and gated on their own evidence. An
override-installed prompt followed by a code-only proposal is NOT counted
as prompt evolution anywhere in this report.

Every arm uses the normal metered execution/evaluation paths and records
proposal validity, per-split scores, regressions, executions, model calls,
tokens, latency, and cost. An `ExperimentManifest` pinning fingerprints,
refs, parameters, budgets, arm order, journal heads, and outcomes is
persisted in the (unique, reuse-refused) run directory.
"""

from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from pathlib import Path

from strive import codec, lifecycle
from strive import selection as selection_mod
from strive.budget import BudgetMeter
from strive.contracts import BudgetSpec, Decision, Evaluation, Event
from strive.diagnose import EvidenceDiagnoser
from strive.evaluate import evaluate
from strive.events import EventLog, now_iso
from strive.fakemodel import SIGNED_SUM_FIX, prompt_sensitive_adapter
from strive.loop import LoopConfig, ensure_seeded, resolve_active_prompt, run_cycle
from strive.model import MeteredJournalingAdapter, ModelAdapter
from strive.model_proposer import ModelProposer, validate_prompt_template
from strive.policy import get_policy
from strive.promptgate import (
    PromptComparisonEvidence,
    compare_templates,
    make_visible_context,
    prompt_gate_decision,
)
from strive.propose import ProposalRequest, screen_source, screen_surface_update
from strive.revisions import HarnessRevision, ScopeManifest
from strive.sandboxes import CandidateExecutor, SandboxLimits
from strive.store import Store
from strive.contracts import VISIBLE
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK

EXPERIMENT_BUDGET = BudgetSpec(model_calls=6, executions=24)
EXPERIMENT_MAX_TOKENS = 2048
SANDBOX_TIMEOUT_S = 10.0

# The controlled variable. Both templates are valid prompt artifacts; the
# ONLY relevant difference is which failing-case placeholder they include.
# Neither contains hidden cases nor any strategy code.
INCUMBENT_TEMPLATE = """\
[experiment-template:incumbent@1]
You are the proposal component of a gated self-evolution harness. Propose one
bounded improvement to the strategy below. It will be executed in a sandbox
and accepted only if it strictly improves evaluation with zero regressions.

## Task
id: {task_id}
description: {task_description}
required signature: {task_signature}
allowed imports (all others are rejected): {catalog}

## Incumbent strategy (generation {parent_generation_id})
```python
{parent_source}
```

## Diagnosis
weakness: {weakness_id}
{diagnosis_description}

## Visible failing cases (ids and feedback only)
{failing_case_ids}

## Prior proposal history
{history}

## Budgets
max output tokens: {max_output_tokens}; model calls remaining:
{model_calls_remaining}; executions remaining: {executions_remaining}

## Required output
Reply with ONLY a JSON object (no prose, no code fences) with exactly these
keys: "parent_generation_id" (echo "{parent_generation_id}"), "summary",
"rationale", "trace_evidence" (array of failing case ids), "expected_outcome",
"source" (COMPLETE replacement source implementing {task_signature}),
"changed_surfaces", "risks", "assumptions", and optionally "prompt_update"
(complete replacement text for this template; then changed_surfaces must be
["prompt", "strategy-code"]).
"""

CANDIDATE_TEMPLATE = INCUMBENT_TEMPLATE.replace(
    "[experiment-template:incumbent@1]", "[experiment-template:candidate@1]"
).replace(
    "## Visible failing cases (ids and feedback only)\n{failing_case_ids}",
    "## Visible failing cases (include and analyze the actual input text "
    "before proposing)\n{failing_cases}",
)


@dataclass(frozen=True)
class ArmResult:
    arm: str
    description: str
    proposal_valid: bool | None  # None: no proposal stage in this arm
    failure_kind: str | None
    accepted: bool | None
    candidate_overall: float | None
    candidate_split_scores: dict[str, float] = field(default_factory=dict)
    regressed_cases: int = 0
    executions: int = 0
    model_calls: int = 0
    tokens: int = 0
    latency_ms: float | None = None
    cost: float | None = None
    prompt_ref: str | None = None
    prompt_source: str | None = None
    prompt_contained_input_excerpts: bool | None = None
    revision_id: str | None = None
    lifecycle_head: str = ""
    budget_model_calls: int = 0
    budget_max_tokens: int = 0
    notes: str = ""


@dataclass(frozen=True)
class TwoStageResult:
    """The self-produced composite's identity chain and gate verdicts."""

    proposed_revision_id: str  # named when the composite is BUILT (pre-eval)
    retained_revision_id: str
    activated_revision_id: str | None
    prompt_ref: str  # p1 (self-produced)
    source_ref: str  # s1 (generated under p1 in a fresh call)
    task_accepted: bool
    prompt_improved: bool
    composite_accepted: bool
    restart_serves_p1: bool
    replay_matches: bool
    rollback_restores_incumbent: bool


@dataclass(frozen=True)
class ExperimentReport:
    arms: dict[str, ArmResult]
    two_stage: TwoStageResult | None
    causal_prompt_effect: bool
    prompt_consumed: bool
    matched_configuration: bool
    offline: bool  # True = deterministic fixture (pipeline wiring, not capability)

    @property
    def passed(self) -> bool:
        a, b = self.arms.get("A"), self.arms.get("B")
        return bool(
            a is not None and b is not None
            and a.proposal_valid is True and b.proposal_valid is True
            and a.accepted is False and b.accepted is True
            and self.matched_configuration
            and self.prompt_consumed
            and self.causal_prompt_effect
            and self.two_stage is not None
            and self.two_stage.composite_accepted
            and self.two_stage.proposed_revision_id
            == self.two_stage.retained_revision_id
            == self.two_stage.activated_revision_id
            and self.two_stage.restart_serves_p1
            and self.two_stage.replay_matches
            and self.two_stage.rollback_restores_incumbent
        )


def _config(adapter: ModelAdapter) -> LoopConfig:
    """One matched configuration for every arm."""
    return LoopConfig(
        sandbox_timeout_s=SANDBOX_TIMEOUT_S,
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter,
        budget=EXPERIMENT_BUDGET,
        model_max_tokens=EXPERIMENT_MAX_TOKENS,
    )


def _activate_prompt_only(store: Store, template: str, label: str) -> str:
    """Install a prompt template as an arm's INITIAL CONDITION via a
    journaled operator override (prompt-only changes cannot pass the
    execution-scored gate, and arm setup is not claimed as evolution)."""
    reason = validate_prompt_template(template)
    if reason is not None:
        raise lifecycle.LifecycleError(f"experiment template invalid: {reason}")
    ensure_seeded(store, TASK)
    baseline = lifecycle.active_revision_id(store)
    assert baseline is not None
    resolved = lifecycle.materialize_active(store)
    assert resolved is not None
    revision, _ref = lifecycle.compose_revision(
        store,
        revision_id=f"rev-exp-prompt-{label}",
        base_parent_id=baseline,
        parent_manifest_bindings=resolved.effective,
        surfaces={("prompt", "proposal-template"): template},
        proposer="experiment@1",
        summary=f"experiment prompt install ({label})",
        task_fingerprint=TASK.fingerprint(),
    )
    active_generation = store.active_generation()
    assert active_generation is not None
    lifecycle.retain(
        store,
        revision,
        task_fingerprint=TASK.fingerprint(),
        generation_id=active_generation.generation_id,
    )
    lifecycle.run_activation_op(
        store,
        revision.ref.revision_id,
        reason="promote",
        policy_ref="experiment@1",
        override_reason=f"experiment arm setup: install {label} prompt template",
    )
    _text, ref, _revision, source = resolve_active_prompt(store)
    assert source == "revision"
    return ref


def _model_call_metrics(
    store: Store, run_id: str
) -> tuple[int, int, float | None, str | None]:
    """(model_calls, tokens, latency_ms, journaled_prompt_text) from events."""
    events = EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all()
    calls = [e for e in events if e.type == "model_call"]
    tokens = 0
    latency: float | None = None
    prompt_text: str | None = None
    for event in calls:
        usage = event.payload.get("usage")
        if isinstance(usage, dict):
            tokens += int(usage.get("input_tokens", 0) or 0)
            tokens += int(usage.get("output_tokens", 0) or 0)
        latency_value = event.payload.get("latency_ms")
        if isinstance(latency_value, (int, float)):
            latency = float(latency_value)
        prompt_ref = event.payload.get("prompt_ref")
        if isinstance(prompt_ref, str) and prompt_text is None:
            prompt_text = store.objects.get_text(prompt_ref)
    return len(calls), tokens, latency, prompt_text


def _run_executions(store: Store, run_id: str) -> int:
    cycle = next(c for c in store.cycles() if c.run_id == run_id)
    return cycle.usage.executions


def _cycle_arm(
    root: Path, arm: str, description: str, template: str, adapter: ModelAdapter
) -> tuple[ArmResult, Store]:
    """One live-cycle arm: fresh baseline, install the arm's prompt, run one
    matched cycle, record what the proposer did and what the gate decided."""
    store = Store(root / arm, TASK.task_id)
    prompt_ref = _activate_prompt_only(store, template, arm)
    config = _config(adapter)
    report = run_cycle(store, TASK, config)
    calls, tokens, latency, prompt_text = _model_call_metrics(store, report.run_id)
    decision = report.decision
    candidate_eval = report.candidate_evaluation
    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    overlay_events = [e for e in events if e.type == "candidate_overlay"]
    revision_id: str | None = None
    if overlay_events:
        overlay_revision: HarnessRevision = codec.loads(
            store.objects.get_text(str(overlay_events[0].payload["revision_ref"])),
            HarnessRevision,
        )
        revision_id = overlay_revision.ref.revision_id
    result = ArmResult(
        arm=arm,
        description=description,
        proposal_valid=report.proposal is not None,
        failure_kind=(
            report.proposal_failure.kind if report.proposal_failure else None
        ),
        accepted=decision.accepted if decision else None,
        candidate_overall=(candidate_eval.overall_score if candidate_eval else None),
        candidate_split_scores=(
            dict(candidate_eval.split_scores) if candidate_eval else {}
        ),
        regressed_cases=(len(decision.regressed_case_ids) if decision else 0),
        executions=_run_executions(store, report.run_id),
        model_calls=calls,
        tokens=tokens,
        latency_ms=latency,
        cost=None,  # the deterministic fake reports no trustworthy cost
        prompt_ref=prompt_ref,
        prompt_source="revision",
        prompt_contained_input_excerpts=(
            ("input=" in prompt_text) if prompt_text is not None else None
        ),
        revision_id=revision_id,
        lifecycle_head=lifecycle.state(store).head,
        budget_model_calls=config.budget.model_calls,
        budget_max_tokens=config.model_max_tokens,
    )
    return result, store


def _gate_executor(
    backend: str = "process-fault-only@1", *, trusted: bool = True
) -> "CandidateExecutor":
    """The experiment's execution service. The OFFLINE experiment is a
    deterministic pipeline-wiring proof over a scripted fixture (trusted,
    author-written strategy source), so it uses the fault-only boundary;
    real-model arms pass a secure backend."""
    from strive.sandboxes import CandidateExecutor, default_catalog

    return CandidateExecutor.from_catalog(
        default_catalog(), backend, trusted=trusted
    )


def _metered_gate(
    store: Store,
    meter: BudgetMeter,
    baseline_source: str,
    candidate_source: str,
    executor: "CandidateExecutor | None" = None,
) -> tuple[Decision, Evaluation, Evaluation, int]:
    """Task-gate evaluation through the normal metered execution path.
    Returns (decision, baseline_evaluation, candidate_evaluation,
    executions_used)."""
    exec_service = executor or _gate_executor()
    cases = TASK.selection_cases()
    executions = 0
    evaluations = []
    for label, source in (("baseline", baseline_source), ("candidate", candidate_source)):
        denial = meter.request_execution()
        if denial is not None:
            raise RuntimeError(f"experiment budget denied execution: {denial.detail}")
        executions += 1
        outcome = exec_service.execute_suite(
            source,
            cases,
            generation_id=f"gate-{label}",
            limits=_gate_limits(meter),
        )
        meter.note_output_bytes(outcome.report.stdout_bytes)
        evaluations.append(evaluate(TASK, outcome.report, cases))
    policy = get_policy("paired-deterministic")
    decision = policy.decide(evaluations[0], evaluations[1])
    return decision, evaluations[0], evaluations[1], executions


def _gate_limits(meter: BudgetMeter) -> "SandboxLimits":
    from strive.sandboxes import SandboxLimits

    return SandboxLimits(
        wall_time_s=meter.execution_timeout_s(SANDBOX_TIMEOUT_S),
        output_bytes=meter.execution_output_cap(),
    )


def _ablation_arm(
    root: Path,
    arm: str,
    description: str,
    surfaces: dict[tuple[str, str], str],
) -> tuple[ArmResult, Store, str, str]:
    """One harness-built ablation arm (C/D): compose the composite on the
    fresh baseline (incumbent prompt active), task-gate its strategy through
    the metered path, and record the selection. Ablations isolate surface
    effects; they are never claimed as evolution."""
    store = Store(root / arm, TASK.task_id)
    _activate_prompt_only(store, INCUMBENT_TEMPLATE, arm)
    baseline = lifecycle.active_revision_id(store)
    assert baseline is not None
    resolved = lifecycle.materialize_active(store)
    assert resolved is not None
    revision, _ref = lifecycle.compose_revision(
        store,
        revision_id=f"rev-exp-{arm}",
        base_parent_id=baseline,
        parent_manifest_bindings=resolved.effective,
        surfaces=surfaces,
        proposer="experiment@1",
        summary=description,
        task_fingerprint=TASK.fingerprint(),
    )
    code = surfaces.get(("strategy-code", "solve"))
    active_generation = store.active_generation()
    assert active_generation is not None
    if code is not None:
        generation = store.add_generation(
            code,
            task_fingerprint=TASK.fingerprint(),
            parent_id=active_generation.generation_id,
            origin="manual",
            surface="strategy-code",
            weakness_id=None,
            decision=None,
        )
        generation_id = generation.generation_id
    else:
        generation_id = active_generation.generation_id
    lifecycle.retain(
        store, revision, task_fingerprint=TASK.fingerprint(),
        generation_id=generation_id,
    )
    meter = BudgetMeter(EXPERIMENT_BUDGET)
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    candidate_source = next(
        store.objects.get_text(b.binding.content_ref)
        for b in manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    decision, baseline_eval, candidate_eval, executions = _metered_gate(
        store, meter, store.source_of(active_generation), candidate_source
    )
    overall = candidate_eval.overall_score
    splits = dict(candidate_eval.split_scores)
    provenance = selection_mod.pin_execution_provenance(
        store,
        subject_revision_id=revision.ref.revision_id,
        operation="experiment-arm",
        detail="experiment ablation arm (metered gate)",
    )
    recorded = selection_mod.record_assessment(
        store, TASK,
        revision_id=revision.ref.revision_id,
        baseline_revision_id=baseline,
        baseline_evaluation=baseline_eval,
        candidate_evaluation=candidate_eval,
        decision=decision,
        policy_ref="paired-deterministic@1",
        scope_manifest_ref=revision.scope_manifest_ref,
        provenance=provenance,
        usage=meter.usage(),
        budget=EXPERIMENT_BUDGET,
    )
    result = ArmResult(
        arm=arm,
        description=description,
        proposal_valid=None,  # harness-built ablation: no proposal stage
        failure_kind=None,
        accepted=decision.accepted,
        candidate_overall=overall,
        candidate_split_scores=splits,
        regressed_cases=len(decision.regressed_case_ids),
        executions=executions,
        model_calls=0,
        tokens=0,
        latency_ms=None,
        cost=None,
        prompt_ref=None,
        prompt_source="revision",
        prompt_contained_input_excerpts=None,
        revision_id=revision.ref.revision_id,
        lifecycle_head=lifecycle.state(store).head,
        budget_model_calls=EXPERIMENT_BUDGET.model_calls,
        budget_max_tokens=EXPERIMENT_MAX_TOKENS,
    )
    return result, store, revision.ref.revision_id, recorded.decision_ref


def _two_stage_arm(
    root: Path, adapter: ModelAdapter
) -> tuple[ArmResult, TwoStageResult, Store]:
    """The self-produced composite (arm E): the proposer proposes prompt p1
    under the incumbent template; p1 generates strategy s1 in a fresh
    fixed-budget call; the immutable p1+s1 revision is built BEFORE
    evaluation and must earn BOTH the task gate (code) and the trusted
    prompt gate (prompt) to activate."""
    store = Store(root / "arm-e", TASK.task_id)
    _activate_prompt_only(store, INCUMBENT_TEMPLATE, "arm-e")
    baseline = lifecycle.active_revision_id(store)
    assert baseline is not None
    active_generation = store.active_generation()
    assert active_generation is not None
    incumbent_text, incumbent_ref, _rev, _src = resolve_active_prompt(store)

    meter = BudgetMeter(EXPERIMENT_BUDGET)
    events = EventLog(store.runs_dir / "exp-two-stage" / "events.jsonl", "exp-two-stage")
    model = MeteredJournalingAdapter(adapter, meter, events, store.objects)
    gate_executor = _gate_executor()
    ctx, diagnosis = make_visible_context(
        TASK, active_generation.generation_id, store.source_of(active_generation),
        gate_executor,
    )
    assert diagnosis is not None
    request = ProposalRequest(
        ctx=ctx,
        diagnosis=diagnosis,
        task_description=TASK.description,
        task_signature=TASK.signature,
        primitive_catalog=TASK.primitive_catalog,
        history=(),
        max_output_tokens=EXPERIMENT_MAX_TOKENS,
        model_calls_remaining=EXPERIMENT_BUDGET.model_calls - 1,
        executions_remaining=EXPERIMENT_BUDGET.executions,
        model=model,
        prompt_template=incumbent_text,
        prompt_ref=incumbent_ref,
        lifecycle_head=lifecycle.state(store).head,
    )
    hidden = tuple(
        value
        for case in TASK.cases
        if case.split != VISIBLE
        for value in (case.input_text, case.case_id)
    )

    # -- stage 1: the incumbent proposer proposes prompt p1 ----------------
    stage1 = ModelProposer().propose(request)
    if stage1.proposal is None or not stage1.proposal.surface_updates:
        raise RuntimeError(
            "two-stage arm: stage 1 produced no prompt proposal "
            f"({stage1.failure.kind if stage1.failure else 'no update'})"
        )
    p1_update = stage1.proposal.surface_updates[0]
    screen = screen_surface_update(p1_update, hidden)
    if screen is not None:
        raise RuntimeError(f"two-stage arm: p1 rejected by screen: {screen.detail}")
    p1 = p1_update.content
    p1_ref = store.objects.put_text(p1)

    # -- stage 2: p1 generates strategy s1 in a fresh, fixed-budget call ---
    stage2_request = dataclasses.replace(
        request, prompt_template=p1, prompt_ref=p1_ref
    )
    stage2 = ModelProposer().propose(stage2_request)
    if stage2.proposal is None:
        raise RuntimeError(
            "two-stage arm: stage 2 produced no strategy "
            f"({stage2.failure.kind if stage2.failure else '?'})"
        )
    s1 = stage2.proposal.source
    if screen_source(s1, TASK.primitive_catalog) is not None:
        raise RuntimeError("two-stage arm: s1 rejected by the source screen")
    s1_ref = store.objects.put_text(s1)

    # -- the immutable p1+s1 revision, built BEFORE evaluation --------------
    resolved = lifecycle.materialize_active(store)
    assert resolved is not None
    revision, _rref = lifecycle.compose_revision(
        store,
        revision_id="rev-cand-two-stage",
        base_parent_id=baseline,
        parent_manifest_bindings=resolved.effective,
        surfaces={
            ("strategy-code", "solve"): s1,
            ("prompt", "proposal-template"): p1,
        },
        proposer="model@0",
        summary="self-produced two-stage composite (p1 -> s1)",
        task_fingerprint=TASK.fingerprint(),
        origin="candidate-overlay",
    )
    proposed_id = revision.ref.revision_id
    generation = store.add_generation(
        s1,
        task_fingerprint=TASK.fingerprint(),
        parent_id=active_generation.generation_id,
        origin="evolved",
        surface="strategy-code",
        weakness_id=None,
        decision=None,
    )
    lifecycle.retain(
        store, revision, task_fingerprint=TASK.fingerprint(),
        generation_id=generation.generation_id,
    )

    # -- evidence: the task gate (code) AND the prompt gate (prompt) --------
    task_decision, baseline_eval, candidate_eval, executions = _metered_gate(
        store, meter, store.source_of(active_generation), s1, gate_executor
    )
    overall = candidate_eval.overall_score
    splits = dict(candidate_eval.split_scores)
    prompt_evidence, prompt_evidence_ref = compare_templates(
        store, TASK,
        incumbent_template=incumbent_text,
        candidate_template=p1,
        request=request,
        model=model,
        adapter_name=type(adapter).__name__,
        executor=gate_executor,
    )
    composite_decision = prompt_gate_decision(task_decision, prompt_evidence)
    provenance = selection_mod.pin_execution_provenance(
        store,
        subject_revision_id=proposed_id,
        operation="experiment-two-stage",
        detail="two-stage self-produced composite (metered gate)",
    )
    recorded = selection_mod.record_assessment(
        store, TASK,
        revision_id=proposed_id,
        baseline_revision_id=baseline,
        baseline_evaluation=baseline_eval,
        candidate_evaluation=candidate_eval,
        decision=composite_decision,
        policy_ref="prompt-comparison@1",
        scope_manifest_ref=revision.scope_manifest_ref,
        provenance=provenance,
        usage=meter.usage(),
        budget=EXPERIMENT_BUDGET,
        prompt_evidence_ref=prompt_evidence_ref,
        prompt_improved=prompt_evidence.improved,
    )
    lifecycle.record_surface_evidence(
        store, proposed_id,
        surface="prompt",
        evidence_ref=prompt_evidence_ref,
        improved=prompt_evidence.improved,
        bundle_ref=recorded.prompt_bundle_ref,
    )

    activated: str | None = None
    restart_ok = False
    replay_ok = False
    rollback_ok = False
    if composite_decision.accepted:
        # activation cites the exact SelectionDecision envelope
        lifecycle.run_activation_op(
            store, proposed_id,
            reason="promote",
            policy_ref="prompt-comparison@1",
            decision_ref=recorded.selection_ref,
        )
        activated = lifecycle.active_revision_id(store)
        # restart: a fresh process resolves p1 from the manifest
        reopened = Store(store.root, TASK.task_id)
        text, ref, revision_seen, source = resolve_active_prompt(reopened)
        restart_ok = source == "revision" and ref == p1_ref and text == p1
        # replay: re-evaluate the EXACT retained artifacts and re-check the
        # recorded composite decision
        replay_ok = _replay_composite(reopened, proposed_id, recorded.decision_ref)
        # rollback: the incumbent prompt AND baseline code come back together
        lifecycle.rollback(reopened)
        text_after, _r2, _rev2, source_after = resolve_active_prompt(reopened)
        projection = lifecycle.compatibility_projection(reopened)
        served = reopened.active_generation()
        rollback_ok = (
            source_after == "revision"
            and text_after == incumbent_text
            and projection is not None
            and served is not None
            and projection.strategy_source_ref == served.source_ref
            and lifecycle.compat_parity(reopened).ok
        )

    st = lifecycle.state(store)
    calls = meter.usage().model_calls
    arm = ArmResult(
        arm="E",
        description="two-stage self-produced prompt+code composite (p1 -> s1)",
        proposal_valid=True,
        failure_kind=None,
        accepted=composite_decision.accepted,
        candidate_overall=overall,
        candidate_split_scores=splits,
        regressed_cases=len(task_decision.regressed_case_ids),
        executions=executions,
        model_calls=calls,
        tokens=0,
        latency_ms=None,
        cost=None,
        prompt_ref=p1_ref,
        prompt_source="revision",
        prompt_contained_input_excerpts="input=" in p1.replace("{failing_cases}", "input="),
        revision_id=proposed_id,
        lifecycle_head=st.head,
        budget_model_calls=EXPERIMENT_BUDGET.model_calls,
        budget_max_tokens=EXPERIMENT_MAX_TOKENS,
        notes="both surfaces gated on their own evidence",
    )
    two_stage = TwoStageResult(
        proposed_revision_id=proposed_id,
        retained_revision_id=(
            proposed_id if proposed_id in st.retained else "(missing)"
        ),
        activated_revision_id=activated,
        prompt_ref=p1_ref,
        source_ref=s1_ref,
        task_accepted=task_decision.accepted,
        prompt_improved=prompt_evidence.improved,
        composite_accepted=composite_decision.accepted,
        restart_serves_p1=restart_ok,
        replay_matches=replay_ok,
        rollback_restores_incumbent=rollback_ok,
    )
    return arm, two_stage, store


def _replay_composite(store: Store, revision_id: str, decision_ref: str) -> bool:
    """Execution-and-decision replay of the composite: re-run the EXACT
    retained baseline and candidate artifacts from CAS and check the
    recorded composite decision's task component reproduces."""
    st = lifecycle.state(store)
    record = st.retained[revision_id]
    revision: HarnessRevision = codec.loads(
        store.objects.get_text(record.revision_ref), HarnessRevision
    )
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    candidate_source = next(
        store.objects.get_text(b.binding.content_ref)
        for b in manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    assert record.base_parent_id is not None
    parent = st.retained[record.base_parent_id]
    parent_revision: HarnessRevision = codec.loads(
        store.objects.get_text(parent.revision_ref), HarnessRevision
    )
    parent_manifest: ScopeManifest = codec.loads(
        store.objects.get_text(parent_revision.scope_manifest_ref), ScopeManifest
    )
    baseline_source = next(
        store.objects.get_text(b.binding.content_ref)
        for b in parent_manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    cases = TASK.selection_cases()
    executor = _gate_executor()
    baseline_eval = evaluate(
        TASK,
        executor.execute_suite(
            baseline_source, cases, generation_id="replay-b"
        ).report,
        cases,
    )
    candidate_eval = evaluate(
        TASK,
        executor.execute_suite(
            candidate_source, cases, generation_id="replay-c"
        ).report,
        cases,
    )
    policy = get_policy("paired-deterministic")
    replayed = policy.decide(baseline_eval, candidate_eval)
    recorded: Decision = codec.loads(store.objects.get_text(decision_ref), Decision)
    return (
        replayed.accepted == recorded.accepted
        and replayed.baseline_score == recorded.baseline_score
        and replayed.candidate_score == recorded.candidate_score
    )


@dataclass(frozen=True)
class ExperimentManifest:
    """Everything needed to reproduce (or audit) one experiment run."""

    task_id: str
    task_fingerprint: str
    incumbent_template_ref: str
    candidate_template_ref: str
    adapter: str
    seed: str  # the determinism claim for the adapter
    budget_model_calls: int
    budget_executions: int
    max_output_tokens: int
    sandbox_timeout_s: float
    arm_order: tuple[str, ...]
    lifecycle_heads: dict[str, str]
    outcomes: dict[str, str]
    created_at: str


def run_prompt_experiment(
    root: Path, adapter_factory: "object" = None
) -> ExperimentReport:
    """The deterministic offline experiment (module docstring). `root` must
    be a fresh directory — reuse is refused so every run's artifacts and
    manifest stay unambiguous."""
    if root.exists() and any(root.iterdir()):
        raise RuntimeError(
            f"experiment directory {root} already contains a run; use a "
            "fresh directory (reuse is refused for reproducibility)"
        )
    root.mkdir(parents=True, exist_ok=True)
    factory = adapter_factory or prompt_sensitive_adapter
    arms: dict[str, ArmResult] = {}

    result_a, store_a = _cycle_arm(
        root, "arm-a",
        "incumbent prompt (ids+feedback only): proposer misses the signs",
        INCUMBENT_TEMPLATE, factory(),  # type: ignore[operator]
    )
    arms["A"] = result_a
    result_b, _store_b = _cycle_arm(
        root, "arm-b",
        "candidate prompt (input excerpts): proposer fixes the signs",
        CANDIDATE_TEMPLATE, factory(),  # type: ignore[operator]
    )
    arms["B"] = result_b
    result_c, _store_c, _rev_c, _dec_c = _ablation_arm(
        root, "arm-c", "prompt-only ablation (code unchanged)",
        {("prompt", "proposal-template"): CANDIDATE_TEMPLATE},
    )
    arms["C"] = result_c
    result_d, _store_d, _rev_d, _dec_d = _ablation_arm(
        root, "arm-d", "code-only ablation (prompt unchanged)",
        {("strategy-code", "solve"): SIGNED_SUM_FIX},
    )
    arms["D"] = result_d
    result_e, two_stage, store_e = _two_stage_arm(root, factory())  # type: ignore[operator]
    arms["E"] = result_e

    causal = (
        arms["A"].proposal_valid is True
        and arms["B"].proposal_valid is True
        and arms["A"].accepted is False
        and arms["B"].accepted is True
        and arms["A"].prompt_contained_input_excerpts is False
        and arms["B"].prompt_contained_input_excerpts is True
    )
    matched = (
        len({(r.budget_model_calls, r.budget_max_tokens) for r in arms.values()}) == 1
    )
    manifest = ExperimentManifest(
        task_id=TASK.task_id,
        task_fingerprint=TASK.fingerprint(),
        incumbent_template_ref=store_a.objects.put_text(INCUMBENT_TEMPLATE),
        candidate_template_ref=store_a.objects.put_text(CANDIDATE_TEMPLATE),
        adapter=type(factory()).__name__,  # type: ignore[operator]
        seed="deterministic-fixture (responder is a pure function of the prompt)",
        budget_model_calls=EXPERIMENT_BUDGET.model_calls,
        budget_executions=EXPERIMENT_BUDGET.executions,
        max_output_tokens=EXPERIMENT_MAX_TOKENS,
        sandbox_timeout_s=SANDBOX_TIMEOUT_S,
        arm_order=tuple(arms),
        lifecycle_heads={arm: r.lifecycle_head for arm, r in arms.items()},
        outcomes={
            arm: ("accepted" if r.accepted else "rejected") for arm, r in arms.items()
        },
        created_at=now_iso(),
    )
    (root / "manifest.json").write_text(
        json.dumps(dataclasses.asdict(manifest), indent=2, sort_keys=True)
    )
    del store_e
    return ExperimentReport(
        arms=arms,
        two_stage=two_stage,
        causal_prompt_effect=causal,
        prompt_consumed=bool(arms["B"].prompt_contained_input_excerpts),
        matched_configuration=matched,
        offline=True,
    )


@dataclass(frozen=True)
class RealModelArmReport:
    model_id: str
    arm: str
    trials: int  # single-trial results are labeled exactly that
    proposal_valid: bool
    failure_kind: str | None
    accepted: bool | None
    model_calls: int
    tokens: int
    latency_ms: float | None
    cost: float | None
    parameters: str
    notes: str


def run_real_model_arms(root: Path) -> tuple[RealModelArmReport, ...]:
    """Opt-in real-model version of arms A and B (env-configured adapter).

    SINGLE-TRIAL results: one paired run per arm, labeled as such — no
    capability claim follows from n=1; repeated paired trials are needed for
    that. Runs generation-native only (`unsafe_model_code=True`); artifacts
    and model I/O are journaled in each arm's store."""
    from strive.model import adapter_from_env

    if root.exists() and any(root.iterdir()):
        raise RuntimeError(
            f"experiment directory {root} already contains a run; use a "
            "fresh directory (reuse is refused for reproducibility)"
        )
    adapter = adapter_from_env()
    if adapter is None:
        raise RuntimeError(
            "no real model configured; set STRIVE_MODEL_PROVIDER etc. "
            "(see strive.model.adapter_from_env)"
        )
    reports: list[RealModelArmReport] = []
    for arm, template in (("A", INCUMBENT_TEMPLATE), ("B", CANDIDATE_TEMPLATE)):
        store = Store(root / f"real-arm-{arm.lower()}", TASK.task_id)
        _activate_prompt_only(store, template, f"real-{arm.lower()}")
        config = _config(adapter)
        config.unsafe_model_code = True
        # real model-authored code MUST run under a secure backend; the
        # executor refuses fault-only for untrusted code
        config.sandbox_backend = "deno-pyodide@1"
        report = run_cycle(store, TASK, config)
        calls, tokens, latency, _prompt = _model_call_metrics(store, report.run_id)
        reports.append(
            RealModelArmReport(
                model_id=getattr(adapter, "model_id", "unknown"),
                arm=arm,
                trials=1,
                proposal_valid=report.proposal is not None,
                failure_kind=(
                    report.proposal_failure.kind if report.proposal_failure else None
                ),
                accepted=report.decision.accepted if report.decision else None,
                model_calls=calls,
                tokens=tokens,
                latency_ms=latency,
                cost=None,
                parameters=(
                    f"max_tokens={EXPERIMENT_MAX_TOKENS} "
                    f"budget_model_calls={EXPERIMENT_BUDGET.model_calls}"
                ),
                notes=(
                    "SINGLE-TRIAL (n=1; no capability claim). "
                    "generation-native only (unsafe model code: lifecycle "
                    "authority refused); artifacts + model I/O journaled in "
                    f"{store.root}"
                ),
            )
        )
    return tuple(reports)


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all())
