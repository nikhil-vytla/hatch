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
re-derives the same deterministic command, RE-DERIVES that command's payload
digest and compares it to the issued digest (BOTH on the already-issued and
already-completed paths — a changed re-derivation fails closed), and:

- if the command already has a terminal result, RECONSTRUCTS that exact
  recorded result (including its recorded head) and does not repeat the
  effect;
- if the effect is present but not yet terminal (a crash between them),
  finishes by recording the terminal result;
- if not yet reduced (the checkpoint's consumed cursor is behind), reduces
  and re-checkpoints — exactly once.

Effect honesty: durable STATE effects (apply/revert) reconcile EXACTLY — a
recorded effect without a terminal is finished, not repeated. A fork's
sandbox executions are deterministic and re-runnable, but their outcome is
recorded durably (base/candidate state refs + metered usage) and REUSED on
resume, so a completed fork never re-executes or re-charges. External model
calls (`RequestRefinement`) are NOT exactly-once and are unimplemented in
Phase A; when one is added, a dispatch-without-durable-result crash must be
recorded `indeterminate` and require explicit retry, never silently
duplicated.

Budgets survive restart: the pinned `BudgetSpec` is content-addressed in
`PolicyBound` (a resumed caller with a different budget is rejected), and
cumulative countable spend is re-seeded from the durably-recorded per-fork
usage — restart cannot reset or expand the budget.

Floor enforced here regardless of policy: authoritative bound identity (task
fingerprint, policy digest, config, prompts, seed, budget, capabilities);
trusted budgets charging executions AND wall/output; the secure
`CandidateExecutor` under declared, capability-checked provenance; a change's
full CAS closure staged (and structurally validated) before apply; and
`EvaluateFork` capturing exact base/candidate refs BEFORE execution.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strive import codec
from strive.budget import BudgetMeter
from strive.cas import hash_text
from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage, FailureRecord
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
    ObservationRecorded,
    PolicyCommandCompleted,
    Substrate,
    SubstrateError,
    VerifiedSubstrateView,
    apply_change,
)
from strive.surfaces import SurfaceCatalog, default_surface_catalog
from strive.tasks import Task

_ENCODING = "strict-json@1"


class KernelError(Exception):
    """A kernel orchestration/identity failure (never a policy proposal
    failure — those come back inside a CommandResult)."""


class IndeterminateEffect(Exception):
    """Raised by `_perform` when a command DISPATCHED an external effect but no
    durable result is recoverable and there is no idempotency key. The kernel
    records the command `indeterminate` (durable) and requires an EXPLICIT
    retry — it never silently re-dispatches and claims exactly-once."""


# -- content-addressable kernel blobs -------------------------------------------------------------


@register("execution-attempt", 1)
@dataclass(frozen=True)
class AttemptRecord:
    """One base-or-candidate execution attempt, recorded with the ACTUAL
    returned provenance, any failure, denials, the metered usage THIS attempt
    charged, and the state ref it scored — separately, so a fork's two
    executions are each independently auditable."""

    label: str  # "base" | "candidate"
    state_ref: str
    overall: float
    ok: bool
    provenance: SandboxProvenance
    failure: FailureRecord | None
    denials: tuple[str, ...]
    usage: BudgetUsage


@register("fork-observation", 4)
@dataclass(frozen=True)
class ForkObservation:
    """The result of an OPTIONAL `EvaluateFork`: the exact base and candidate
    execution ATTEMPTS (each with actual provenance/failures/denials/usage/state
    ref, captured around execution) and whether the candidate improved."""

    candidate_change_id: str
    base: AttemptRecord
    candidate: AttemptRecord
    improved: bool
    detail: str

    @property
    def base_overall(self) -> float:
        return self.base.overall

    @property
    def candidate_overall(self) -> float:
        return self.candidate.overall


@register("kernel-command-payload", 1)
@dataclass(frozen=True)
class _CommandPayload:
    """The canonical, content-addressable command payload — its CAS ref is
    the command digest that binds a command_id to one payload."""

    command_id: str
    kind: str
    encoding: str
    json: str


@register("kernel-stored-result", 3)
@dataclass(frozen=True)
class _StoredResult:
    command_id: str
    kind: str
    outcome: str
    head: str
    detail: str
    proposal_ref: str | None
    observation_ref: str | None
    metrics: dict[str, float]
    usage: BudgetUsage  # the metered spend THIS command charged (durable)


@register("kernel-policy-state", 2)
@dataclass(frozen=True)
class _PolicyStateBlob:
    encoding: str
    json: str


@register("kernel-config", 2)
@dataclass(frozen=True)
class _ConfigBlob:
    encoding: str
    json: str


# -- services -------------------------------------------------------------------------------------


@dataclass
class KernelServices:
    """Everything the kernel needs: the run's substrate, the task, the secure
    executor candidate code runs under, the seed, and the trusted budget
    meter that charges executions/wall/output."""

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
        surface_catalog: SurfaceCatalog | None = None,
    ) -> "KernelServices":
        executor = CandidateExecutor.from_catalog(
            default_sandbox_catalog(), sandbox_backend, trusted=trusted
        )
        _require_capabilities(executor, required_capabilities)
        return KernelServices(
            substrate=Substrate.open(
                root, task.task_id, run_id,
                catalog=surface_catalog or default_surface_catalog(),
            ),
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
    reduction, and re-seeds the budget from durable usage."""
    substrate = services.substrate
    descriptor = catalog.descriptor(policy_name)
    policy = descriptor.factory()

    config_ref = _config_ref(config)
    policy_digest = _policy_digest(policy)
    task_fingerprint = services.task.fingerprint()
    budget_ref = hash_text(codec.dumps(services.meter.spec))

    # an exclusive RUN lease: two processes can never drive (and execute
    # commands for) the same run concurrently.
    with substrate.run_lease():
        # reconcile the DERIVED binding index (rebuild after a crash between
        # the PolicyBound event and the index write) before doing anything.
        substrate.ensure_binding()
        view = substrate.verify()
        if not view.ok:
            raise KernelError(
                f"run {substrate.run_id} is not verifiable — repair before "
                f"running: {'; '.join(view.errors[:3])}"
            )
        resumed = view.bound is not None
        if view.bound is None:
            substrate.put(_config_blob(config))
            substrate.put(services.meter.spec)  # pin the budget spec in CAS
            view = substrate.bind_policy(
                task_fingerprint=task_fingerprint,
                policy_ref=policy.name,
                policy_digest=policy_digest,
                config_ref=config_ref,
                prompt_refs=prompt_refs,
                seed=services.seed,
                seed_state=seed_state,
                budget_ref=budget_ref,
                required_capabilities=services.required_capabilities,
                run_metadata=run_metadata or {},
            )
        else:
            _enforce_identity(
                services, view, policy, config_ref, policy_digest,
                task_fingerprint, budget_ref, prompt_refs,
            )
        # re-seed cumulative spend from durable per-command usage (covers a
        # fresh run too — sum is then zero). Restart never resets/expands it.
        _seed_meter(services, view)

        # resume policy state + the consumed-result cursor from the checkpoint
        checkpoint = view.latest_checkpoint
        if checkpoint is not None:
            state = policy.decode_state(
                _load_state_json(substrate, checkpoint.policy_state_ref)
            )
            consumed = checkpoint.consumed_command_id
        else:
            state = policy.initial_state(config, RunView.of(services.seed, view))
            consumed = None

        commands = 0
        stopped_reason = "max-commands"
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
                substrate.checkpoint(
                    policy_state_ref=substrate.put(_state_blob(state)),
                    consumed_command_id=command.command_id,
                    caused_by=command.command_id,
                )
                consumed = command.command_id
            commands += 1
            if isinstance(command, StopAdaptation):
                stopped_reason = command.reason or "stopped"
                break

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
    services: KernelServices,
    view: VerifiedSubstrateView,
    policy: AdaptationPolicy[Any, Any],
    config_ref: str,
    policy_digest: str,
    task_fingerprint: str,
    budget_ref: str,
    prompt_refs: dict[str, str],
) -> None:
    assert view.bound is not None
    bound = view.bound
    if bound.policy_ref != policy.name:
        raise KernelError(f"run is bound to {bound.policy_ref!r}, not {policy.name!r}")
    if bound.policy_digest != policy_digest:
        raise KernelError(
            "policy implementation digest does not match the bound run "
            "(the policy code changed underneath a resume)"
        )
    if bound.task_id != services.task.task_id:
        raise KernelError(
            f"run is bound to task {bound.task_id!r}, not {services.task.task_id!r}"
        )
    if bound.task_fingerprint != task_fingerprint:
        raise KernelError("task spec fingerprint does not match the bound run")
    if bound.config_ref != config_ref:
        raise KernelError(
            "caller config does not match the bound config for this run "
            "(the bound PolicyBound is authoritative)"
        )
    if bound.prompt_refs != prompt_refs:
        raise KernelError("caller prompt refs do not match the bound run")
    if bound.seed != services.seed:
        raise KernelError(
            f"caller seed {services.seed} does not match the bound seed {bound.seed}"
        )
    if bound.budget_ref != budget_ref:
        raise KernelError(
            "caller budget spec does not match the bound run (budgets cannot be "
            "changed on resume)"
        )
    if tuple(bound.required_capabilities) != tuple(services.required_capabilities):
        raise KernelError(
            "required capability profile does not match the bound run"
        )


def _seed_meter(services: KernelServices, view: VerifiedSubstrateView) -> None:
    """Re-seed cumulative countable spend from the durably-recorded per-command
    usage of every COMPLETED command (including failed/partial ones), so a
    resumed run reconstructs all budget dimensions without reset or double
    absorption. A command is counted exactly once, when it has a terminal."""
    substrate = services.substrate
    for terminal in view.completed.values():
        if terminal.result_ref is None:
            continue
        stored = codec.loads(substrate.objects.get_text(terminal.result_ref), _StoredResult)
        services.meter.absorb(stored.usage)


def operator_revert(services: KernelServices, change_id: str) -> CommandResult:
    """Operator-initiated revert that goes through the SAME command path as a
    policy (issue → perform → terminal), never a direct `Substrate.revert`.
    Idempotent by a stable operator command id, so repeating it never double-
    reverts. Returns the command result (outcome "failed" if there is nothing
    to revert)."""
    substrate = services.substrate
    with substrate.run_lease():  # operators execute on the command path, too
        view = substrate.verify()
        substrate._require_ok(view, "operator-revert")
        if view.bound is None:
            raise KernelError("cannot revert an unbound run")
        _seed_meter(services, view)
        # precheck so an operator gets an honest error rather than a silent
        # no-op (the command path itself is idempotent, which is right for
        # resume but wrong feedback for a deliberate operator request)
        if change_id not in view.applied_change_ids:
            raise KernelError(f"no applied change {change_id!r} to revert")
        if change_id in view.reverted_change_ids:
            raise KernelError(f"change {change_id!r} is already reverted")
        command = RevertChange(
            command_id=f"{substrate.run_id}:operator-revert:{change_id}",
            change_id=change_id,
        )
        return _run_command(services, view, command)


# -- one command: intent → effect/reconcile → terminal ---------------------------------------------


def _run_command(
    services: KernelServices, view: VerifiedSubstrateView, command: KernelCommand
) -> CommandResult:
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__

    # re-derive the command's canonical payload digest and compare it to any
    # issued digest — BEFORE both the already-completed and already-issued
    # paths — so a changed re-derivation fails closed rather than reconciling
    # against a different intent.
    command_ref = substrate.put(
        _CommandPayload(
            command_id=cid, kind=kind, encoding=_ENCODING,
            json=_command_identity_json(command),
        )
    )
    issued = view.issued.get(cid)
    if issued is not None and issued.command_ref != command_ref:
        raise KernelError(
            f"command {cid!r} re-derived a different payload digest than the "
            f"issued intent ({issued.command_ref[:12]}… vs {command_ref[:12]}…) — "
            "refusing to reconcile against a changed command"
        )

    terminal = view.completed.get(cid)
    if terminal is not None:
        return _reconstruct(services, command, terminal)

    # `issue_command` is idempotent (same id+digest is a read, not a 2nd intent)
    substrate.issue_command(command_id=cid, command_kind=kind, command_ref=command_ref)

    before_usage = services.meter.usage()
    try:
        result = _perform(services, substrate.verify(), command)
    except IndeterminateEffect as exc:
        # dispatched, but no durable result is recoverable: record it honestly
        # and REQUIRE an explicit retry — never silently re-dispatch.
        substrate.record_failure(command_id=cid, kind=kind, detail=f"indeterminate: {exc}")
        result = CommandResult(cid, kind, "indeterminate", substrate.verify().head, detail=str(exc))
    except (SubstrateError, KernelError) as exc:
        substrate.record_failure(command_id=cid, kind=kind, detail=str(exc))
        result = CommandResult(cid, kind, "failed", substrate.verify().head, detail=str(exc))
    charged = _usage_delta(before_usage, services.meter.usage())

    # the command's canonical head is the head AFTER its effect but BEFORE its
    # terminal completion — a stable logical point both the initial run and a
    # reconstruction return identically.
    head = substrate.verify().head
    stored = _StoredResult(
        command_id=cid,
        kind=kind,
        outcome=result.outcome,
        head=head,
        detail=result.detail,
        proposal_ref=substrate.put(result.proposal) if result.proposal else None,
        observation_ref=result.observation_ref,
        metrics=dict(result.metrics),
        usage=charged,
    )
    substrate.complete_command(command_id=cid, outcome=result.outcome, result=stored)
    return CommandResult(
        cid, kind, result.outcome, head, detail=result.detail,
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
                change=command.change, caused_by=cid,
                expected_state_ref=command.expected_state_ref,
            )
        return CommandResult(cid, kind, "ok", substrate.verify().head,
                             proposal=command.change, detail=command.change.summary)

    if isinstance(command, RevertChange):
        if command.change_id not in view.reverted_change_ids:
            substrate.revert(
                change_id=command.change_id, caused_by=cid,
                expected_state_ref=command.expected_state_ref,
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
        # A real implementation must give the model call an idempotency key and
        # record `indeterminate` on a dispatch-without-durable-result crash.
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
    both refs and the metered usage — even if active state later advances.
    Idempotent: a fork that already recorded its observation is REUSED, not
    re-executed or re-charged."""
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
        # REUSE the recorded attempts — do NOT re-run the executor — and ABSORB
        # the recorded usage so this process's meter reflects the durable spend
        # (the crashed process's live charge died with it).
        recorded = codec.loads(substrate.objects.get_text(existing), ObservationRecorded)
        fork = codec.loads(
            substrate.objects.get_text(recorded.observation_ref), ForkObservation
        )
        services.meter.absorb(fork.base.usage)
        services.meter.absorb(fork.candidate.usage)
        return CommandResult(
            cid, kind, "ok", view.head, observation_ref=existing,
            detail="fork already observed",
            metrics=_fork_metrics(fork.base_overall, fork.candidate_overall, fork.improved),
        )

    substrate.stage_change_closure(command.candidate, command.content_blobs)
    base_state = view.state
    base_ref = view.state_ref or ""
    candidate_state = apply_change(base_state, command.candidate, substrate.catalog)
    candidate_ref = substrate.put_state(candidate_state)

    base = _run_attempt(services, "base", base_state, base_ref)
    candidate = _run_attempt(services, "candidate", candidate_state, candidate_ref)
    observation = ForkObservation(
        candidate_change_id=command.candidate.change_id,
        base=base,
        candidate=candidate,
        improved=candidate.overall > base.overall,
        detail=command.detail,
    )
    updated = substrate.record_observation(
        observation_kind="fork-evaluation", observation=observation,
        subject_state_ref=candidate_ref, caused_by=cid,
    )
    ref = updated.envelopes[-1].body_ref
    return CommandResult(
        cid, kind, "ok", updated.head, observation_ref=ref, detail="fork evaluated",
        metrics=_fork_metrics(base.overall, candidate.overall, observation.improved),
    )


def _fork_metrics(base: float, candidate: float, improved: bool) -> dict[str, float]:
    return {
        "base_overall": base,
        "candidate_overall": candidate,
        "improved": 1.0 if improved else 0.0,
    }


def _usage_delta(before: BudgetUsage, after: BudgetUsage) -> BudgetUsage:
    return BudgetUsage(
        wall_time_s=round(max(0.0, after.wall_time_s - before.wall_time_s), 6),
        executions=after.executions - before.executions,
        model_calls=after.model_calls - before.model_calls,
        tokens=after.tokens - before.tokens,
        output_bytes=after.output_bytes - before.output_bytes,
        cost=after.cost - before.cost,
        recursion_depth=after.recursion_depth,
    )


def _budget_limits(services: KernelServices) -> SandboxLimits:
    """Cap the ACTUAL sandbox limits by the remaining wall/output budget, so a
    fork's execution can never exceed what the run has left to spend."""
    meter = services.meter
    default = SandboxLimits()
    remaining_wall = meter.remaining_wall_s()
    suite_deadline = (
        default.suite_deadline_s
        if remaining_wall == float("inf")
        else max(0.01, min(default.suite_deadline_s, remaining_wall))
    )
    return SandboxLimits(
        wall_time_s=meter.execution_timeout_s(default.wall_time_s),
        suite_deadline_s=suite_deadline,
        cpu_seconds=default.cpu_seconds,
        memory_bytes=default.memory_bytes,
        output_bytes=meter.execution_output_cap(default.output_bytes),
        open_files=default.open_files,
        max_processes=default.max_processes,
    )


def _run_attempt(
    services: KernelServices, label: str, state: HarnessState, state_ref: str
) -> AttemptRecord:
    """Execute one base-or-candidate attempt, recording the ACTUAL returned
    provenance, failure, denials, and the usage THIS attempt charged. Executions
    AND wall are gated pre-request; sandbox limits are capped by the budget."""
    meter = services.meter
    before = meter.usage()
    code_ref = state.content_ref("strategy-code", "solve")
    if code_ref is None:
        return AttemptRecord(
            label=label, state_ref=state_ref, overall=0.0, ok=True,
            provenance=services.executor.provenance(), failure=None, denials=(),
            usage=_usage_delta(before, meter.usage()),
        )
    source = services.substrate.objects.get_text(code_ref)
    cases = services.task.selection_cases()
    for _case in cases:
        denial = meter.request_execution()
        if denial is not None:
            raise KernelError(f"budget denied fork execution: {denial.detail}")
    outcome = services.executor.execute_suite(
        source, cases, generation_id=f"fork-{label}", limits=_budget_limits(services)
    )
    meter.note_output_bytes(outcome.report.stdout_bytes)
    evaluation = evaluate(services.task, outcome.report, cases)
    return AttemptRecord(
        label=label,
        state_ref=state_ref,
        overall=evaluation.overall_score,
        ok=outcome.report.ok and outcome.report.failure is None,
        provenance=outcome.provenance,  # ACTUAL boundary provenance
        failure=outcome.report.failure,
        denials=tuple(outcome.denials),
        usage=_usage_delta(before, meter.usage()),
    )


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
    """Rebuild the exact recorded result of an already-completed command —
    including its recorded head — so a resumed step sees the same
    `last_result` without repeating the effect."""
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
        head=stored.head, detail=stored.detail, proposal=proposal,
        observation_ref=stored.observation_ref, metrics=dict(stored.metrics),
    )


# -- strict, typed canonical encoding (NO permissive default=str coercion) ------------------------


def _config_ref(config: object) -> str:
    return hash_text(codec.dumps(_config_blob(config)))


def _config_blob(config: object) -> _ConfigBlob:
    return _ConfigBlob(encoding=_ENCODING, json=_strict_json(config))


def _state_blob(state: object) -> _PolicyStateBlob:
    return _PolicyStateBlob(encoding=_ENCODING, json=_strict_json(state))


def _policy_digest(policy: AdaptationPolicy[Any, Any]) -> str:
    """A reconstructable identity of the policy's full package, not merely its
    class source: the policy module's ENTIRE source (its helpers, config
    dataclass, and strategy dependencies living in the same module) plus the
    module qualname. A change to any of them shifts the digest and is detected
    on resume."""
    cls = type(policy)
    import sys

    module = sys.modules.get(cls.__module__)
    try:
        source = inspect.getsource(module) if module is not None else inspect.getsource(cls)
    except (OSError, TypeError):
        source = cls.__qualname__
    return hash_text(f"{cls.__module__}.{cls.__qualname__}\n{source}")


def _strict_json(obj: object) -> str:
    return json.dumps(_strict_encode(obj), sort_keys=True, separators=(",", ":"))


# a command's IDENTITY excludes preconditions that legitimately vary across a
# resume (they gate execution but do not change WHAT the command is).
_COMMAND_NON_IDENTITY_FIELDS = frozenset({"expected_state_ref"})


def _command_identity_json(command: object) -> str:
    data = _strict_encode(command)
    if isinstance(data, dict):
        for field in _COMMAND_NON_IDENTITY_FIELDS:
            data.pop(field, None)
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def _strict_encode(value: object) -> object:
    if isinstance(value, bool) or value is None or isinstance(value, (int, float, str)):
        return value
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            f.name: _strict_encode(getattr(value, f.name))
            for f in dataclasses.fields(value)
        }
    if isinstance(value, (list, tuple)):
        return [_strict_encode(item) for item in value]
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, val in value.items():
            if not isinstance(key, str):
                raise KernelError(
                    f"cannot canonically encode a non-string dict key {key!r}"
                )
            out[key] = _strict_encode(val)
        return out
    raise KernelError(
        f"cannot canonically encode a value of type {type(value).__name__} "
        "(strict encoding refuses to coerce)"
    )


def _load_state_json(substrate: Substrate, ref: str) -> object:
    blob = codec.loads(substrate.objects.get_text(ref), _PolicyStateBlob)
    if blob.encoding != _ENCODING:
        raise KernelError(
            f"policy state was encoded with {blob.encoding!r}, this build uses "
            f"{_ENCODING!r} — refusing to guess"
        )
    return json.loads(blob.json)


__all__ = [
    "AttemptRecord",
    "ForkObservation",
    "IndeterminateEffect",
    "KernelError",
    "KernelServices",
    "RunReport",
    "operator_revert",
    "run_policy",
]
