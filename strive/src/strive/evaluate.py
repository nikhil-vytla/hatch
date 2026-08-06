"""Evaluation: score a sandbox run against the task's expected outputs."""

from __future__ import annotations

from strive.types import CaseEvaluation, Evaluation, SandboxResult, Task


def evaluate(task: Task, sandbox_result: SandboxResult) -> Evaluation:
    """Score a run as the fraction of cases whose output matches expected.

    A failed sandbox run (timeout/crash) scores 0.0 with every case marked
    failed, so downstream acceptance rules treat it as strictly worse than
    any run that completed.
    """
    if not sandbox_result.ok:
        case_evaluations = tuple(
            CaseEvaluation(
                case_id=case.case_id,
                passed=False,
                expected=case.expected,
                output=None,
                error=sandbox_result.failure,
            )
            for case in task.cases
        )
        return Evaluation(score=0.0, case_evaluations=case_evaluations)

    by_id = {result.case_id: result for result in sandbox_result.case_results}
    case_evaluations = tuple(
        CaseEvaluation(
            case_id=case.case_id,
            passed=(
                case.case_id in by_id
                and by_id[case.case_id].error is None
                and by_id[case.case_id].output == case.expected
            ),
            expected=case.expected,
            output=by_id[case.case_id].output if case.case_id in by_id else None,
            error=by_id[case.case_id].error if case.case_id in by_id else "missing result",
        )
        for case in task.cases
    )
    passed = sum(1 for ce in case_evaluations if ce.passed)
    return Evaluation(
        score=passed / len(case_evaluations) if case_evaluations else 0.0,
        case_evaluations=case_evaluations,
    )
