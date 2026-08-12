"""Stage-3C.1: the prompt-surface composite evolution experiment.

The question: does the prompt/proposal-template surface CAUSALLY change
proposer behavior through the real pipeline — resolved from the active
revision's manifest, consumed by the proposer, carried in one exact
composite candidate through the trusted gate, and restored by restart and
rollback?

Design: matched arms from the same baseline, adapter, parameters, and
budgets, differing ONLY in the controlled variable. The deterministic
`prompt_sensitive_adapter` is an instruction follower whose output is a
function of the prompt content — the INCUMBENT template withholds failing
input excerpts ({failing_case_ids}: ids + feedback only), the CANDIDATE
template surfaces them ({failing_cases}); the adapter proposes the signed
extraction fix only when the excerpts actually reach it. Both strategy
variants are author-written fixtures: the offline experiment proves CAUSAL
PIPELINE WIRING (the artifact is consumed and changes behavior), not model
capability. Genuine model-driven prompt improvement is claimed only from a
recorded real-model run (opt-in, env-configured), and a real-model failure
is an honest result.

Arms:
- A  incumbent prompt  → the proposer never sees the excerpts, proposes the
     unsigned attempt, and the gate REJECTS it (the measurable failure the
     incumbent prompt causes);
- B  candidate prompt  → same adapter/baseline/budgets, only the active
     prompt differs; the proposer sees the excerpts, proposes the signed
     fix, and the gate ACCEPTS it (causality);
- C  prompt-only ablation → evaluated under the gate: REJECTED (a prompt
     change alone cannot improve execution scores);
- D  code-only ablation   → ACCEPTED (the code change suffices for scores);
- E  prompt+code composite → ACCEPTED and ACTIVATED as one exact revision;
     restart resolves the new prompt from the manifest, rollback restores
     the incumbent prompt AND code together.

Every arm records proposal validity, per-split scores, regressions,
executions, model calls, tokens, latency, and cost (None for the fake).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from strive import codec, lifecycle
from strive.budget import BudgetMeter
from strive.contracts import BudgetSpec, Decision, Event
from strive.diagnose import EvidenceDiagnoser
from strive.evaluate import evaluate
from strive.events import EventLog
from strive.fakemodel import (
    SIGNED_SUM_FIX,
    prompt_sensitive_adapter,
)
from strive.loop import LoopConfig, ensure_seeded, resolve_active_prompt, run_cycle
from strive.model import ModelAdapter
from strive.model_proposer import ModelProposer, validate_prompt_template
from strive.policy import get_policy
from strive.revisions import HarnessRevision, ScopeManifest
from strive.sandbox import run_strategy
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK

TASK = SUM_INTEGERS_TASK

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
    notes: str = ""


@dataclass(frozen=True)
class ExperimentReport:
    arms: dict[str, ArmResult]
    causal_prompt_effect: bool  # A failed AND B passed, prompt the only delta
    composite_gate_passed: bool  # E accepted + activated
    prompt_consumed: bool  # journaled prompt bytes prove the artifact reached
    restart_serves_candidate_prompt: bool
    rollback_restores_incumbent: bool
    offline: bool  # True = deterministic fixture (pipeline wiring, not capability)

    @property
    def passed(self) -> bool:
        return (
            self.causal_prompt_effect
            and self.composite_gate_passed
            and self.prompt_consumed
            and self.restart_serves_candidate_prompt
            and self.rollback_restores_incumbent
        )


def _config(adapter: ModelAdapter) -> LoopConfig:
    """One matched configuration for every arm."""
    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=adapter,
        budget=BudgetSpec(model_calls=4),
        model_max_tokens=2048,
    )


def _activate_prompt_only(store: Store, template: str, label: str) -> str:
    """Install a prompt template as the active surface via a prompt-only
    composite revision and a journaled TrustedOverride (an explicit operator
    action: prompt-only changes cannot pass the execution-scored gate). The
    served strategy generation is unchanged. Returns the prompt's CAS ref."""
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


def _model_call_metrics(store: Store, run_id: str) -> tuple[int, int, float | None, str | None]:
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
        if isinstance(prompt_ref, str):
            prompt_text = store.objects.get_text(prompt_ref)
    return len(calls), tokens, latency, prompt_text


def _cycle_arm(
    root: Path, arm: str, description: str, template: str, adapter: ModelAdapter
) -> tuple[ArmResult, Store]:
    """One live-cycle arm: fresh baseline, install the arm's prompt, run one
    matched cycle, and record what the proposer did and what the gate decided."""
    store = Store(root / arm, TASK.task_id)
    prompt_ref = _activate_prompt_only(store, template, arm)
    report = run_cycle(store, TASK, _config(adapter))
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
        candidate_overall=(
            candidate_eval.overall_score if candidate_eval else None
        ),
        candidate_split_scores=(
            dict(candidate_eval.split_scores) if candidate_eval else {}
        ),
        regressed_cases=(
            len(decision.regressed_case_ids) if decision else 0
        ),
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
    )
    return result, store


def _run_executions(store: Store, run_id: str) -> int:
    cycle = next(c for c in store.cycles() if c.run_id == run_id)
    return cycle.usage.executions


def _evaluate_composite_arm(
    root: Path,
    arm: str,
    description: str,
    surfaces: dict[tuple[str, str], str],
) -> tuple[ArmResult, Store, str, str]:
    """One harness-built ablation arm: compose the composite on the fresh
    baseline (incumbent prompt active), evaluate its strategy under the
    trusted paired gate, and record the selection. Returns
    (result, store, revision_id, decision_ref)."""
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
    generation_id: str | None = None
    if code is not None:
        parent_generation = store.active_generation()
        assert parent_generation is not None
        generation = store.add_generation(
            code,
            task_fingerprint=TASK.fingerprint(),
            parent_id=parent_generation.generation_id,
            origin="manual",
            surface="strategy-code",
            weakness_id=None,
            decision=None,
        )
        generation_id = generation.generation_id
    else:
        active_generation = store.active_generation()
        assert active_generation is not None
        generation_id = active_generation.generation_id
    lifecycle.retain(
        store,
        revision,
        task_fingerprint=TASK.fingerprint(),
        generation_id=generation_id,
    )

    # evaluate the composite's strategy artifact against the baseline under
    # the SAME trusted paired gate the loop uses
    meter = BudgetMeter(BudgetSpec())
    del meter
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    candidate_source = next(
        store.objects.get_text(b.binding.content_ref)
        for b in manifest.bindings
        if (b.kind, b.name) == ("strategy-code", "solve")
        and b.binding.content_ref is not None
    )
    active_generation = store.active_generation()
    assert active_generation is not None
    baseline_source = store.source_of(active_generation)
    cases = TASK.selection_cases()
    baseline_eval = evaluate(
        TASK, run_strategy(baseline_source, cases, generation_id="baseline"), cases
    )
    candidate_eval = evaluate(
        TASK, run_strategy(candidate_source, cases, generation_id="candidate"), cases
    )
    policy = get_policy("paired-deterministic")
    decision: Decision = policy.decide(baseline_eval, candidate_eval)
    evaluation_ref = store.objects.put_text(codec.dumps(candidate_eval))
    decision_ref = store.objects.put_text(codec.dumps(decision))
    lifecycle.record_evaluation(
        store,
        revision.ref.revision_id,
        baseline_revision_id=baseline,
        evaluation_ref=evaluation_ref,
        manifest_ref=revision.scope_manifest_ref,
    )
    lifecycle.record_selection(
        store,
        revision.ref.revision_id,
        baseline_revision_id=baseline,
        evaluation_ref=evaluation_ref,
        decision_ref=decision_ref,
        policy_ref=f"{policy.name}@{policy.version}",
        accepted=decision.accepted,
    )
    result = ArmResult(
        arm=arm,
        description=description,
        proposal_valid=None,  # harness-built ablation: no proposal stage
        failure_kind=None,
        accepted=decision.accepted,
        candidate_overall=candidate_eval.overall_score,
        candidate_split_scores=dict(candidate_eval.split_scores),
        regressed_cases=len(decision.regressed_case_ids),
        executions=2,
        model_calls=0,
        tokens=0,
        latency_ms=None,
        cost=None,
        prompt_ref=None,
        prompt_source="revision",
        prompt_contained_input_excerpts=None,
        revision_id=revision.ref.revision_id,
    )
    return result, store, revision.ref.revision_id, decision_ref


def run_prompt_experiment(
    root: Path, adapter_factory: "object" = None
) -> ExperimentReport:
    """The deterministic offline experiment (see the module docstring)."""
    factory = adapter_factory or prompt_sensitive_adapter
    arms: dict[str, ArmResult] = {}

    # A: incumbent prompt — measurable proposer failure
    result_a, _store_a = _cycle_arm(
        root, "arm-a",
        "incumbent prompt (ids+feedback only): proposer misses the signs",
        INCUMBENT_TEMPLATE, factory(),  # type: ignore[operator]
    )
    arms["A"] = result_a

    # B: candidate prompt — same everything, only the prompt differs
    result_b, store_b = _cycle_arm(
        root, "arm-b",
        "candidate prompt (input excerpts): proposer fixes the signs",
        CANDIDATE_TEMPLATE, factory(),  # type: ignore[operator]
    )
    arms["B"] = result_b

    # C: prompt-only ablation — the gate honestly rejects score-neutral changes
    result_c, _store_c, _rev_c, _dec_c = _evaluate_composite_arm(
        root, "arm-c", "prompt-only ablation (code unchanged)",
        {("prompt", "proposal-template"): CANDIDATE_TEMPLATE},
    )
    arms["C"] = result_c

    # D: code-only ablation — the code change suffices for execution scores
    result_d, _store_d, _rev_d, _dec_d = _evaluate_composite_arm(
        root, "arm-d", "code-only ablation (prompt unchanged)",
        {("strategy-code", "solve"): SIGNED_SUM_FIX},
    )
    arms["D"] = result_d

    # E: the prompt+code composite — accepted, ACTIVATED, restarted, rolled back
    result_e, store_e, revision_e, decision_ref_e = _evaluate_composite_arm(
        root, "arm-e", "prompt+code composite candidate",
        {
            ("prompt", "proposal-template"): CANDIDATE_TEMPLATE,
            ("strategy-code", "solve"): SIGNED_SUM_FIX,
        },
    )
    arms["E"] = result_e
    activated = False
    restart_ok = False
    rollback_ok = False
    if result_e.accepted:
        lifecycle.run_activation_op(
            store_e, revision_e,
            reason="promote",
            policy_ref="paired-deterministic@1",
            decision_ref=decision_ref_e,
        )
        activated = lifecycle.active_revision_id(store_e) == revision_e
        # restart: a NEW process resolves the candidate prompt from the manifest
        reopened = Store(store_e.root, TASK.task_id)
        text, _ref, revision_seen, source = resolve_active_prompt(reopened)
        restart_ok = (
            source == "revision"
            and revision_seen == revision_e
            and text == CANDIDATE_TEMPLATE
        )
        # rollback: the incumbent prompt AND baseline code come back together
        lifecycle.rollback(reopened)
        text_after, _r, _rev, source_after = resolve_active_prompt(reopened)
        projection = lifecycle.compatibility_projection(reopened)
        served = reopened.active_generation()
        rollback_ok = (
            source_after == "revision"
            and text_after == INCUMBENT_TEMPLATE
            and projection is not None
            and served is not None
            and projection.strategy_source_ref == served.source_ref
            and lifecycle.compat_parity(reopened).ok
        )

    causal = (
        arms["A"].accepted is not True  # rejected (or no valid proposal)
        and arms["B"].accepted is True
        and arms["A"].prompt_contained_input_excerpts is False
        and arms["B"].prompt_contained_input_excerpts is True
    )
    return ExperimentReport(
        arms=arms,
        causal_prompt_effect=causal,
        composite_gate_passed=bool(result_e.accepted) and activated,
        prompt_consumed=bool(arms["B"].prompt_contained_input_excerpts),
        restart_serves_candidate_prompt=restart_ok,
        rollback_restores_incumbent=rollback_ok,
        offline=True,
    )


@dataclass(frozen=True)
class RealModelArmReport:
    model_id: str
    arm: str
    proposal_valid: bool
    failure_kind: str | None
    accepted: bool | None
    notes: str


def run_real_model_arms(root: Path) -> tuple[RealModelArmReport, ...]:
    """Opt-in real-model version of arms A and B (env-configured adapter).

    Runs generation-native only (`unsafe_model_code=True`: model-written code
    executes without confinement, so lifecycle/canary authority is refused —
    the recorded outcome is about PROPOSER behavior under each prompt). A
    failure here is an honest result; it never weakens the gate."""
    from strive.model import adapter_from_env

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
        report = run_cycle(store, TASK, config)
        reports.append(
            RealModelArmReport(
                model_id=getattr(adapter, "model_id", "unknown"),
                arm=arm,
                proposal_valid=report.proposal is not None,
                failure_kind=(
                    report.proposal_failure.kind if report.proposal_failure else None
                ),
                accepted=report.decision.accepted if report.decision else None,
                notes=(
                    "generation-native only (unsafe model code: lifecycle "
                    "authority refused); artifacts + model I/O journaled in "
                    f"{store.root}"
                ),
            )
        )
    return tuple(reports)


def _events(store: Store, run_id: str) -> "list[Event]":
    return list(EventLog(store.runs_dir / run_id / "events.jsonl", run_id).read_all())
