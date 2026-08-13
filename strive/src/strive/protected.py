"""Protected evaluation through a chosen sandbox backend (Stage 3C.2B).

Runs a candidate over a task's cases with EACH protected case
(held-out / regression / adversarial / audit) executed in a FRESH sandbox
of the chosen backend: the candidate receives only `input_text`, and no
candidate state survives between cases. The parent keeps case id, split,
expected output, and the remaining suite. Returns a normal `Evaluation`
(so the existing gate, policies, and envelopes are unchanged) plus the
`SandboxProvenance` naming the exact boundary that executed the code.
"""

from __future__ import annotations

from typing import Sequence

from strive.contracts import (
    Evaluation,
    ExecutionReport,
    TaskCase,
)
from strive.evaluate import evaluate
from strive.sandboxes import (
    SandboxBackend,
    SandboxLimits,
    SandboxProvenance,
    run_protected_suite,
)
from strive.tasks import Task


def evaluate_through_backend(
    task: Task,
    strategy_source: str,
    backend: SandboxBackend,
    *,
    generation_id: str,
    cases: Sequence[TaskCase] | None = None,
    limits: SandboxLimits | None = None,
) -> tuple[Evaluation, SandboxProvenance, tuple[str, ...]]:
    """Evaluate a candidate over `cases` (default: the task's selection
    cases) with each case executed in a fresh sandbox of `backend`. Returns
    (evaluation, sandbox provenance, denial notes). Failure-as-data: a case
    the backend refused or crashed on scores at the floor with its error
    attached, exactly like the in-process runner."""
    suite = tuple(cases) if cases is not None else task.selection_cases()
    outcomes, provenance, denials = run_protected_suite(
        backend, strategy_source, suite, generation_id=generation_id, limits=limits
    )
    report = ExecutionReport(
        ok=True,
        generation_id=generation_id,
        outcomes=tuple(outcomes.values()),
        failure=None,
        wall_time_s=0.0,
        stdout_bytes=0,
    )
    evaluation = evaluate(task, report, suite)
    return evaluation, provenance, denials


__all__ = ["evaluate_through_backend"]
