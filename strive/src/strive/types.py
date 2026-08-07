"""Core typed value objects shared across loop stages.

These are deliberately plain frozen dataclasses with JSON-friendly fields so
that every stage's inputs and outputs can be persisted verbatim into the
ledger and event streams.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TaskCase:
    """One deterministic input/expected pair."""

    case_id: str
    input_text: str
    expected: int


@dataclass(frozen=True)
class Task:
    """A deterministic task: a named suite of cases."""

    task_id: str
    description: str
    cases: tuple[TaskCase, ...]

    def case(self, case_id: str) -> TaskCase:
        for case in self.cases:
            if case.case_id == case_id:
                return case
        raise KeyError(case_id)


@dataclass(frozen=True)
class CaseResult:
    """Raw outcome of running one case inside the sandbox."""

    case_id: str
    output: int | None
    error: str | None
    duration_ms: float


@dataclass(frozen=True)
class SandboxResult:
    """Outcome of one sandboxed strategy run over a case suite.

    ``failure`` is set (and ``case_results`` empty) when the child process
    itself failed: timeout, crash on startup, or malformed output.
    """

    ok: bool
    case_results: tuple[CaseResult, ...] = ()
    failure: str | None = None


@dataclass(frozen=True)
class CaseEvaluation:
    case_id: str
    passed: bool
    expected: int
    output: int | None
    error: str | None


@dataclass(frozen=True)
class Evaluation:
    """Scored view of a sandbox run: fraction of cases passed."""

    score: float
    case_evaluations: tuple[CaseEvaluation, ...]

    @property
    def failing_case_ids(self) -> tuple[str, ...]:
        return tuple(ce.case_id for ce in self.case_evaluations if not ce.passed)

    @property
    def passing_case_ids(self) -> tuple[str, ...]:
        return tuple(ce.case_id for ce in self.case_evaluations if ce.passed)


@dataclass(frozen=True)
class Diagnosis:
    """A known weakness inferred purely from trace evidence."""

    weakness_id: str
    description: str
    evidence_case_ids: tuple[str, ...]


@dataclass(frozen=True)
class Candidate:
    """A bounded proposed change to an evolvable surface.

    In this milestone the only evolvable surface kind is ``strategy-code``:
    ``source`` holds the complete replacement strategy source file.
    """

    candidate_id: str
    parent_generation_id: str
    surface: str
    weakness_id: str
    description: str
    source: str


@dataclass(frozen=True)
class Decision:
    """Explicit accept/reject verdict comparing candidate vs. baseline."""

    accepted: bool
    reason: str
    baseline_score: float
    candidate_score: float
    regressed_case_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class GenerationRecord:
    """One retained generation of an evolvable surface."""

    generation_id: str
    parent_id: str | None
    origin: str  # "seed" | "evolved"
    surface: str
    weakness_id: str | None
    created_at: str
    strategy_file: str
    decision: dict[str, object] = field(default_factory=dict)
