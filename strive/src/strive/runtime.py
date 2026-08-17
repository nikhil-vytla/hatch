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
    "PolicyStateBlob",
    "StoredResult",
    "combine_usage",
    "strict_encode",
    "strict_json",
]
