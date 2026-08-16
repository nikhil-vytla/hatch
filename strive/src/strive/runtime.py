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

from dataclasses import dataclass

from strive.codec import register
from strive.contracts import BudgetUsage, FailureRecord
from strive.sandboxes import SandboxProvenance

# the canonical encoding tag for the JSON-in-blob envelopes below
ENCODING = "strict-json@1"


@register("command-payload", 2)
@dataclass(frozen=True)
class CommandPayload:
    """The canonical, content-addressable command intent. Its CAS ref is the
    command digest binding a `command_id` to ONE payload. `json` is the FULL
    canonical command (INCLUDING its `expected_state_ref` precondition — a
    changed precondition is a changed command). `change_ref` is the CAS ref of
    the `CompositeChange` a change-bearing command (Apply/Evaluate) targets, so
    an effect can be matched to its command's actual change, not a kind string."""

    command_id: str
    kind: str
    encoding: str
    change_ref: str | None
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


@register("execution-attempt", 1)
@dataclass(frozen=True)
class AttemptRecord:
    """The durable RESULT of one base/candidate attempt, with the ACTUAL
    returned provenance, any failure, denials, the metered usage THIS attempt
    charged, and the state ref it scored — recorded even for a partial/failed
    attempt so charges and provenance survive to the next crash point."""

    command_id: str
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
]
