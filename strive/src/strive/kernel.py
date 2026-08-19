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

import inspect
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from strive import codec
from strive.budget import BudgetMeter
from strive.cas import ObjectCorruption, ObjectMissing, hash_text
from strive.contracts import (
    FAILURE_MALFORMED_OUTPUT,
    FAILURE_MODEL_ERROR,
    BudgetSpec,
    BudgetUsage,
    CaseOutcome,
    ExecutionReport,
    FailureRecord,
    ModelRequest,
)
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
from strive.model import ModelAdapter, ModelCatalog
from strive.refine import RefinementDecodeError, decode_proposal, render_prompt
from strive.runtime import (
    ENCODING as _ENCODING,
    FORK_DISPATCH,
    FORK_RESULT,
    FORK_SUMMARY,
    REFINE_DISPATCH,
    REFINE_RESULT,
    AttemptDispatched,
    AttemptRecord,
    CommandPayload,
    ConfigBlob,
    ForkObservation,
    ModelDispatch,
    ModelResult,
    PolicyStateBlob,
    RefinementProposal,
    StoredResult,
    combine_usage,
    model_dispatch_reservation,
    model_result_usage,
    strict_encode,
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
    OperationFailed,
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
    # the injected, immutable model-adapter catalog and the run's model role;
    # `RequestRefinement` resolves its adapter here — the policy never sees one.
    models: ModelCatalog | None = None
    model_role: str = "refine"

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
        models: ModelCatalog | None = None,
        model_role: str = "refine",
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
            models=models,
            model_role=model_role,
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
    policy_digest = _policy_digest(policy, descriptor.dependency_modules)
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
            state = policy.initial_state(
                config, RunView.of(services.seed, view, substrate.objects)
            )
            consumed = None

        commands = 0
        stopped_reason = "max-commands"
        while commands < max_commands:
            view = substrate.verify()
            substrate._require_ok(view, "run")
            run_view = RunView.of(services.seed, view, substrate.objects)
            command = policy.next_command(config, state, run_view)
            if command is None:
                stopped_reason = "done"
                break
            result = _run_command(services, view, command)
            # after every terminal/reconciliation, rebuild the live meter from
            # the DURABLE external-effect ledger BEFORE the policy emits another
            # command — the live budget always equals the durable ledger.
            _seed_meter(services, substrate.verify())
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
    """Rebuild a FRESH meter from the DURABLE ledger (never absorb repeatedly
    into a reused meter). Each fork attempt AND each model call is counted
    exactly once: its actual usage if a RESULT was journaled, else its
    worst-case reservation if only a DISPATCH is on record (an open dispatch —
    spend conservatively reserved so a crash-loop can never expand any budget
    dimension, including model calls). Commands with no external effect spend
    nothing."""
    substrate = services.substrate
    fresh = BudgetMeter(services.meter.spec)
    results: dict[tuple[str, str], BudgetUsage] = {}
    dispatched: dict[tuple[str, str], AttemptDispatched] = {}
    model_results: dict[str, ModelResult] = {}
    model_dispatches: dict[str, ModelDispatch] = {}
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
            dispatched[(disp.command_id, disp.label)] = disp
        elif body.observation_kind == REFINE_RESULT:
            res = codec.loads(substrate.objects.get_text(body.observation_ref), ModelResult)
            model_results[res.command_id] = res
        elif body.observation_kind == REFINE_DISPATCH:
            mdisp = codec.loads(substrate.objects.get_text(body.observation_ref), ModelDispatch)
            model_dispatches[mdisp.command_id] = mdisp
    for usage in results.values():
        fresh.absorb(usage)
    for key, disp in dispatched.items():
        if key not in results:  # OPEN fork dispatch: reserve the worst case (all dims)
            fresh.absorb(BudgetUsage(
                executions=disp.reserved_executions,
                wall_time_s=disp.reserved_wall_s,
                output_bytes=disp.reserved_output_bytes,
            ))
    for res in model_results.values():
        fresh.absorb(model_result_usage(res))
    for cid, mdisp in model_dispatches.items():
        if cid not in model_results:  # OPEN model dispatch: reserve the worst case
            fresh.absorb(model_dispatch_reservation(mdisp))
    services.meter = fresh


def _reconciled_usage(
    services: KernelServices, view: VerifiedSubstrateView, cid: str
) -> BudgetUsage:
    """The honest usage a command spent, reconstructed from its DURABLE attempt
    ledger (never a live meter delta, which a resume would undercount, and never
    zero): each completed attempt's actual usage, plus each OPEN dispatch's
    worst-case reservation. Non-fork commands spend nothing. This is exactly the
    per-command contribution `_seed_meter` folds into the live budget, so a
    terminal's recorded usage equals what the budget actually charged."""
    substrate = services.substrate
    results: dict[str, BudgetUsage] = {}
    dispatched: dict[str, AttemptDispatched] = {}
    model_results: list[ModelResult] = []
    model_dispatches: list[ModelDispatch] = []
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if env.caused_by != cid or not isinstance(body, ObservationRecorded):
            continue
        if body.observation_kind == FORK_RESULT:
            rec = codec.loads(substrate.objects.get_text(body.observation_ref), AttemptRecord)
            results[rec.label] = rec.usage
        elif body.observation_kind == FORK_DISPATCH:
            disp = codec.loads(
                substrate.objects.get_text(body.observation_ref), AttemptDispatched
            )
            dispatched[disp.label] = disp
        elif body.observation_kind == REFINE_RESULT:
            model_results.append(
                codec.loads(substrate.objects.get_text(body.observation_ref), ModelResult)
            )
        elif body.observation_kind == REFINE_DISPATCH:
            model_dispatches.append(
                codec.loads(substrate.objects.get_text(body.observation_ref), ModelDispatch)
            )
    usages = list(results.values())
    for label, disp in dispatched.items():
        if label not in results:  # open fork dispatch: reserve the worst case
            usages.append(BudgetUsage(
                executions=disp.reserved_executions,
                wall_time_s=disp.reserved_wall_s,
                output_bytes=disp.reserved_output_bytes,
            ))
    # a completed model call charges its actual usage; an OPEN model dispatch
    # reserves the worst case (a result overrides its dispatch)
    if model_results:
        usages.extend(model_result_usage(r) for r in model_results)
    else:
        usages.extend(model_dispatch_reservation(d) for d in model_dispatches)
    return combine_usage(usages)


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


def _fork_summary(
    services: KernelServices, view: VerifiedSubstrateView, cid: str
) -> tuple[str, ForkObservation] | None:
    """The fork command's durable summary, if present: the (ObservationRecorded
    EVENT body ref, decoded ForkObservation). The event body ref — not the
    inner ref — is what `StoredResult.observation_ref` records, so the initial
    and reconstructed results are byte-for-byte equivalent."""
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if (
            env.caused_by == cid
            and isinstance(body, ObservationRecorded)
            and body.observation_kind == FORK_SUMMARY
        ):
            fork = codec.loads(
                services.substrate.objects.get_text(body.observation_ref), ForkObservation
            )
            return env.body_ref, fork
    return None


# -- RequestRefinement: model call → typed proposal, journaled once ---------------------------------

_PROMPT_TEMPLATE_SURFACE = ("prompt", "proposal-template")
_DEFAULT_MODEL_MAX_TOKENS = 1024
_DEFAULT_MODEL_TIMEOUT_S = 60.0


def _refinement_result(
    services: KernelServices, view: VerifiedSubstrateView, cid: str
) -> tuple[str, ModelResult] | None:
    """The refinement's durable model result, if present: (the
    ObservationRecorded EVENT body ref, the decoded ModelResult). The event
    body ref is what `StoredResult.observation_ref` records."""
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if (
            env.caused_by == cid
            and isinstance(body, ObservationRecorded)
            and body.observation_kind == REFINE_RESULT
        ):
            res = codec.loads(
                services.substrate.objects.get_text(body.observation_ref), ModelResult
            )
            return env.body_ref, res
    return None


def _refinement_dispatched(
    view: VerifiedSubstrateView, cid: str
) -> bool:
    return any(
        env.caused_by == cid
        and isinstance(body, ObservationRecorded)
        and body.observation_kind == REFINE_DISPATCH
        for env, body in zip(view.envelopes, view.bodies, strict=True)
    )


def _active_prompt_template(view: VerifiedSubstrateView, substrate: Substrate) -> str:
    """The ACTIVE proposal-template surface content — the prompt that genuinely
    shapes this refinement. Missing/unreadable content is a hard error (a
    refinement cannot run without its control surface)."""
    ref = view.state.content_ref(*_PROMPT_TEMPLATE_SURFACE)
    if ref is None:
        raise KernelError(
            f"active state has no {_PROMPT_TEMPLATE_SURFACE} surface to render a prompt"
        )
    return substrate.objects.get_text(ref)


def _run_refinement(
    services: KernelServices, view: VerifiedSubstrateView, command: RequestRefinement
) -> CommandResult:
    """Perform ONE model refinement, journaled exactly like a fork attempt: a
    DISPATCH (durable, before the call) then a RESULT (durable, after). The
    prompt is rendered from the ACTIVE proposal-template surface + the policy's
    context, so the active prompt genuinely shapes the proposal. A crash
    between dispatch and result is an OPEN dispatch — reconciled as
    `indeterminate`, never silently re-called. A model error, budget denial,
    overrun, or malformed output is failure-as-data (a `failed` terminal with a
    durable model result recording the failure)."""
    substrate = services.substrate
    cid = command.command_id
    kind = "RequestRefinement"

    # reuse a durable result across a crash between the result and the terminal
    existing = _refinement_result(services, view, cid)
    if existing is not None:
        result_event_ref, prior = existing
        if prior.failure is not None:
            raise KernelError(prior.failure.detail)  # → failed terminal (same outcome)
        return CommandResult(
            cid, kind, "ok", view.head, observation_ref=result_event_ref,
            detail="refinement already observed",
        )
    # an OPEN dispatch (dispatched but no durable result): never silently re-call
    if _refinement_dispatched(view, cid):
        raise IndeterminateEffect(
            "model dispatched without a durable result — explicit retry required"
        )

    if services.models is None:
        raise KernelError(
            "RequestRefinement requires an injected model catalog (none bound)"
        )
    adapter: ModelAdapter = services.models.resolve(services.model_role)

    # stage the policy's context bytes, then render the prompt from the ACTIVE
    # template + that context
    for ref, content in command.content_blobs.items():
        if hash_text(content) != ref:
            raise KernelError(f"refinement context does not hash to its ref {ref[:12]}…")
        substrate.objects.put_text(content)
    try:
        context = substrate.objects.get_text(command.context_ref)
    except (ObjectMissing, ObjectCorruption) as exc:
        raise KernelError(f"refinement context ref unreadable: {exc}") from None
    # the pinned CONTROL prompt for this role (refine.md / review.md), from the
    # authoritative PolicyBound — a role with no pinned prompt is a hard error
    if view.bound is None:
        raise KernelError("cannot refine before the policy is bound")
    control_ref = view.bound.prompt_refs.get(command.prompt_role)
    if control_ref is None:
        raise KernelError(
            f"no pinned control prompt for role {command.prompt_role!r} "
            f"(pinned roles: {sorted(view.bound.prompt_refs)})"
        )
    control = substrate.objects.get_text(control_ref)
    template = _active_prompt_template(view, substrate)
    prompt = render_prompt(control, template, context)
    prompt_ref = substrate.objects.put_text(prompt)

    # budget FIRST (deterministic, re-derivable): a pre-call denial fails the
    # command with NO dispatch/result effects, so nothing is charged or replayed
    meter = services.meter
    denial = meter.request_model_call()
    if denial is not None:
        raise KernelError(denial.detail)
    timeout = meter.model_call_timeout_s(_DEFAULT_MODEL_TIMEOUT_S)
    max_tokens = meter.cap_output_tokens(_DEFAULT_MODEL_MAX_TOKENS)

    subject = view.state_ref or ""
    dispatch = ModelDispatch(
        command_id=cid, prompt_role=command.prompt_role, prompt_ref=prompt_ref,
        adapter_name=adapter.adapter_name, model_id=adapter.model_id,
        max_tokens=max_tokens, temperature=0.0, seed=services.seed,
        idempotency_key=f"{substrate.run_id}:{cid}",
        reserved_tokens=max_tokens, reserved_wall_s=round(timeout, 6),
    )
    substrate.record_observation(
        observation_kind=REFINE_DISPATCH, observation=dispatch,
        subject_state_ref=subject, caused_by=cid,
    )

    request = ModelRequest(
        prompt=prompt, max_tokens=max_tokens, temperature=0.0,
        seed=services.seed, timeout_s=timeout,
    )
    started = time.monotonic()
    response = None
    failure: FailureRecord | None = None
    try:
        response = adapter.complete(request)
    except Exception as exc:  # noqa: BLE001 — any adapter error is data
        failure = FailureRecord(
            kind=FAILURE_MODEL_ERROR, detail=f"{type(exc).__name__}: {exc}"
        )
    latency_ms = round((time.monotonic() - started) * 1000.0, 3)

    proposal_ref: str | None = None
    response_ref: str | None = None
    input_tokens = output_tokens = 0
    cost = 0.0
    finish_reason = "error"
    model_id = adapter.model_id
    if response is not None:
        input_tokens, output_tokens = response.input_tokens, response.output_tokens
        cost, finish_reason, model_id = response.cost, response.finish_reason, response.model_id
        meter.note_model_usage(tokens=input_tokens + output_tokens, cost=cost)
        response_ref = substrate.objects.put_text(response.text)
        overrun = meter.tokens_overrun() or meter.cost_overrun()
        if overrun is not None:
            failure = overrun
        else:
            try:
                proposal, blobs = decode_proposal(
                    response.text, catalog=substrate.catalog,
                    allowed_surfaces=frozenset(substrate.catalog.keys()),
                )
                for ref, content in blobs.items():
                    substrate.objects.put_text(content)
                proposal_ref = substrate.put(proposal)
            except RefinementDecodeError as exc:
                failure = FailureRecord(kind=FAILURE_MALFORMED_OUTPUT, detail=str(exc))

    result = ModelResult(
        command_id=cid, prompt_role=command.prompt_role, adapter_name=adapter.adapter_name,
        model_id=model_id, response_ref=response_ref, input_tokens=input_tokens,
        output_tokens=output_tokens, cost=cost, latency_ms=latency_ms,
        finish_reason=finish_reason, provider_extras={}, failure=failure,
        proposal_ref=proposal_ref,
    )
    substrate.record_observation(
        observation_kind=REFINE_RESULT, observation=result,
        subject_state_ref=subject, caused_by=cid,
    )
    if failure is not None:
        raise KernelError(failure.detail)  # → failed terminal (usage still reconciled)
    found = _refinement_result(services, substrate.verify(), cid)
    assert found is not None  # just journaled
    result_event_ref, _ = found
    return CommandResult(
        cid, kind, "ok", substrate.verify().head,
        observation_ref=result_event_ref, detail="refinement observed",
    )


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


def _require_settled_before_issue(view: VerifiedSubstrateView, cid: str) -> None:
    """Refuse a new issue unless every prior command is SETTLED: it has a
    terminal AND a checkpoint consumed it. This is the loop's one-in-flight
    discipline (issue → terminal → checkpoint → next issue) enforced at the
    kernel boundary, so a policy bug can never leave two commands open."""
    from strive.substrate import PolicyCheckpointed

    prior_issued = set(view.issued) - {cid}
    open_prior = prior_issued - set(view.completed)
    if open_prior:
        raise KernelError(
            f"cannot issue {cid!r} while prior command(s) {sorted(open_prior)} "
            "have no terminal (one in-flight command at a time)"
        )
    consumed = {
        body.consumed_command_id
        for body in view.bodies
        if isinstance(body, PolicyCheckpointed) and body.consumed_command_id is not None
    }
    unchecked = prior_issued - consumed
    if unchecked:
        raise KernelError(
            f"cannot issue {cid!r} while prior command(s) {sorted(unchecked)} "
            "lack a consuming checkpoint (terminal+checkpoint required first)"
        )


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
    command_ref = substrate.put(_command_payload(substrate, view, command))
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

    # a prior process recorded a failure/indeterminate but crashed before the
    # terminal: RECONCILE it into the terminal with the SAME outcome — never
    # re-run the operation.
    existing_failure = _existing_failure(view, cid)
    if existing_failure is not None:
        return _reconcile_failure(services, command, existing_failure)

    # ONE in-flight command: a genuinely NEW issue is refused while any prior
    # command lacks a terminal, or any completed command lacks a checkpoint —
    # so the loop can only ever advance issue → terminal → checkpoint → issue.
    if cid not in view.issued:
        _require_settled_before_issue(view, cid)
    # `issue_command` is idempotent (same id+digest is a read, not a 2nd intent)
    substrate.issue_command(command_id=cid, command_kind=kind, command_ref=command_ref)

    try:
        result = _perform(services, substrate.verify(), command)
        outcome, detail = "ok", result.detail
    except IndeterminateEffect as exc:
        # dispatched, but no durable result is recoverable: record it honestly
        # and REQUIRE an explicit retry — never silently re-dispatch. The stored
        # detail is the SAME string as the recorded failure (verify binds them).
        indeterminate_detail = f"indeterminate: {exc}"
        substrate.record_failure(
            command_id=cid, kind=kind, detail=indeterminate_detail,
            outcome="indeterminate",
        )
        result = CommandResult(cid, kind, "indeterminate", "", detail=indeterminate_detail)
        outcome, detail = "indeterminate", indeterminate_detail
    except (SubstrateError, KernelError) as exc:
        substrate.record_failure(command_id=cid, kind=kind, detail=str(exc), outcome="failed")
        result = CommandResult(cid, kind, "failed", "", detail=str(exc))
        outcome, detail = "failed", str(exc)
    # a terminal's recorded usage is ALWAYS the reconciled durable attempt
    # ledger — each completed attempt's actual usage plus each open dispatch's
    # reservation (zero for a non-fork command, which runs no sandbox). This is
    # exactly what `_seed_meter` folds into the live budget, so recorded ==
    # charged for every outcome, and a crashed partial fork is never lost.
    charged = _reconciled_usage(services, substrate.verify(), cid)

    # the command's canonical SEMANTIC head — position + folded state — just
    # before the terminal; both the initial run and a reconstruction return it.
    head = _semantic_head(substrate)
    stored = StoredResult(
        command_id=cid,
        kind=kind,
        outcome=outcome,
        head=head,
        detail=detail,
        proposal_ref=substrate.put(result.proposal) if result.proposal else None,
        observation_ref=result.observation_ref,
        metrics=dict(result.metrics),
        usage=charged,
    )
    substrate.complete_command(command_id=cid, outcome=outcome, result=stored)
    return CommandResult(
        cid, kind, outcome, head, detail=detail,
        proposal=result.proposal, observation_ref=result.observation_ref,
        metrics=result.metrics,
    )


def _semantic_head(substrate: Substrate) -> str:
    """The pre-terminal semantic head: ``"<seq>:<state_ref>"`` — position and
    folded state, deterministic and reconstructable by verify (unlike the
    framing head, whose frame hashes fold in wall-clock timestamps)."""
    v = substrate.verify()
    return f"{v.seq}:{v.state_ref or ''}"


def _existing_failure(view: VerifiedSubstrateView, cid: str) -> OperationFailed | None:
    for env, body in zip(view.envelopes, view.bodies, strict=True):
        if env.caused_by == cid and isinstance(body, OperationFailed):
            return body
    return None


def _reconcile_failure(
    services: KernelServices, command: KernelCommand, failure: OperationFailed
) -> CommandResult:
    """Complete a command whose failure was durably recorded before a crash —
    with the recorded outcome — WITHOUT re-running the operation. Its usage is
    reconciled from the durable attempt ledger (completed attempts + open
    reservations), never written as zero, so a crashed partial fork is still
    charged for the work it actually did."""
    substrate = services.substrate
    cid = command.command_id
    kind = type(command).__name__
    head = _semantic_head(substrate)
    stored = StoredResult(
        command_id=cid, kind=kind, outcome=failure.outcome, head=head,
        detail=failure.detail, proposal_ref=None, observation_ref=None,
        metrics={}, usage=_reconciled_usage(services, substrate.verify(), cid),
    )
    substrate.complete_command(command_id=cid, outcome=failure.outcome, result=stored)
    return CommandResult(cid, kind, failure.outcome, head, detail=failure.detail)


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
        return _run_refinement(services, view, command)
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

    existing_summary = _fork_summary(services, view, cid)
    if existing_summary is not None:
        summary_event_ref, fork = existing_summary
        return CommandResult(
            cid, kind, "ok", view.head, observation_ref=summary_event_ref,
            detail="fork already observed",
            metrics=_fork_metrics(fork.base_overall, fork.candidate_overall, fork.improved),
        )

    substrate.stage_change_closure(command.candidate, command.content_blobs)
    base_state = view.state
    base_ref = view.state_ref or ""
    candidate_state = apply_change(base_state, command.candidate, substrate.catalog)
    candidate_ref = substrate.put_state(candidate_state)

    prior = _fork_attempts(services, view, cid)
    # a CONSERVATIVE per-attempt reservation across EVERY countable dimension:
    # the worst case a running attempt could durably charge (one per case at
    # the default per-case sandbox caps), so an open dispatch reserves
    # executions AND wall AND output — never executions alone.
    n_cases = len(services.task.selection_cases())
    _cap = SandboxLimits()
    reserved_exec = n_cases
    reserved_wall = round(n_cases * _cap.wall_time_s, 6)
    reserved_out = n_cases * _cap.output_bytes
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
            observation=AttemptDispatched(
                cid, label, ref, reserved_exec, reserved_wall, reserved_out
            ),
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
    substrate = services.substrate
    before = meter.usage()
    code_ref = state.content_ref("strategy-code", "solve")
    if code_ref is None:
        empty = ExecutionReport(ok=True, generation_id=f"fork-{label}", outcomes=())
        evaluation = evaluate(services.task, empty, services.task.selection_cases())
        return AttemptRecord(
            command_id=cid, label=label, state_ref=state_ref,
            overall=evaluation.overall_score, ok=True,
            provenance=services.executor.provenance(), failure=None, denials=(),
            usage=_usage_delta(before, meter.usage()),
            report_ref=substrate.put(empty), evaluation_ref=substrate.put(evaluation),
        )
    source = services.substrate.objects.get_text(code_ref)
    cases = services.task.selection_cases()
    outcomes: list[CaseOutcome] = []
    denials: list[str] = []
    provenance = None
    failure = None
    total_stdout = 0
    total_wall = 0.0
    for case in cases:
        denial = meter.request_execution()  # cumulative executions + wall gate
        if denial is not None:
            failure = denial
            break
        result = services.executor.execute_suite(
            source, [case], generation_id=f"fork-{label}",
            limits=_budget_limits(services),  # caps from REMAINING budget
        )
        meter.note_output_bytes(result.report.stdout_bytes)  # ACTUAL captured bytes
        total_stdout += result.report.stdout_bytes
        total_wall += result.report.wall_time_s
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
        wall_time_s=round(total_wall, 6),
        stdout_bytes=total_stdout,  # ACTUAL captured output, not error-string length
    )
    evaluation = evaluate(services.task, report, cases)
    # preserve the FULL evidence: the exact ExecutionReport (per-case
    # outputs/errors, backend failure, wall/output) and its Evaluation
    # (per-case scores/feedback) — never collapsed to only the aggregate.
    return AttemptRecord(
        command_id=cid, label=label, state_ref=state_ref,
        overall=evaluation.overall_score, ok=failure is None,
        provenance=provenance, failure=failure, denials=tuple(denials),
        usage=_usage_delta(before, meter.usage()),
        report_ref=substrate.put(report), evaluation_ref=substrate.put(evaluation),
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
    # verify guarantees EVERY terminal has a StoredResult — no None fallback
    assert terminal.result_ref is not None
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


def _policy_digest(
    policy: AdaptationPolicy[Any, Any], dependency_modules: tuple[str, ...] = ()
) -> str:
    """A reconstructable identity of the policy's full PACKAGE manifest: the
    policy module's ENTIRE source (its helpers, config dataclass, and strategy
    dependencies living in the same module) plus the module qualname, PLUS the
    source of every explicitly-declared `dependency_modules` (strategy/helper
    modules the policy relies on OUTSIDE its own module). A change to any part
    of the manifest shifts the digest and is detected on resume."""
    import importlib
    import sys

    cls = type(policy)

    def _module_source(name: str) -> str:
        # IMPORT every declared dependency before hashing, so its digest is the
        # real source — never a fallback to the bare name because it happened
        # not to be imported yet (which would blind resume to a dep change).
        module = sys.modules.get(name)
        if module is None:
            try:
                module = importlib.import_module(name)
            except ImportError as exc:
                raise KernelError(
                    f"declared policy dependency module {name!r} cannot be "
                    f"imported for hashing: {exc}"
                ) from None
        try:
            return inspect.getsource(module)
        except (OSError, TypeError):
            return name

    try:
        own = inspect.getsource(sys.modules[cls.__module__])
    except (OSError, TypeError, KeyError):
        try:
            own = inspect.getsource(cls)
        except (OSError, TypeError):
            own = cls.__qualname__
    parts = [f"{cls.__module__}.{cls.__qualname__}\n{own}"]
    for dep in sorted(dependency_modules):
        parts.append(f"{dep}\n{_module_source(dep)}")
    return hash_text("\n--dep--\n".join(parts))


def _strict_json(obj: object) -> str:
    return json.dumps(strict_encode(obj), sort_keys=True, separators=(",", ":"))


def _command_identity_json(command: object) -> str:
    """The FULL canonical command is its durable identity — INCLUDING its
    `expected_state_ref` precondition. A changed precondition before an effect
    is a changed command and fails closed. It uses the SAME `strict_encode` the
    substrate re-derives with, so verify can prove the payload's normalized
    fields agree with these exact bytes."""
    return json.dumps(strict_encode(command), sort_keys=True, separators=(",", ":"))


def _command_payload(
    substrate: Substrate, view: VerifiedSubstrateView, command: KernelCommand
) -> CommandPayload:
    """Build the NEUTRAL typed intent record for a command: every consequential
    field is normalized out of the opaque `json` so verification can bind each
    effect to exactly what the command named."""
    kind = type(command).__name__
    change_ref: str | None = None
    target_change_id: str | None = None
    expected_state_ref: str | None = None
    issue_state_ref: str | None = None
    prompt_role: str | None = None
    context_ref: str | None = None
    after_seconds: float | None = None
    reason: str | None = None
    if isinstance(command, ApplyChange):
        change_ref = substrate.put(command.change)
        target_change_id = command.change.change_id
        expected_state_ref = command.expected_state_ref
    elif isinstance(command, EvaluateFork):
        change_ref = substrate.put(command.candidate)
        target_change_id = command.candidate.change_id
        issue_state_ref = view.state_ref  # the fork's base anchor, at issue
    elif isinstance(command, RevertChange):
        target_change_id = command.change_id
        expected_state_ref = command.expected_state_ref
    elif isinstance(command, ConfirmChange):
        target_change_id = command.change_id
    elif isinstance(command, RequestRefinement):
        prompt_role = command.prompt_role
        context_ref = command.context_ref
    elif isinstance(command, ScheduleTrigger):
        after_seconds = command.after_seconds
        reason = command.reason
    elif isinstance(command, StopAdaptation):
        reason = command.reason
    return CommandPayload(
        command_id=command.command_id, kind=kind, encoding=_ENCODING,
        change_ref=change_ref, target_change_id=target_change_id,
        expected_state_ref=expected_state_ref, issue_state_ref=issue_state_ref,
        prompt_role=prompt_role, context_ref=context_ref,
        after_seconds=after_seconds, reason=reason,
        json=_command_identity_json(command),
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
