"""The kernel: a resumable policy command loop (Strive vNext, Phase A).

The kernel is the ONLY code that mutates harness state or performs side
effects. It drives the one active `AdaptationPolicy`: each step, it hands
the policy an immutable `RunView` and the previous command's result, runs
the commands the policy emits, journals every command's intent and result,
content-addresses the policy's successor state as a checkpoint, and stops
when the policy says so.

Resumption is exact. A command's authority EFFECT (e.g. a `ChangeApplied`)
and its `PolicyCommandCompleted` record are both journaled; on restart the
kernel reloads the last checkpoint, re-derives the same deterministic
commands, and for each one:

- if it already completed, reads back the recorded result and does NOT
  repeat the side effect (no duplicate model call, apply, or revert);
- if it was issued but its effect is already present (a crash between the
  effect and completion), it finishes by recording completion only;
- otherwise it performs the effect and records completion.

The kernel enforces the floor for every command regardless of policy:
allowlisted surfaces and exact before/after (via the substrate),
expected-head conflict checks on authority appends, CAS integrity, the
declared security + semantic capability requirements of the sandbox backend
(via `CandidateExecutor`), and budgets. Comparative evaluation happens only
when a policy issues `EvaluateFork` — it is never an activation prerequisite.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strive import codec
from strive.codec import register
from strive.evaluate import evaluate
from strive.events import now_iso
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
    SandboxError,
    SandboxLimits,
    default_catalog as default_sandbox_catalog,
)
from strive.substrate import (
    ChangeApplied,
    ChangeReverted,
    CompositeChange,
    HarnessState,
    Substrate,
    SubstrateError,
    apply_change,
)
from strive.tasks import Task


class KernelError(Exception):
    """A kernel orchestration failure (never a policy proposal failure —
    those come back inside a CommandResult)."""


@register("fork-observation", 1)
@dataclass(frozen=True)
class ForkObservation:
    """The result of an OPTIONAL `EvaluateFork`: the candidate composite
    change, the code score of the current state and of the forked state over
    the task's cases, under the exact sandbox backend used. Recorded as an
    observation; it never moves state."""

    candidate_change_id: str
    current_overall: float
    forked_overall: float
    sandbox_backend: str
    detail: str


@dataclass(frozen=True)
class KernelServices:
    """Everything the kernel needs to execute commands: the substrate, the
    task the run adapts, and the secure executor candidate code runs under.
    `trusted` marks whether the code is author-written (fixtures) — a
    fault-only backend is allowed only then."""

    substrate: Substrate
    task: Task
    executor: CandidateExecutor
    seed: int

    @staticmethod
    def open(
        root: Path,
        task: Task,
        *,
        seed: int = 0,
        sandbox_backend: str = "process-fault-only@1",
        trusted: bool = True,
    ) -> "KernelServices":
        executor = CandidateExecutor.from_catalog(
            default_sandbox_catalog(), sandbox_backend, trusted=trusted
        )
        return KernelServices(
            substrate=Substrate.open(root, task.task_id),
            task=task,
            executor=executor,
            seed=seed,
        )


@dataclass(frozen=True)
class RunReport:
    task_id: str
    policy_ref: str
    steps: int
    stopped_reason: str
    head: str
    resumed: bool


def run_policy(
    services: KernelServices,
    catalog: PolicyCatalog,
    policy_name: str,
    config: object,
    *,
    prompt_refs: dict[str, str],
    seed_state: HarnessState,
    run_metadata: dict[str, str] | None = None,
    max_steps: int = 64,
) -> RunReport:
    """Bind (once) and drive the named policy to completion or `max_steps`.
    Safe to call again after a crash: it resumes from the last checkpoint
    and never repeats a completed command's side effect."""
    substrate = services.substrate
    descriptor = catalog.descriptor(policy_name)
    policy = descriptor.factory()

    view = substrate.view()
    resumed = view.bound is not None
    if view.bound is None:
        config_ref = substrate.put(_ConfigBlob(codec_json=_config_json(config)))
        substrate.bind_policy(
            policy_ref=policy.name,
            config_ref=config_ref,
            prompt_refs=prompt_refs,
            seed=services.seed,
            seed_state=seed_state,
            run_metadata=run_metadata or {},
        )
    elif view.bound.policy_ref != policy.name:
        raise KernelError(
            f"run is bound to {view.bound.policy_ref!r}, not {policy.name!r}"
        )

    # resume policy state from the last checkpoint, else initialise
    checkpoint = substrate.latest_checkpoint()
    view = substrate.view()
    run_view = RunView.of(services.task.task_id, services.seed, view)
    if checkpoint is not None:
        state = _load_policy_state(substrate, policy, config, checkpoint.policy_state_ref)
    else:
        state = policy.initial_state(config, run_view)

    steps = 0
    stopped_reason = "max-steps"
    last_result: CommandResult | None = None
    while steps < max_steps:
        view = substrate.view()
        run_view = RunView.of(services.task.task_id, services.seed, view)
        step = policy.step(config, state, run_view, last_result)
        for command in step.commands:
            last_result = _execute(services, command)
        if step.checkpoint:
            next_ref = _put_policy_state(substrate, step.next_state)
            latest = substrate.latest_checkpoint()
            # dedup: don't re-append an identical checkpoint on a resume that
            # re-derives an already-checkpointed state (keeps repeated resumes
            # of a completed run side-effect-free)
            if latest is None or latest.policy_state_ref != next_ref:
                substrate.checkpoint(policy_state_ref=next_ref)
        state = step.next_state
        steps += 1
        if step.done:
            stopped_reason = _stop_reason(step.commands)
            break

    return RunReport(
        task_id=services.task.task_id,
        policy_ref=policy.name,
        steps=steps,
        stopped_reason=stopped_reason,
        head=substrate.view().head,
        resumed=resumed,
    )


# -- command execution (idempotent across crashes) ------------------------------------------------


def _execute(services: KernelServices, command: KernelCommand) -> CommandResult:
    substrate = services.substrate
    command_id = command.command_id
    completed = substrate.completed_command_ids()
    if command_id in completed:
        # already fully done: read back the recorded result, do NOT repeat
        return _reconstruct_result(services, command)

    substrate.issue_command(
        command_id=command_id,
        command_kind=type(command).__name__,
        command=_command_payload(command),
    )
    try:
        result = _perform(services, command)
    except (SubstrateError, SandboxError) as exc:
        substrate.record_failure(
            command_id=command_id, kind=type(command).__name__, detail=str(exc)
        )
        result = CommandResult(
            command_id=command_id,
            outcome="failed",
            head=substrate.view().head,
            detail=str(exc),
        )
    substrate.complete_command(
        command_id=command_id,
        outcome=result.outcome,
        result=_StoredResult(
            command_id=result.command_id,
            outcome=result.outcome,
            detail=result.detail,
            proposal_change_ref=(
                substrate.put(result.proposal) if result.proposal is not None else None
            ),
            observation_ref=result.observation_ref,
        ),
    )
    return result


def _perform(services: KernelServices, command: KernelCommand) -> CommandResult:
    substrate = services.substrate
    cid = command.command_id
    if isinstance(command, ApplyChange):
        if _already_applied(substrate, command.change.change_id):
            return _ok(substrate, cid)  # crash between effect and completion
        _stage_blobs(substrate, command.content_blobs)
        substrate.apply(change=command.change, expected_head=command.expected_head)
        return _ok(substrate, cid)
    if isinstance(command, RevertChange):
        if _already_reverted(substrate, command.change_id):
            return _ok(substrate, cid)
        substrate.revert(change_id=command.change_id, expected_head=command.expected_head)
        return _ok(substrate, cid)
    if isinstance(command, EvaluateFork):
        return _evaluate_fork(services, command)
    if isinstance(command, ConfirmChange):
        substrate.confirm_change(change_id=command.change_id, rationale=command.rationale)
        return _ok(substrate, cid)
    if isinstance(command, ScheduleTrigger):
        # Phase A runs to completion in-process; the schedule is journaled
        # intent only (no external scheduler yet).
        return CommandResult(cid, "ok", substrate.view().head, detail="scheduled")
    if isinstance(command, StopAdaptation):
        return CommandResult(cid, "ok", substrate.view().head, detail=command.reason)
    if isinstance(command, RequestRefinement):
        # Phase A ships no model refiner (deliberately); a policy that needs
        # one must supply it. manual-change@1 constructs its typed change
        # directly and never issues this.
        raise KernelError(
            "RequestRefinement is unimplemented in Phase A: no model refiner "
            "is bound (manual-change@1 proposes its typed change directly)"
        )
    raise KernelError(f"unknown command {type(command).__name__}")


def _evaluate_fork(services: KernelServices, command: EvaluateFork) -> CommandResult:
    """The OPTIONAL comparative mechanism: score the CURRENT composite state
    and a FORKED candidate (current + the candidate change) over the task's
    cases under the secure executor, and record the observation. Never moves
    state — a policy requests it; the kernel does not impose it."""
    substrate = services.substrate
    _stage_blobs(substrate, command.content_blobs)
    view = substrate.view()
    current_overall = _score_state(services, view.state)
    forked_state = apply_change(view.state, command.candidate)
    forked_overall = _score_state(services, forked_state)
    observation = ForkObservation(
        candidate_change_id=command.candidate.change_id,
        current_overall=current_overall,
        forked_overall=forked_overall,
        sandbox_backend=services.executor.backend_name,
        detail=command.detail,
    )
    ref = substrate.record_observation(
        observation_kind="fork-evaluation", observation=observation
    )
    return CommandResult(
        command.command_id, "ok", substrate.view().head,
        detail="fork evaluated", observation_ref=ref,
    )


def _score_state(services: KernelServices, state: HarnessState) -> float:
    """Run the state's strategy code over the task's selection cases under the
    secure executor and return the overall score (0.0 if no code surface)."""
    code_ref = state.content_ref("strategy-code", "solve")
    if code_ref is None:
        return 0.0
    source = services.substrate.objects.get_text(code_ref)
    cases = services.task.selection_cases()
    outcome = services.executor.execute_suite(
        source, cases, generation_id="fork", limits=SandboxLimits()
    )
    evaluation = evaluate(services.task, outcome.report, cases)
    return evaluation.overall_score


# -- idempotency + result reconstruction ----------------------------------------------------------


def _already_applied(substrate: Substrate, change_id: str) -> bool:
    applied = False
    for entry in substrate.journal.read().entries:
        if isinstance(entry, ChangeApplied) and entry.change_id == change_id:
            applied = True
        elif isinstance(entry, ChangeReverted) and entry.change_id == change_id:
            applied = False
    return applied


def _already_reverted(substrate: Substrate, change_id: str) -> bool:
    return any(
        isinstance(e, ChangeReverted) and e.change_id == change_id
        for e in substrate.journal.read().entries
    )


def _reconstruct_result(services: KernelServices, command: KernelCommand) -> CommandResult:
    """Read back a completed command's recorded result so a resumed step sees
    the same `last_result` without repeating the side effect."""
    substrate = services.substrate
    stored: _StoredResult | None = None
    for entry in substrate.journal.read().entries:
        from strive.substrate import PolicyCommandCompleted

        if isinstance(entry, PolicyCommandCompleted) and entry.command_id == command.command_id:
            if entry.result_ref is not None:
                stored = codec.loads(
                    substrate.objects.get_text(entry.result_ref), _StoredResult
                )
    if stored is None:
        return CommandResult(command.command_id, "ok", substrate.view().head)
    proposal: CompositeChange | None = None
    if stored.proposal_change_ref is not None:
        proposal = codec.loads(
            substrate.objects.get_text(stored.proposal_change_ref), CompositeChange
        )
    return CommandResult(
        command_id=stored.command_id,
        outcome=stored.outcome,
        head=substrate.view().head,
        detail=stored.detail,
        proposal=proposal,
        observation_ref=stored.observation_ref,
    )


def _stage_blobs(substrate: Substrate, blobs: dict[str, str]) -> None:
    """Put each policy-staged content blob into CAS and VERIFY its pure
    content address matches the ref the change references — a mismatch is a
    floor violation (a change may not reference content it did not stage)."""
    from strive.cas import hash_text

    for ref, content in blobs.items():
        if hash_text(content) != ref:
            raise SubstrateError(
                f"staged content does not hash to its ref {ref[:12]}…"
            )
        substrate.objects.put_text(content)


def _ok(substrate: Substrate, command_id: str) -> CommandResult:
    return CommandResult(command_id, "ok", substrate.view().head)


def _stop_reason(commands: tuple[KernelCommand, ...]) -> str:
    for command in commands:
        if isinstance(command, StopAdaptation):
            return command.reason or "stopped"
    return "done"


# -- content-addressed policy state + config ------------------------------------------------------


@register("policy-state-blob", 1)
@dataclass(frozen=True)
class _PolicyStateBlob:
    """The policy's successor state, encoded to a canonical JSON string so it
    is content-addressable regardless of the concrete State type."""

    codec_json: str


@register("policy-config-blob", 1)
@dataclass(frozen=True)
class _ConfigBlob:
    codec_json: str


@register("command-payload", 1)
@dataclass(frozen=True)
class _CommandPayload:
    kind: str
    codec_json: str


@register("stored-result", 1)
@dataclass(frozen=True)
class _StoredResult:
    command_id: str
    outcome: str
    detail: str
    proposal_change_ref: str | None
    observation_ref: str | None


def _config_json(config: object) -> str:
    import dataclasses
    import json

    if dataclasses.is_dataclass(config) and not isinstance(config, type):
        return json.dumps(dataclasses.asdict(config), sort_keys=True)
    return json.dumps(config, sort_keys=True, default=str)


def _put_policy_state(substrate: Substrate, state: object) -> str:
    return substrate.put(_PolicyStateBlob(codec_json=_config_json(state)))


def _load_policy_state(
    substrate: Substrate,
    policy: AdaptationPolicy[Any, Any],
    config: object,
    policy_state_ref: str,
) -> object:
    """Reconstruct the policy's typed State from its content-addressed blob
    via the policy's own decoder."""
    blob = codec.loads(substrate.objects.get_text(policy_state_ref), _PolicyStateBlob)
    decode = getattr(policy, "decode_state", None)
    if decode is None:
        raise KernelError(
            f"policy {policy.name} cannot resume: it defines no decode_state"
        )
    import json

    return decode(json.loads(blob.codec_json))


def _command_payload(command: KernelCommand) -> _CommandPayload:
    import dataclasses
    import json

    return _CommandPayload(
        kind=type(command).__name__,
        codec_json=json.dumps(
            {
                k: v
                for k, v in dataclasses.asdict(command).items()
                if not isinstance(v, (bytes, bytearray))
            },
            sort_keys=True,
            default=str,
        ),
    )


__all__ = [
    "ForkObservation",
    "KernelError",
    "KernelServices",
    "RunReport",
    "run_policy",
]
