"""The trusted prompt validator: surface-specific evidence for prompt deltas.

A prompt delta must never be promoted merely because the strategy code
bundled with it improves task scores. This module produces the
prompt-specific evidence: it runs the PROPOSER under the candidate and the
incumbent templates with the same adapter, context, parameters, and budgets
(matched pairs), evaluates each template's proposed strategy under the same
trusted paired task gate, and records proposal validity, the selected
source, calls/tokens/cost, and regressions per template. The verdict is an
objective ordering over proposer outcomes:

    (gate_accepted, proposal_valid, -regressed_cases)

`improved` is True only when the candidate template's tuple strictly
dominates the incumbent's. The comparison charges the caller's trusted
budget meter (the same metering as every model call) and its evidence is
CAS-stored and linked to the exact candidate revision via
`lifecycle.record_surface_evidence` — separate from the task-execution
evidence, so neither surface can piggyback on the other's record.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive import codec
from strive.codec import register
from strive.contracts import Decision, Diagnosis
from strive.diagnose import VisibleContext
from strive.evaluate import evaluate
from strive.events import now_iso
from strive.model import CompletingAdapter
from strive.policy import get_policy
from strive.propose import ProposalRequest, screen_source
from strive.sandbox import run_strategy
from strive.store import Store
from strive.tasks import Task


@register("prompt-template-outcome", 1)
@dataclass(frozen=True)
class TemplateOutcome:
    """What the proposer did under ONE template (matched conditions)."""

    template_ref: str
    proposal_valid: bool
    failure_kind: str | None
    source_ref: str | None  # the proposed strategy, CAS-stored
    gate_accepted: bool
    candidate_score: float | None
    regressed_cases: int
    model_calls: int
    tokens: int
    cost: float | None


@register("prompt-comparison", 1)
@dataclass(frozen=True)
class PromptComparisonEvidence:
    """The trusted prompt-vs-prompt comparison, CAS-stored and linked to the
    exact candidate revision. `improved` is the surface-specific verdict a
    composite's prompt delta must earn to activate."""

    incumbent: TemplateOutcome
    candidate: TemplateOutcome
    adapter: str
    policy_ref: str
    improved: bool
    detail: str
    at: str


def _outcome_tuple(outcome: TemplateOutcome) -> tuple[int, int, int]:
    return (
        1 if outcome.gate_accepted else 0,
        1 if outcome.proposal_valid else 0,
        -outcome.regressed_cases,
    )


def _run_template(
    store: Store,
    task: Task,
    template: str,
    request: ProposalRequest,
    model: CompletingAdapter,
) -> TemplateOutcome:
    """One matched trial: propose under `template`, then evaluate the proposed
    strategy under the trusted paired gate. Every model call goes through the
    caller-supplied METERED handle; sandbox executions use the task's normal
    evaluation path."""
    import dataclasses

    from strive.model_proposer import ModelProposer

    template_ref = store.objects.put_text(template)
    trial_request = dataclasses.replace(
        request, prompt_template=template, prompt_ref=template_ref, model=model
    )
    result = ModelProposer().propose(trial_request)
    calls, tokens, cost = 1, 0, None
    if result.failure is not None:
        return TemplateOutcome(
            template_ref=template_ref,
            proposal_valid=False,
            failure_kind=result.failure.kind,
            source_ref=None,
            gate_accepted=False,
            candidate_score=None,
            regressed_cases=0,
            model_calls=calls,
            tokens=tokens,
            cost=cost,
        )
    assert result.proposal is not None
    screen = screen_source(result.proposal.source, task.primitive_catalog)
    if screen is not None:
        return TemplateOutcome(
            template_ref=template_ref,
            proposal_valid=False,
            failure_kind=screen.kind,
            source_ref=None,
            gate_accepted=False,
            candidate_score=None,
            regressed_cases=0,
            model_calls=calls,
            tokens=tokens,
            cost=cost,
        )
    source_ref = store.objects.put_text(result.proposal.source)
    cases = task.selection_cases()
    baseline_eval = evaluate(
        task,
        run_strategy(request.ctx.parent_source, cases, generation_id="gate-baseline"),
        cases,
    )
    candidate_eval = evaluate(
        task,
        run_strategy(result.proposal.source, cases, generation_id="gate-candidate"),
        cases,
    )
    policy = get_policy("paired-deterministic")
    decision: Decision = policy.decide(baseline_eval, candidate_eval)
    return TemplateOutcome(
        template_ref=template_ref,
        proposal_valid=True,
        failure_kind=None,
        source_ref=source_ref,
        gate_accepted=decision.accepted,
        candidate_score=candidate_eval.overall_score,
        regressed_cases=len(decision.regressed_case_ids),
        model_calls=calls,
        tokens=tokens,
        cost=cost,
    )


def compare_templates(
    store: Store,
    task: Task,
    *,
    incumbent_template: str,
    candidate_template: str,
    request: ProposalRequest,
    model: CompletingAdapter,
    adapter_name: str,
) -> tuple[PromptComparisonEvidence, str]:
    """The trusted prompt-vs-prompt comparison under matched conditions.
    Returns (evidence, CAS ref). Charges the caller's metered model handle
    (two proposer calls) and the sandbox (four gate executions)."""
    incumbent = _run_template(store, task, incumbent_template, request, model)
    candidate = _run_template(store, task, candidate_template, request, model)
    improved = _outcome_tuple(candidate) > _outcome_tuple(incumbent)
    detail = (
        f"candidate {_outcome_tuple(candidate)} vs incumbent "
        f"{_outcome_tuple(incumbent)} on (gate_accepted, proposal_valid, "
        "-regressions)"
    )
    evidence = PromptComparisonEvidence(
        incumbent=incumbent,
        candidate=candidate,
        adapter=adapter_name,
        policy_ref="prompt-comparison@1",
        improved=improved,
        detail=detail,
        at=now_iso(),
    )
    return evidence, store.objects.put_text(codec.dumps(evidence))


def prompt_gate_decision(
    task_decision: Decision, evidence: PromptComparisonEvidence
) -> Decision:
    """The composite-promotion verdict when a prompt delta rides along: the
    task decision gates the CODE; this gates the COMPOSITE. Accepted only
    when both the task evidence and the prompt evidence pass."""
    accepted = task_decision.accepted and evidence.improved
    if accepted:
        reason = (
            "code passes the task gate AND the prompt improves proposer "
            f"behavior under the trusted comparison ({evidence.detail})"
        )
    elif not task_decision.accepted:
        reason = f"code fails the task gate: {task_decision.reason}"
    else:
        reason = (
            "code passes the task gate but the prompt delta shows no "
            f"surface-specific benefit ({evidence.detail}); a prompt must "
            "not piggyback on code evidence"
        )
    return Decision(
        accepted=accepted,
        reason=reason,
        policy="prompt-comparison",
        policy_version=1,
        baseline_score=task_decision.baseline_score,
        candidate_score=task_decision.candidate_score,
        baseline_split_scores=dict(task_decision.baseline_split_scores),
        candidate_split_scores=dict(task_decision.candidate_split_scores),
        regressed_case_ids=task_decision.regressed_case_ids,
    )


def make_visible_context(
    task: Task, parent_generation_id: str, parent_source: str
) -> tuple[VisibleContext, Diagnosis | None]:
    """A fresh visible-only context for template trials (used by the
    experiment's isolated stages): evaluate the parent on the visible split
    and diagnose from that evidence alone."""
    from strive.diagnose import EvidenceDiagnoser

    cases = task.visible_cases()
    evaluation = evaluate(
        task,
        run_strategy(parent_source, cases, generation_id=parent_generation_id),
        cases,
    )
    ctx = VisibleContext(
        task_id=task.task_id,
        cases=cases,
        evaluation=evaluation,
        parent_generation_id=parent_generation_id,
        parent_source=parent_source,
    )
    return ctx, EvidenceDiagnoser().diagnose(ctx)


__all__ = [
    "PromptComparisonEvidence",
    "TemplateOutcome",
    "compare_templates",
    "prompt_gate_decision",
    "make_visible_context",
]
