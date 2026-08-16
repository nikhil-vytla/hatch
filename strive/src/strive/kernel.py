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
from strive.contracts import BudgetSpec, BudgetUsage, CaseOutcome, ExecutionReport
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
from strive.runtime import (
    ENCODING as _ENCODING,
    FORK_DISPATCH,
    FORK_RESULT,
    FORK_SUMMARY,
    AttemptDispatched,
    AttemptRecord,
    CommandPayload,
    ConfigBlob,
    ForkObservation,
    PolicyStateBlob,
    StoredResult,
)
from strive.sandboxes import (
    CandidateExecutor,
    SandboxLimits,
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


class KernelError(Exception):
    """A kernel orchestration/identity failure (never a policy proposal
    failure — those come back inside a CommandResult)."""


class IndeterminateEffect(Exception):
    """Raised when a command DISPATCHED an external effect but no durable
    result is recoverable and there is no idempotency key. The kernel records
    the command `indeterminate` (durable) and requires an EXPLICIT retry — it
    never silently re-dispatches and claims exactly-once."""


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
    """Rebuild a FRESH meter from the DURABLE per-attempt ledger (never absorb
    repeatedly into a reused meter). Each fork attempt is counted exactly once:
    its actual usage if a RESULT was journaled, else its worst-case reservation
    if only a DISPATCH is on record (an open dispatch — spend conservatively
    reserved so a crash-loop can never expand the budget). Non-fork commands
    spend nothing."""
    substrate = services.substrate
    fresh = BudgetMeter(services.meter.spec)
    results: dict[tuple[str, str], BudgetUsage] = {}
    dispatched: dict[tuple[str, str], int] = {}
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if not isinstance(body, ObservationRecorded):
            continue
        if body.observation_kind == FORK_RESULT:
            rec = codec.loads(substrate.objects.get_text(body.observation_ref), AttemptRecord)
            results[(rec.command_id, rec.label)] = rec.usage
        elif body.observation_kind == FORK_DISPATCH:
            disp = codec.loads(
                substrate.objects.get_text(body.observation_ref), AttemptDispatched
            )
            dispatched[(disp.command_id, disp.label)] = disp.reserved_executions
    for usage in results.values():
        fresh.absorb(usage)
    for key, reserved in dispatched.items():
        if key not in results:  # OPEN dispatch: reserve the worst case
            fresh.absorb(BudgetUsage(executions=reserved))
    services.meter = fresh


def _fork_attempts(
    services: KernelServices, view: VerifiedSubstrateView, cid: str
) -> dict[str, tuple[str, AttemptRecord | None]]:
    """The durable base/candidate attempt state for a fork command:
    ``label -> ("result", AttemptRecord)`` or ``("dispatched", None)`` (open)."""
    substrate = services.substrate
    out: dict[str, tuple[str, AttemptRecord | None]] = {}
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if env.caused_by != cid or not isinstance(body, ObservationRecorded):
            continue
        if body.observation_kind == FORK_DISPATCH:
            disp = codec.loads(
                substrate.objects.get_text(body.observation_ref), AttemptDispatched
            )
            out.setdefault(disp.label, ("dispatched", None))
        elif body.observation_kind == FORK_RESULT:
            rec = codec.loads(substrate.objects.get_text(body.observation_ref), AttemptRecord)
            out[rec.label] = ("result", rec)
    return out


def _fork_summary_ref(view: VerifiedSubstrateView, cid: str) -> str | None:
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if (
            env.caused_by == cid
            and isinstance(body, ObservationRecorded)
            and body.observation_kind == FORK_SUMMARY
        ):
            return body.observation_ref
    return None


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
        CommandPayload(
            command_id=cid, kind=kind, encoding=_ENCODING,
            change_ref=_command_change_ref(substrate, command),
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
    stored = StoredResult(
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
    """OPTIONAL comparative mechanism. Journals each base/candidate attempt as
    a DISPATCH then a RESULT (separately, before the next attempt), so a crash
    between dispatch and result is an OPEN dispatch — reconciled as
    `indeterminate`, never implicitly re-run. A completed fork's summary is
    reused verbatim; the budget is reconstructed from the durable attempt
    ledger by `_seed_meter`, never re-charged here."""
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__

    if not _already_proposed(view, command.candidate.change_id):
        substrate.record_proposal(
            change=command.candidate, strategy_ref=command.detail or "fork", caused_by=cid
        )

    summary_ref = _fork_summary_ref(view, cid)
    if summary_ref is not None:
        fork = codec.loads(substrate.objects.get_text(summary_ref), ForkObservation)
        return CommandResult(
            cid, kind, "ok", view.head, observation_ref=summary_ref,
            detail="fork already observed",
            metrics=_fork_metrics(fork.base_overall, fork.candidate_overall, fork.improved),
        )

    substrate.stage_change_closure(command.candidate, command.content_blobs)
    base_state = view.state
    base_ref = view.state_ref or ""
    candidate_state = apply_change(base_state, command.candidate, substrate.catalog)
    candidate_ref = substrate.put_state(candidate_state)

    prior = _fork_attempts(services, view, cid)
    reserved = len(services.task.selection_cases())
    attempts: dict[str, AttemptRecord] = {}
    for label, st, ref in [
        ("base", base_state, base_ref),
        ("candidate", candidate_state, candidate_ref),
    ]:
        status = prior.get(label)
        if status is not None and status[0] == "result":
            assert status[1] is not None
            attempts[label] = status[1]  # reuse; usage already reseeded
            continue
        if status is not None and status[0] == "dispatched":
            # dispatched but no durable result: NEVER implicitly re-run
            raise IndeterminateEffect(
                f"fork {label!r} attempt dispatched without a durable result"
            )
        # fresh attempt: DISPATCH (durable) → run → RESULT (durable)
        substrate.record_observation(
            observation_kind=FORK_DISPATCH,
            observation=AttemptDispatched(cid, label, ref, reserved),
            subject_state_ref=ref, caused_by=cid,
        )
        rec = _run_attempt(services, cid, label, st, ref)
        substrate.record_observation(
            observation_kind=FORK_RESULT, observation=rec,
            subject_state_ref=ref, caused_by=cid,
        )
        attempts[label] = rec

    base, candidate = attempts["base"], attempts["candidate"]
    if not base.ok or not candidate.ok:
        # a partial/failed attempt is durably recorded (provenance, failure,
        # usage preserved); the fork command itself fails.
        raise KernelError(
            f"fork attempt failed (base ok={base.ok}, candidate ok={candidate.ok})"
        )
    observation = ForkObservation(
        candidate_change_id=command.candidate.change_id,
        base=base, candidate=candidate,
        improved=candidate.overall > base.overall, detail=command.detail,
    )
    updated = substrate.record_observation(
        observation_kind=FORK_SUMMARY, observation=observation,
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
    services: KernelServices, cid: str, label: str, state: HarnessState, state_ref: str
) -> AttemptRecord:
    """Execute one base/candidate attempt CASE-BY-CASE, enforcing CUMULATIVE
    output and wall across cases (each case's sandbox caps come from the
    REMAINING budget, not a fresh per-case cap). Returns an AttemptRecord even
    when the attempt is denied/fails mid-suite — with the ACTUAL provenance,
    failure, denials, and the usage it actually charged — so charges and
    provenance survive to the next crash point (`ok=False` on any failure)."""
    meter = services.meter
    before = meter.usage()
    code_ref = state.content_ref("strategy-code", "solve")
    if code_ref is None:
        return AttemptRecord(
            command_id=cid, label=label, state_ref=state_ref, overall=0.0, ok=True,
            provenance=services.executor.provenance(), failure=None, denials=(),
            usage=_usage_delta(before, meter.usage()),
        )
    source = services.substrate.objects.get_text(code_ref)
    cases = services.task.selection_cases()
    outcomes: list[CaseOutcome] = []
    denials: list[str] = []
    provenance = None
    failure = None
    for case in cases:
        denial = meter.request_execution()  # cumulative executions + wall gate
        if denial is not None:
            failure = denial
            break
        result = services.executor.execute_suite(
            source, [case], generation_id=f"fork-{label}",
            limits=_budget_limits(services),  # caps from REMAINING budget
        )
        meter.note_output_bytes(result.report.stdout_bytes)  # cumulative output
        provenance = result.provenance
        denials.extend(result.denials)
        outcomes.extend(result.report.outcomes)
        if result.report.failure is not None and failure is None:
            failure = result.report.failure
    if provenance is None:  # denied before any case ran
        provenance = services.executor.provenance()
    report = ExecutionReport(
        ok=failure is None,
        generation_id=f"fork-{label}",
        outcomes=tuple(outcomes),
        failure=failure,
        stdout_bytes=sum(len(o.error or "") for o in outcomes),
    )
    evaluation = evaluate(services.task, report, cases)
    return AttemptRecord(
        command_id=cid, label=label, state_ref=state_ref,
        overall=evaluation.overall_score, ok=failure is None,
        provenance=provenance, failure=failure, denials=tuple(denials),
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
    stored = codec.loads(substrate.objects.get_text(terminal.result_ref), StoredResult)
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


def _config_blob(config: object) -> ConfigBlob:
    return ConfigBlob(encoding=_ENCODING, json=_strict_json(config))


def _state_blob(state: object) -> PolicyStateBlob:
    return PolicyStateBlob(encoding=_ENCODING, json=_strict_json(state))


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


def _command_identity_json(command: object) -> str:
    """The FULL canonical command is its durable identity — INCLUDING its
    `expected_state_ref` precondition. A changed precondition before an effect
    is a changed command and fails closed."""
    return json.dumps(_strict_encode(command), sort_keys=True, separators=(",", ":"))


def _command_change_ref(substrate: Substrate, command: KernelCommand) -> str | None:
    """The CAS ref of the CompositeChange a change-bearing command targets, so
    verification can match an effect to its command's ACTUAL change."""
    if isinstance(command, ApplyChange):
        return substrate.put(command.change)
    if isinstance(command, EvaluateFork):
        return substrate.put(command.candidate)
    return None


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
    blob = codec.loads(substrate.objects.get_text(ref), PolicyStateBlob)
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

# re-exported from the neutral runtime module for backward-compatible imports
_ = (AttemptRecord, ForkObservation)
