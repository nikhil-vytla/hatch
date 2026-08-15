"""The result-driven, resumable policy kernel (Strive vNext).

The kernel is the only code that mutates harness state or performs side
effects. It drives the one active `AdaptationPolicy` ONE COMMAND AT A TIME:

    command = policy.next_command(config, state, view)   # None => done
    result  = _run_command(command)                      # one intent, one
                                                          # effect, one terminal
    state   = policy.reduce(config, state, result)       # fold the outcome
    checkpoint(state, consumed=command_id)               # AFTER the outcome

Per command it journals exactly one intent, performs or RECONCILES exactly
one effect, journals exactly one terminal result, then reduces and
checkpoints (state + a consumed-result cursor). It never advances policy
state before the outcome. On restart it reloads the last checkpoint,
re-derives the same deterministic command, and:

- if the command already has a terminal result, RECONSTRUCTS that exact
  result (so `last_result` can never disappear) and does not repeat the
  effect;
- if the effect is present but not yet terminal (a crash between them),
  finishes by recording the terminal result;
- if not yet reduced (the checkpoint's consumed cursor is behind), reduces
  and re-checkpoints — exactly once.

Floor enforced here regardless of policy: bound identity is authoritative
(a caller whose config/prompts/seed disagree with `PolicyBound` is
rejected); trusted budgets charge executions/model-calls; the secure
`CandidateExecutor` runs candidate code under declared, capability-checked
sandbox provenance; a change's full CAS closure is staged and required
before apply; and `EvaluateFork` captures exact base/candidate state refs
BEFORE execution and records both even if active state later advances.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strive import codec
from strive.budget import BudgetMeter
from strive.cas import hash_text
from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage
from strive.evaluate import evaluate
from strive.policy import (
    AdaptationPolicy,
    ApplyChange,
    CommandResult,
    ConfirmChange,
    EvaluateFork,
    KernelCommand,
    PolicyCatalog,
    RequestRefinement,
    RevertChange,
    RunView,
    ScheduleTrigger,
    StopAdaptation,
)
from strive.sandboxes import (
    CandidateExecutor,
    SandboxLimits,
    SandboxProvenance,
    default_catalog as default_sandbox_catalog,
)
from strive.substrate import (
    CompositeChange,
    HarnessState,
    Substrate,
    SubstrateError,
    VerifiedSubstrateView,
    apply_change,
)
from strive.tasks import Task


class KernelError(Exception):
    """A kernel orchestration/identity failure (never a policy proposal
    failure — those come back inside a CommandResult)."""


# -- content-addressable kernel blobs -------------------------------------------------------------


@register("fork-observation", 2)
@dataclass(frozen=True)
class ForkObservation:
    """The result of an OPTIONAL `EvaluateFork`: the exact base and candidate
    state refs (captured BEFORE execution), the code score of each over the
    task's cases, the sandbox provenance, and the metered usage."""

    candidate_change_id: str
    base_state_ref: str
    candidate_state_ref: str
    base_overall: float
    candidate_overall: float
    improved: bool
    sandbox_provenance: SandboxProvenance
    detail: str


@register("kernel-command-payload", 1)
@dataclass(frozen=True)
class _CommandPayload:
    """The canonical, content-addressable command payload — its CAS ref is
    the command digest that binds a command_id to one payload."""

    command_id: str
    kind: str
    json: str


@register("kernel-stored-result", 1)
@dataclass(frozen=True)
class _StoredResult:
    command_id: str
    kind: str
    outcome: str
    detail: str
    proposal_ref: str | None
    observation_ref: str | None
    metrics: dict[str, float]


@register("kernel-policy-state", 1)
@dataclass(frozen=True)
class _PolicyStateBlob:
    json: str


@register("kernel-config", 1)
@dataclass(frozen=True)
class _ConfigBlob:
    json: str


# -- services -------------------------------------------------------------------------------------


@dataclass
class KernelServices:
    """Everything the kernel needs: the run's substrate, the task, the secure
    executor candidate code runs under, the seed, and the trusted budget
    meter that charges executions/model-calls."""

    substrate: Substrate
    task: Task
    executor: CandidateExecutor
    seed: int
    meter: BudgetMeter
    required_capabilities: tuple[str, ...] = ()

    @staticmethod
    def open(
        root: Path,
        task: Task,
        run_id: str,
        *,
        seed: int = 0,
        sandbox_backend: str = "process-fault-only@1",
        trusted: bool = True,
        budget: BudgetSpec | None = None,
        required_capabilities: tuple[str, ...] = (),
    ) -> "KernelServices":
        executor = CandidateExecutor.from_catalog(
            default_sandbox_catalog(), sandbox_backend, trusted=trusted
        )
        _require_capabilities(executor, required_capabilities)
        return KernelServices(
            substrate=Substrate.open(root, task.task_id, run_id),
            task=task,
            executor=executor,
            seed=seed,
            meter=BudgetMeter(budget or BudgetSpec()),
            required_capabilities=required_capabilities,
        )


def _require_capabilities(executor: CandidateExecutor, required: tuple[str, ...]) -> None:
    enforced = set(executor.capabilities().enforced)
    missing = [cap for cap in required if cap not in enforced]
    if missing:
        raise KernelError(
            f"sandbox backend {executor.backend_name!r} does not enforce "
            f"required capabilities {missing} (enforces {sorted(enforced)})"
        )


@dataclass(frozen=True)
class RunReport:
    run_id: str
    task_id: str
    policy_ref: str
    commands: int
    stopped_reason: str
    head: str
    resumed: bool
    usage: BudgetUsage


# -- the loop -------------------------------------------------------------------------------------


def run_policy(
    services: KernelServices,
    catalog: PolicyCatalog,
    policy_name: str,
    config: object,
    *,
    prompt_refs: dict[str, str],
    seed_state: HarnessState,
    run_metadata: dict[str, str] | None = None,
    max_commands: int = 128,
) -> RunReport:
    """Bind (once) and drive the named policy to completion or `max_commands`.
    Safe to call again after a crash: it resumes from the last checkpoint and
    never repeats a completed command's effect, model call, observation, or
    reduction."""
    substrate = services.substrate
    descriptor = catalog.descriptor(policy_name)
    policy = descriptor.factory()

    config_json = _canonical_json(config)
    config_ref = hash_text(codec.dumps(_ConfigBlob(json=config_json)))

    view = substrate.verify()
    if not view.ok:
        raise KernelError(
            f"run {substrate.run_id} is not verifiable — repair before running: "
            f"{'; '.join(view.errors[:3])}"
        )
    resumed = view.bound is not None
    if view.bound is None:
        substrate.put(_ConfigBlob(json=config_json))
        view = substrate.bind_policy(
            policy_ref=policy.name,
            config_ref=config_ref,
            prompt_refs=prompt_refs,
            seed=services.seed,
            seed_state=seed_state,
            run_metadata=run_metadata or {},
        )
    else:
        _enforce_identity(view, policy, config_ref, prompt_refs, services.seed)

    # resume policy state + the consumed-result cursor from the last checkpoint
    checkpoint = view.latest_checkpoint
    if checkpoint is not None:
        state = policy.decode_state(_load_json(substrate, checkpoint.policy_state_ref))
        consumed = checkpoint.consumed_command_id
    else:
        state = policy.initial_state(config, RunView.of(services.seed, view))
        consumed = None

    commands = 0
    stopped_reason = "max-commands"
    last_result: CommandResult | None = None
    while commands < max_commands:
        view = substrate.verify()
        substrate._require_ok(view, "run")
        run_view = RunView.of(services.seed, view)
        command = policy.next_command(config, state, run_view)
        if command is None:
            stopped_reason = "done"
            break
        result = _run_command(services, view, command)
        if command.command_id != consumed:
            state = policy.reduce(config, state, result)
            view = substrate.checkpoint(
                policy_state_ref=substrate.put(
                    _PolicyStateBlob(json=_canonical_json_state(state))
                ),
                consumed_command_id=command.command_id,
                caused_by=command.command_id,
            )
            consumed = command.command_id
        last_result = result
        commands += 1
        if isinstance(command, StopAdaptation):
            stopped_reason = command.reason or "stopped"
            break

    _ = last_result
    return RunReport(
        run_id=substrate.run_id,
        task_id=services.task.task_id,
        policy_ref=policy.name,
        commands=commands,
        stopped_reason=stopped_reason,
        head=substrate.verify().head,
        resumed=resumed,
        usage=services.meter.usage(),
    )


def _enforce_identity(
    view: VerifiedSubstrateView,
    policy: AdaptationPolicy[Any, Any],
    config_ref: str,
    prompt_refs: dict[str, str],
    seed: int,
) -> None:
    assert view.bound is not None
    bound = view.bound
    if bound.policy_ref != policy.name:
        raise KernelError(
            f"run is bound to {bound.policy_ref!r}, not {policy.name!r}"
        )
    if bound.config_ref != config_ref:
        raise KernelError(
            "caller config does not match the bound config for this run "
            "(the bound PolicyBound is authoritative)"
        )
    if bound.prompt_refs != prompt_refs:
        raise KernelError("caller prompt refs do not match the bound run")
    if bound.seed != seed:
        raise KernelError(
            f"caller seed {seed} does not match the bound seed {bound.seed}"
        )


# -- one command: intent → effect/reconcile → terminal ---------------------------------------------


def _run_command(
    services: KernelServices, view: VerifiedSubstrateView, command: KernelCommand
) -> CommandResult:
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__

    terminal = view.completed.get(cid)
    if terminal is not None:
        return _reconstruct(services, command, terminal)

    command_ref = substrate.put(
        _CommandPayload(command_id=cid, kind=kind, json=_canonical_json(command))
    )
    if cid not in view.issued:
        substrate.issue_command(command_id=cid, command_kind=kind, command_ref=command_ref)

    try:
        result = _perform(services, substrate.verify(), command)
    except (SubstrateError, KernelError) as exc:
        substrate.record_failure(command_id=cid, kind=kind, detail=str(exc))
        result = CommandResult(cid, kind, "failed", substrate.verify().head, detail=str(exc))

    substrate.complete_command(
        command_id=cid,
        outcome=result.outcome,
        result=_StoredResult(
            command_id=cid,
            kind=kind,
            outcome=result.outcome,
            detail=result.detail,
            proposal_ref=substrate.put(result.proposal) if result.proposal else None,
            observation_ref=result.observation_ref,
            metrics=result.metrics,
        ),
    )
    return CommandResult(
        cid, kind, result.outcome, substrate.verify().head, detail=result.detail,
        proposal=result.proposal, observation_ref=result.observation_ref,
        metrics=result.metrics,
    )


def _perform(
    services: KernelServices, view: VerifiedSubstrateView, command: KernelCommand
) -> CommandResult:
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__

    if isinstance(command, ApplyChange):
        if not _already_proposed(view, command.change.change_id):
            substrate.record_proposal(
                change=command.change, strategy_ref=command.strategy_ref, caused_by=cid
            )
        if command.change.change_id not in view.applied_change_ids:
            substrate.stage_change_closure(command.change, command.content_blobs)
            substrate.apply(
                change=command.change, caused_by=cid, expected_head=command.expected_head
            )
        return CommandResult(cid, kind, "ok", substrate.verify().head,
                             proposal=command.change, detail=command.change.summary)

    if isinstance(command, RevertChange):
        if command.change_id not in view.reverted_change_ids:
            substrate.revert(
                change_id=command.change_id, caused_by=cid,
                expected_head=command.expected_head,
            )
        return CommandResult(cid, kind, "ok", substrate.verify().head)

    if isinstance(command, EvaluateFork):
        return _evaluate_fork(services, view, command)

    if isinstance(command, ConfirmChange):
        if not _caused(view, cid, "change-confirmed@2"):
            substrate.confirm_change(
                change_id=command.change_id, rationale=command.rationale, caused_by=cid
            )
        return CommandResult(cid, kind, "ok", substrate.verify().head)

    if isinstance(command, ScheduleTrigger):
        # Phase A runs in-process to completion; the schedule is journaled
        # intent only (no external scheduler yet).
        return CommandResult(cid, kind, "ok", view.head, detail="scheduled")

    if isinstance(command, StopAdaptation):
        return CommandResult(cid, kind, "ok", view.head, detail=command.reason)

    if isinstance(command, RequestRefinement):
        # Phase A ships no model refiner; a policy needing one must supply it.
        raise KernelError(
            "RequestRefinement is unimplemented in Phase A (no model refiner "
            "bound; manual-change@1 constructs its typed change directly)"
        )
    raise KernelError(f"unknown command {kind}")


def _evaluate_fork(
    services: KernelServices, view: VerifiedSubstrateView, command: EvaluateFork
) -> CommandResult:
    """OPTIONAL comparative mechanism. Captures the exact base and candidate
    state refs BEFORE execution, scores each over the task's cases under the
    secure executor (charging the budget), and records ONE observation with
    both refs — even if active state later advances. Idempotent: if this
    command already recorded its observation, it is not re-run."""
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__

    if not _already_proposed(view, command.candidate.change_id):
        substrate.record_proposal(
            change=command.candidate, strategy_ref=command.detail or "fork", caused_by=cid
        )
    existing = _caused_ref(view, cid, "observation-recorded@2")
    if existing is not None:
        # already observed (a crash between the observation and completion):
        # reconstruct the SAME metrics from the recorded ForkObservation so
        # the reducer's reaction is identical — and do NOT re-run the executor
        from strive.substrate import ObservationRecorded

        recorded = codec.loads(substrate.objects.get_text(existing), ObservationRecorded)
        fork = codec.loads(
            substrate.objects.get_text(recorded.observation_ref), ForkObservation
        )
        return CommandResult(
            cid, kind, "ok", view.head, observation_ref=existing,
            detail="fork already observed",
            metrics={
                "base_overall": fork.base_overall,
                "candidate_overall": fork.candidate_overall,
                "improved": 1.0 if fork.improved else 0.0,
            },
        )

    substrate.stage_change_closure(command.candidate, command.content_blobs)
    base_state = view.state
    base_ref = view.state_ref or ""
    candidate_state = apply_change(base_state, command.candidate)
    candidate_ref = substrate.put_state(candidate_state)

    base_overall = _score(services, base_state)
    candidate_overall = _score(services, candidate_state)
    observation = ForkObservation(
        candidate_change_id=command.candidate.change_id,
        base_state_ref=base_ref,
        candidate_state_ref=candidate_ref,
        base_overall=base_overall,
        candidate_overall=candidate_overall,
        improved=candidate_overall > base_overall,
        sandbox_provenance=services.executor.provenance(),
        detail=command.detail,
    )
    updated = substrate.record_observation(
        observation_kind="fork-evaluation", observation=observation,
        subject_state_ref=candidate_ref, caused_by=cid,
    )
    ref = updated.envelopes[-1].body_ref
    return CommandResult(
        cid, kind, "ok", updated.head, observation_ref=ref, detail="fork evaluated",
        metrics={
            "base_overall": base_overall,
            "candidate_overall": candidate_overall,
            "improved": 1.0 if observation.improved else 0.0,
        },
    )


def _score(services: KernelServices, state: HarnessState) -> float:
    """Run the state's strategy code over the task's selection cases under the
    secure executor, charging one execution per case. Returns the overall
    score (0.0 with no code surface)."""
    code_ref = state.content_ref("strategy-code", "solve")
    if code_ref is None:
        return 0.0
    source = services.substrate.objects.get_text(code_ref)
    cases = services.task.selection_cases()
    for _case in cases:
        denial = services.meter.request_execution()
        if denial is not None:
            raise KernelError(f"budget denied fork execution: {denial.detail}")
    outcome = services.executor.execute_suite(
        source, cases, generation_id="fork", limits=SandboxLimits()
    )
    return evaluate(services.task, outcome.report, cases).overall_score


# -- idempotency helpers + result reconstruction --------------------------------------------------


def _caused(view: VerifiedSubstrateView, command_id: str, body_kind: str) -> bool:
    return _caused_ref(view, command_id, body_kind) is not None


def _already_proposed(view: VerifiedSubstrateView, change_id: str) -> bool:
    from strive.substrate import ChangeProposed

    return any(
        isinstance(b, ChangeProposed) and b.change_id == change_id for b in view.bodies
    )


def _caused_ref(view: VerifiedSubstrateView, command_id: str, body_kind: str) -> str | None:
    for env in view.envelopes:
        if env.caused_by == command_id and env.body_kind == body_kind:
            return env.body_ref
    return None


def _reconstruct(
    services: KernelServices, command: KernelCommand, terminal: object
) -> CommandResult:
    """Rebuild the exact recorded result of an already-completed command, so a
    resumed step sees the same `last_result` without repeating the effect."""
    from strive.substrate import PolicyCommandCompleted

    substrate = services.substrate
    assert isinstance(terminal, PolicyCommandCompleted)
    cid = command.command_id
    kind = type(command).__name__
    if terminal.result_ref is None:
        return CommandResult(cid, kind, terminal.outcome, substrate.verify().head)
    stored = codec.loads(substrate.objects.get_text(terminal.result_ref), _StoredResult)
    proposal: CompositeChange | None = None
    if stored.proposal_ref is not None:
        proposal = codec.loads(
            substrate.objects.get_text(stored.proposal_ref), CompositeChange
        )
    return CommandResult(
        command_id=stored.command_id, kind=stored.kind, outcome=stored.outcome,
        head=substrate.verify().head, detail=stored.detail, proposal=proposal,
        observation_ref=stored.observation_ref, metrics=dict(stored.metrics),
    )


# -- canonical encoding of config / command / policy state ----------------------------------------


def _canonical_json(obj: object) -> str:
    import dataclasses
    import json

    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return json.dumps(_encode(dataclasses.asdict(obj)), sort_keys=True)
    return json.dumps(obj, sort_keys=True, default=str)


def _canonical_json_state(state: object) -> str:
    return _canonical_json(state)


def _encode(value: object) -> object:
    import dataclasses

    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _encode(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {str(k): _encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(v) for v in value]
    return value


def _load_json(substrate: Substrate, ref: str) -> object:
    import json

    blob = codec.loads(substrate.objects.get_text(ref), _PolicyStateBlob)
    return json.loads(blob.json)


__all__ = [
    "ForkObservation",
    "KernelError",
    "KernelServices",
    "RunReport",
    "run_policy",
]
