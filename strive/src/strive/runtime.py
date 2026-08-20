"""Neutral, closed runtime contracts shared by the substrate and the kernel.

These records were formerly private to `strive.kernel`, which meant the
substrate could only decode them if the kernel had already been imported
(verification silently depended on import order). They now live here — a
LEAF module that imports only `codec`, `contracts`, and `sandboxes` — so
`strive.substrate` can decode and TYPE-check every runtime ref it references
(command payloads, stored results, policy-state/config envelopes, attempt
dispatches/records, fork observations) with no dependency on the kernel.

Every record is a registered `codec` contract, so a fresh interpreter that
imports only `strive.substrate` can still verify a stream end to end.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterable
from dataclasses import dataclass

from strive.codec import register
from strive.contracts import BudgetUsage, FailureRecord
from strive.sandboxes import SandboxProvenance

# the canonical encoding tag for the JSON-in-blob envelopes below
ENCODING = "strict-json@1"


def strict_encode(value: object) -> object:
    """The ONE canonical, schema-tagless projection of a value into JSON-safe
    primitives — shared by the kernel (which builds command-payload JSON) and
    the substrate (which re-derives it to prove a payload's normalized fields
    agree with its canonical JSON). Because both sides call THIS function, the
    proof cannot drift: verification reconstructs bytes the kernel actually
    wrote. Refuses to coerce anything it does not understand."""
    if isinstance(value, bool) or value is None or isinstance(value, (int, float, str)):
        return value
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            f.name: strict_encode(getattr(value, f.name))
            for f in dataclasses.fields(value)
        }
    if isinstance(value, (list, tuple)):
        return [strict_encode(item) for item in value]
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, val in value.items():
            if not isinstance(key, str):
                raise ValueError(f"cannot canonically encode a non-string dict key {key!r}")
            out[key] = strict_encode(val)
        return out
    raise ValueError(
        f"cannot canonically encode a value of type {type(value).__name__} "
        "(strict encoding refuses to coerce)"
    )


def strict_json(value: object) -> str:
    """The canonical serialization (sorted keys, tight separators) of
    `strict_encode(value)` — the exact bytes stored as command-payload JSON."""
    return json.dumps(strict_encode(value), sort_keys=True, separators=(",", ":"))


def model_result_usage(result: "ModelResult") -> BudgetUsage:
    """The honest budget a COMPLETED model call charged: one model call, its
    exact tokens/cost, and its latency as active wall. Shared by the kernel
    (which records a refinement terminal's usage) and the substrate (which
    re-derives and cross-checks it), so they cannot drift."""
    return BudgetUsage(
        model_calls=1,
        tokens=result.input_tokens + result.output_tokens,
        cost=result.cost,
        wall_time_s=result.latency_ms / 1000.0,
    )


def model_dispatch_reservation(dispatch: "ModelDispatch") -> BudgetUsage:
    """The worst case an OPEN model dispatch (crashed before a result) charges:
    one model call, its estimated input+output tokens, its wall cap, and its
    estimated cost — so a crash-loop can never expand any budget dimension."""
    return BudgetUsage(
        model_calls=1,
        tokens=dispatch.reserved_tokens,
        wall_time_s=dispatch.reserved_wall_s,
        cost=dispatch.reserved_cost,
    )


def combine_usage(usages: Iterable[BudgetUsage]) -> BudgetUsage:
    """Sum per-attempt usage into one reconciled total — the SAME accounting the
    `BudgetMeter` performs when it seeds from the durable ledger (additive on
    every countable dimension, cumulative wall, and MAX recursion depth). Both
    the kernel (which writes a crashed command's reconciled failure usage from
    its durable attempt ledger, never zero) and the substrate (which re-derives
    and cross-checks that same total) call THIS function, so they cannot drift."""
    total = BudgetUsage()
    for u in usages:
        total = BudgetUsage(
            wall_time_s=total.wall_time_s + u.wall_time_s,
            executions=total.executions + u.executions,
            model_calls=total.model_calls + u.model_calls,
            tokens=total.tokens + u.tokens,
            output_bytes=total.output_bytes + u.output_bytes,
            cost=total.cost + u.cost,
            recursion_depth=max(total.recursion_depth, u.recursion_depth),
        )
    return dataclasses.replace(total, wall_time_s=round(total.wall_time_s, 6))


@register("command-payload", 3)
@dataclass(frozen=True)
class CommandPayload:
    """The canonical, content-addressable command intent — a NEUTRAL, typed
    record of every consequential field, not an opaque JSON blob the substrate
    cannot read. Its CAS ref is the command digest binding a `command_id` to
    ONE payload; `json` remains the full canonical command (the identity a
    changed precondition perturbs). The normalized fields let verification bind
    each effect to exactly what the issued command named:

    - `change_ref` — the CAS ref of the CompositeChange an Apply/Evaluate targets
    - `target_change_id` — the change id an Apply/Evaluate/Confirm/Revert names
    - `expected_state_ref` — the Apply/Revert precondition (an effect must
      satisfy THIS, not merely the folded state)
    - `issue_state_ref` — the folded state ref at issue (the fork's base anchor)
    - `prompt_role` / `context_ref` — a RequestRefinement's model inputs
    - `after_seconds` — a ScheduleTrigger's delay
    - `reason` — a Schedule/Stop reason
    """

    command_id: str
    kind: str
    encoding: str
    change_ref: str | None
    target_change_id: str | None
    expected_state_ref: str | None
    issue_state_ref: str | None
    prompt_role: str | None
    context_ref: str | None
    after_seconds: float | None
    reason: str | None
    json: str


@register("stored-result", 1)
@dataclass(frozen=True)
class StoredResult:
    """The durable record of a command's terminal result — reconstructed
    verbatim (including `head`) on resume."""

    command_id: str
    kind: str
    outcome: str
    head: str
    detail: str
    proposal_ref: str | None
    observation_ref: str | None
    metrics: dict[str, float]
    usage: BudgetUsage


@register("policy-state-blob", 1)
@dataclass(frozen=True)
class PolicyStateBlob:
    encoding: str
    json: str


@register("config-blob", 1)
@dataclass(frozen=True)
class ConfigBlob:
    encoding: str
    json: str


@register("attempt-dispatched", 2)
@dataclass(frozen=True)
class AttemptDispatched:
    """Journaled BEFORE a base/candidate attempt runs. If a result never
    follows (a crash between dispatch and result), the attempt is an OPEN
    dispatch — reconciled as `indeterminate`, never implicitly re-run. The
    reservation is CONSERVATIVE across every countable dimension (executions,
    wall, output), so a crash-loop can never expand any budget dimension."""

    command_id: str
    label: str  # "base" | "candidate"
    state_ref: str
    reserved_executions: int
    reserved_wall_s: float
    reserved_output_bytes: int


@register("execution-attempt", 2)
@dataclass(frozen=True)
class AttemptRecord:
    """The durable RESULT of one base/candidate attempt. It preserves the FULL
    execution evidence — CAS refs to the exact `ExecutionReport` (`report_ref`:
    per-case outputs/errors, backend failure, wall/output bytes) and the exact
    `Evaluation` (`evaluation_ref`: per-case scores/feedback) — plus the actual
    returned provenance, denials, the metered usage, and the state ref it
    scored. `ok` distinguishes a COMPLETED evaluation (candidate errors are
    scored, `failure is None`, `ok=True`) from a SANDBOX/INFRA failure
    (`failure` set, `ok=False`) — neither is collapsed to an aggregate score."""

    command_id: str
    label: str  # "base" | "candidate"
    state_ref: str
    overall: float
    ok: bool
    provenance: SandboxProvenance
    failure: FailureRecord | None
    denials: tuple[str, ...]
    usage: BudgetUsage
    report_ref: str       # CAS ref to the exact ExecutionReport
    evaluation_ref: str   # CAS ref to the exact Evaluation


@register("fork-observation", 4)
@dataclass(frozen=True)
class ForkObservation:
    """The SUMMARY of a completed `EvaluateFork`: the base and candidate
    attempt records and whether the candidate improved."""

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


# observation_kind tags carried by ObservationRecorded for fork events
FORK_DISPATCH = "fork-attempt-dispatch"
FORK_RESULT = "fork-attempt-result"
FORK_SUMMARY = "fork-evaluation"

# observation_kind tags carried by ObservationRecorded for a RequestRefinement:
# a model call is journaled as a BINDING (pinning the resolved model, first) →
# a DISPATCH (before the call, durable) → a RESULT (after), exactly like a fork
# attempt — so a crash between them is an OPEN dispatch, reconciled as
# `indeterminate` and never silently re-called, and the model can never be
# switched after the binding.
REFINE_BINDING = "refine-model-binding"
REFINE_DISPATCH = "refine-model-dispatch"
REFINE_RESULT = "refine-model-result"

# observation_kind tags for an ObserveCurrentState command: operating the ACTIVE
# harness through the injected OperationDriver is journaled as a DISPATCH (before
# execution, durable, with a reservation) then a RESULT (an AttemptRecord, label
# "current"), exactly like a fork attempt — so a crash between them is an OPEN
# dispatch, reconciled as `indeterminate`, never silently re-run. This is
# FEEDBACK the refiner reacts to — never an acceptance gate.
OPERATION_DISPATCH = "operation-dispatch"
OPERATION_RESULT = "operation-result"
OPERATION_LABEL = "current"

# the closed vocabulary of surfaces an edit may name and review verdicts
REVIEW_VERDICTS = ("keep", "revise", "revert", "defer")


@register("surface-edit", 1)
@dataclass(frozen=True)
class SurfaceEdit:
    """One exact, full-replacement edit a refinement proposes: the pinned
    surface it names and the CAS ref of its new content (a pure content
    address; the content itself travels in the command's `content_blobs`)."""

    surface_kind: str
    surface_name: str
    after_ref: str


@register("refinement-proposal", 1)
@dataclass(frozen=True)
class RefinementProposal:
    """The STRICTLY-decoded typed output of a model refinement. Malformed model
    output never becomes one of these — it is failure-as-data. `edits` is the
    exact coupled change (one or both surfaces); `review_hint` carries a review
    verdict when this proposal was produced under the review role."""

    change_id: str
    edits: tuple[SurfaceEdit, ...]
    rationale: str
    cited_evidence: tuple[str, ...]
    expected_outcomes: tuple[str, ...]
    uncertainty: float
    review_hint: str  # one of REVIEW_VERDICTS


@register("operation-dispatched", 1)
@dataclass(frozen=True)
class OperationDispatched:
    """Journaled BEFORE the active harness is operated (durable). Names the
    driver, the issue-state it operates against, and a CONSERVATIVE reservation
    across every countable dimension, so an OPEN dispatch (crash before the
    result) reserves the worst case and a crash-loop can never expand any budget
    dimension — exactly like a fork attempt's reservation."""

    command_id: str
    driver_name: str
    state_ref: str
    reserved_executions: int
    reserved_wall_s: float
    reserved_output_bytes: int


@register("model-binding", 1)
@dataclass(frozen=True)
class ModelBinding:
    """Journaled as the FIRST effect of a refinement (before the dispatch): the
    resolved adapter, model, and config digest this command is committed to.
    On resume the kernel re-resolves and refuses to proceed if the injected
    model no longer matches — a run cannot silently switch models after issue.
    Verification binds the dispatch/result adapter+model to this record."""

    command_id: str
    adapter_name: str
    model_id: str
    config_digest: str


@register("model-dispatch", 1)
@dataclass(frozen=True)
class ModelDispatch:
    """Journaled BEFORE a model call runs (durable). Pins the resolved model,
    sampling, the rendered prompt (CAS ref), and a stable idempotency key so a
    provider that supports it can dedupe a retried call; without provider
    support an unresolved dispatch becomes `indeterminate`. The reservation
    (one model call, the requested token cap, the wall cap) is the worst case
    an OPEN dispatch charges, so a crash-loop can never expand any budget
    dimension — exactly like a fork attempt's reservation."""

    command_id: str
    prompt_role: str
    prompt_ref: str
    adapter_name: str
    model_id: str
    max_tokens: int
    temperature: float
    seed: int
    idempotency_key: str
    reserved_tokens: int  # estimated input + capped output tokens
    reserved_wall_s: float
    reserved_cost: float


@register("model-result", 1)
@dataclass(frozen=True)
class ModelResult:
    """Journaled AFTER a model call returns (durable). Records the resolved
    model, usage/latency, normalized finish reason, provider extras, the raw
    completion (CAS ref), any failure (adapter error / budget / malformed
    decode) as data, and — on success — the CAS ref of the decoded
    `RefinementProposal`."""

    command_id: str
    prompt_role: str
    adapter_name: str
    model_id: str
    response_ref: str | None
    input_tokens: int
    output_tokens: int
    cost: float
    latency_ms: float
    finish_reason: str
    provider_extras: dict[str, str]
    failure: FailureRecord | None
    proposal_ref: str | None


__all__ = [
    "AttemptDispatched",
    "AttemptRecord",
    "CommandPayload",
    "ConfigBlob",
    "ENCODING",
    "FORK_DISPATCH",
    "FORK_RESULT",
    "FORK_SUMMARY",
    "ForkObservation",
    "ModelBinding",
    "ModelDispatch",
    "ModelResult",
    "OPERATION_DISPATCH",
    "OPERATION_LABEL",
    "OPERATION_RESULT",
    "OperationDispatched",
    "PolicyStateBlob",
    "REFINE_BINDING",
    "REFINE_DISPATCH",
    "REFINE_RESULT",
    "REVIEW_VERDICTS",
    "RefinementProposal",
    "StoredResult",
    "SurfaceEdit",
    "combine_usage",
    "model_dispatch_reservation",
    "model_result_usage",
    "strict_encode",
    "strict_json",
]
