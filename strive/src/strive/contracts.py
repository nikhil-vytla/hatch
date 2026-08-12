"""Versioned typed contracts shared by the in-memory loop and persisted records.

Every dataclass here is registered with the shared codec under an explicit
``kind@version``. Changing a contract's shape requires bumping its version and
teaching the codec/tests about the migration — decoding an unsupported version
fails loudly by design.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from strive.codec import register

# -- splits -------------------------------------------------------------------

VISIBLE = "visible"
HELD_OUT = "held_out"
REGRESSION = "regression"
ADVERSARIAL = "adversarial"
AUDIT = "audit"
SPLITS = (VISIBLE, HELD_OUT, REGRESSION, ADVERSARIAL, AUDIT)

# Split roles (evaluation discipline):
# - visible: proposer/diagnosis evidence (train)
# - held_out / regression / adversarial: development/selection data — used by
#   acceptance policies on every routine promotion decision
# - audit: final holdout — excluded from routine cycles and selection; queried
#   only on demand (`strive audit`), so selection cannot overfit it

# -- failure kinds --------------------------------------------------------------

FAILURE_TIMEOUT = "timeout"
FAILURE_CRASH = "crash"
FAILURE_MALFORMED_OUTPUT = "malformed-output"
FAILURE_OUTPUT_LIMIT = "output-limit"
FAILURE_BUDGET_EXHAUSTED = "budget-exhausted"
FAILURE_SCHEMA_MISMATCH = "schema-mismatch"
FAILURE_MODEL_ERROR = "model-error"
FAILURE_COST_UNAVAILABLE = "cost-limit-unavailable"

# proposal-pipeline rejection kinds, each journaled distinctly
FAILURE_PROPOSAL_TRUNCATED = "proposal-truncated"
FAILURE_PROPOSAL_MALFORMED = "proposal-malformed"
FAILURE_PROPOSAL_SCHEMA_INVALID = "proposal-schema-invalid"
FAILURE_PROPOSAL_FORBIDDEN = "proposal-forbidden"
FAILURE_PROPOSAL_STALE = "proposal-stale"
FAILURE_PROPOSAL_ABSTAINED = "proposal-abstained"


@register("failure", 1)
@dataclass(frozen=True)
class FailureRecord:
    """A contained failure, recorded as data rather than raised at the controller."""

    kind: str
    detail: str


# -- tasks ----------------------------------------------------------------------


@register("task-case", 1)
@dataclass(frozen=True)
class TaskCase:
    case_id: str
    input_text: str
    expected: int
    split: str


# -- execution -------------------------------------------------------------------


@register("case-outcome", 1)
@dataclass(frozen=True)
class CaseOutcome:
    """Raw result of one case inside the sandbox."""

    case_id: str
    output: int | None
    error: str | None
    duration_ms: float


@register("execution-report", 1)
@dataclass(frozen=True)
class ExecutionReport:
    """Outcome of one sandboxed run over a case suite.

    ``failure`` is set (and ``outcomes`` empty) when the child process itself
    failed: timeout, crash, output limit, schema mismatch, budget exhaustion.
    """

    ok: bool
    generation_id: str
    outcomes: tuple[CaseOutcome, ...] = ()
    failure: FailureRecord | None = None
    wall_time_s: float = 0.0
    stdout_bytes: int = 0


# -- evaluation ------------------------------------------------------------------


@register("case-evaluation", 1)
@dataclass(frozen=True)
class CaseEvaluation:
    case_id: str
    split: str
    passed: bool
    score: float
    expected: int
    output: int | None
    error: str | None
    feedback: str


@register("evaluation", 1)
@dataclass(frozen=True)
class Evaluation:
    """Scored view of an execution: numeric per-split scores + textual feedback."""

    overall_score: float
    split_scores: dict[str, float]
    feedback: str
    case_evaluations: tuple[CaseEvaluation, ...]
    failure: FailureRecord | None = None

    def cases_in(self, split: str) -> tuple[CaseEvaluation, ...]:
        return tuple(ce for ce in self.case_evaluations if ce.split == split)

    def passing_case_ids(self) -> tuple[str, ...]:
        return tuple(ce.case_id for ce in self.case_evaluations if ce.passed)

    def failing_case_ids(self) -> tuple[str, ...]:
        return tuple(ce.case_id for ce in self.case_evaluations if not ce.passed)

    def visible_view(self) -> "Evaluation":
        """The evaluation restricted to the visible split.

        This is the only evaluation object the kernel hands to diagnosis and
        proposal components; held-out, regression, and adversarial evidence
        never reaches them (holdout isolation).
        """
        visible = self.cases_in(VISIBLE)
        passed = sum(1 for ce in visible if ce.passed)
        return Evaluation(
            overall_score=passed / len(visible) if visible else 0.0,
            split_scores={VISIBLE: passed / len(visible) if visible else 0.0},
            feedback=self.feedback if self.failure is not None else "visible split only",
            case_evaluations=visible,
            failure=self.failure,
        )


# -- diagnosis / proposal ----------------------------------------------------------


@register("diagnosis", 1)
@dataclass(frozen=True)
class Diagnosis:
    weakness_id: str
    description: str
    evidence_case_ids: tuple[str, ...]


@register("surface-update", 1)
@dataclass(frozen=True)
class SurfaceUpdate:
    """One proposed change to a non-code evolvable surface, keyed by its
    pinned descriptor ref — generic by design so future surfaces need no new
    ProposalRecord fields. The model-facing JSON keeps convenience keys (e.g.
    "prompt_update"); the kernel converts them into this typed form."""

    descriptor_ref: str  # e.g. "prompt@3" — pinned at proposal time
    name: str  # e.g. "proposal-template"
    content: str  # the complete replacement artifact text


@register("proposal", 2)
@dataclass(frozen=True)
class ProposalRecord:
    """A structured proposed change, as validated from a proposer's output.

    ``parent_generation_id`` names the incumbent the proposal was derived
    from; the kernel rejects the proposal as stale if the active generation
    has changed by the time it is applied.
    """

    parent_generation_id: str
    surface: str
    summary: str
    rationale: str
    trace_evidence: tuple[str, ...]
    expected_outcome: str
    source: str
    changed_surfaces: tuple[str, ...]
    risks: tuple[str, ...]
    assumptions: tuple[str, ...]
    # generic typed updates to non-code surfaces, keyed by descriptor ref
    # (empty = strategy-only proposal). Note on proposal@1: those records
    # exist only inside run-event payloads and are never codec-decoded from
    # disk (verified by test); decoding one raises the strict
    # unsupported-version error, so no v1 migration path is required.
    surface_updates: tuple[SurfaceUpdate, ...] = ()


@register("candidate", 1)
@dataclass(frozen=True)
class Candidate:
    """A bounded proposed change to an evolvable surface.

    ``source_ref`` is a content-address (sha256) into the object store; the
    candidate's full source never lives inside ledger entries.
    """

    candidate_id: str
    parent_generation_id: str
    surface: str
    weakness_id: str
    description: str
    source_ref: str


# -- decision / promotion ----------------------------------------------------------


@register("decision", 1)
@dataclass(frozen=True)
class Decision:
    """An accept/reject verdict, stamped with the policy that produced it."""

    accepted: bool
    reason: str
    policy: str
    policy_version: int
    baseline_score: float
    candidate_score: float
    baseline_split_scores: dict[str, float]
    candidate_split_scores: dict[str, float]
    regressed_case_ids: tuple[str, ...] = ()


@register("generation", 2)
@dataclass(frozen=True)
class Generation:
    generation_id: str
    task_id: str
    task_fingerprint: str
    parent_id: str | None
    origin: str  # "seed" | "evolved" | "manual"
    surface: str
    weakness_id: str | None
    created_at: str
    source_ref: str
    decision: Decision | None = None


ACTIVATION_DURABLE = "durable"
ACTIVATION_PROVISIONAL = "provisional"


@register("activation", 2)
@dataclass(frozen=True)
class Activation:
    generation_id: str
    task_id: str
    reason: str  # "seed" | "evolved" | "rollback" | "promote" | "confirmed" | "expired-reverted"
    mode: str  # "durable" | "provisional"
    at: str
    policy: str
    expires_after_cycles: int | None = None
    baseline_score: float | None = None


# -- budgets --------------------------------------------------------------------


@register("budget-spec", 1)
@dataclass(frozen=True)
class BudgetSpec:
    """Trusted resource ceilings for one cycle. Enforced kernel-side only.

    Uniform limit semantics (see strive.budget): -1 = unlimited (accounting
    only), 0 = nothing allowed, otherwise deny once accumulated usage reaches
    the limit.
    """

    wall_time_s: float = 120.0
    executions: int = 16
    model_calls: int = 0
    tokens: int = -1
    output_bytes: int = 1_000_000
    cost: float = -1.0
    max_recursion_depth: int = 0


@register("budget-usage", 1)
@dataclass(frozen=True)
class BudgetUsage:
    wall_time_s: float = 0.0
    executions: int = 0
    model_calls: int = 0
    tokens: int = 0
    output_bytes: int = 0
    cost: float = 0.0
    recursion_depth: int = 0


# -- journal entries ---------------------------------------------------------------


@register("cycle", 1)
@dataclass(frozen=True)
class CycleRecord:
    """Ledger summary of one loop cycle, including usage attribution."""

    run_id: str
    at: str
    task_id: str
    task_fingerprint: str
    generation_id: str
    overall_score: float
    split_scores: dict[str, float]
    weakness_id: str | None
    candidate_generation_id: str | None
    accepted: bool | None
    frozen: bool
    usage: BudgetUsage


INTERVENTION_STALL_FREEZE = "stall-freeze"
INTERVENTION_RESUME = "resume"
INTERVENTION_EXPIRY_REVERT = "expiry-revert"
INTERVENTION_LEGACY_MIGRATION = "legacy-migration"
INTERVENTION_SHADOW_DIVERGENCE = "shadow-divergence"
INTERVENTION_DRIFT_ACKNOWLEDGED = "task-drift-acknowledged"


@register("intervention", 1)
@dataclass(frozen=True)
class Intervention:
    """A trusted-monitor action: freeze, resume, or provisional expiry revert."""

    kind: str
    reason: str
    at: str
    run_id: str | None = None


@register("event", 1)
@dataclass(frozen=True)
class Event:
    """Structured execution event; payloads embed encoded contracts where useful."""

    ts: str
    type: str
    run_id: str
    payload: dict[str, object] = field(default_factory=dict)


# -- model interface ---------------------------------------------------------------


@register("model-request", 2)
@dataclass(frozen=True)
class ModelRequest:
    prompt: str
    max_tokens: int = 1024
    temperature: float = 0.0
    seed: int = 0
    timeout_s: float = 60.0


FINISH_STOP = "stop"
FINISH_LENGTH = "length"
FINISH_ERROR = "error"
FINISH_UNKNOWN = "unknown"


@register("model-response", 2)
@dataclass(frozen=True)
class ModelResponse:
    text: str
    model_id: str
    input_tokens: int
    output_tokens: int
    cost: float = 0.0
    finish_reason: str = FINISH_UNKNOWN  # normalized: stop|length|error|unknown
