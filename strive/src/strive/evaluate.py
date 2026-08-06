"""Evaluation: score an execution report using the task's own scoring.

The evaluator owns aggregation (per-split and overall scores, feedback
assembly); the task owns per-case correctness. A failed execution (timeout,
crash, budget exhaustion, …) is failure-as-data: it evaluates to floor scores
with the failure attached, so downstream policies treat it as strictly worse
than any run that completed — the controller never raises for it.
"""

from __future__ import annotations

from strive.contracts import (
    CaseEvaluation,
    Evaluation,
    ExecutionReport,
    FailureRecord,
)
from strive.tasks import Task


def _aggregate(
    case_evaluations: tuple[CaseEvaluation, ...],
) -> tuple[float, dict[str, float]]:
    overall = (
        sum(ce.score for ce in case_evaluations) / len(case_evaluations)
        if case_evaluations
        else 0.0
    )
    split_scores: dict[str, float] = {}
    splits = {ce.split for ce in case_evaluations}
    for split in sorted(splits):
        members = [ce for ce in case_evaluations if ce.split == split]
        split_scores[split] = sum(ce.score for ce in members) / len(members)
    return overall, split_scores


def _floor_evaluation(task: Task, failure: FailureRecord) -> Evaluation:
    case_evaluations = tuple(
        CaseEvaluation(
            case_id=case.case_id,
            split=case.split,
            passed=False,
            score=0.0,
            expected=case.expected,
            output=None,
            error=f"{failure.kind}: {failure.detail}",
            feedback=f"execution failed before this case ran ({failure.kind})",
        )
        for case in task.cases
    )
    overall, split_scores = _aggregate(case_evaluations)
    return Evaluation(
        overall_score=overall,
        split_scores=split_scores,
        feedback=f"execution failure: {failure.kind} — {failure.detail}",
        case_evaluations=case_evaluations,
        failure=failure,
    )


def evaluate(task: Task, report: ExecutionReport) -> Evaluation:
    if not report.ok:
        assert report.failure is not None
        return _floor_evaluation(task, report.failure)

    by_id = {outcome.case_id: outcome for outcome in report.outcomes}
    case_evaluations: list[CaseEvaluation] = []
    for case in task.cases:
        outcome = by_id.get(case.case_id)
        if outcome is None:
            case_evaluations.append(
                CaseEvaluation(
                    case_id=case.case_id,
                    split=case.split,
                    passed=False,
                    score=0.0,
                    expected=case.expected,
                    output=None,
                    error="missing result",
                    feedback="runner returned no outcome for this case",
                )
            )
            continue
        score, passed, feedback = task.score_case(case, outcome.output, outcome.error)
        case_evaluations.append(
            CaseEvaluation(
                case_id=case.case_id,
                split=case.split,
                passed=passed,
                score=score,
                expected=case.expected,
                output=outcome.output,
                error=outcome.error,
                feedback=feedback,
            )
        )

    evaluations = tuple(case_evaluations)
    overall, split_scores = _aggregate(evaluations)
    failing = [ce for ce in evaluations if not ce.passed]
    feedback = (
        "all cases passed"
        if not failing
        else "; ".join(f"{ce.case_id}: {ce.feedback}" for ce in failing[:5])
    )
    return Evaluation(
        overall_score=overall,
        split_scores=split_scores,
        feedback=feedback,
        case_evaluations=evaluations,
        failure=None,
    )
