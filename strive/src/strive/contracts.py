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


# NOTE (Strive vNext): the promotion-era wire types (SurfaceUpdate,
# ProposalRecord, Candidate, Decision, Generation, Activation) were DELETED
# in the Phase-A reset. Harness state is now native composite state in the
# revision-native event substrate (`strive.substrate`); there is no
# generation ledger, no accept/reject promotion decision, and no activation
# record. See docs/adrs/0008-vnext-substrate.md.


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


# NOTE (Strive vNext): the loop-era journal entries (CycleRecord,
# Intervention) were DELETED in the Phase-A reset. The run's history is the
# typed event stream in `strive.substrate`; optional external tracing uses
# the read-only `event@1` stream below.


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
