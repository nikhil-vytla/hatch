"""Stage units: evaluation aggregation, diagnosis signatures, bounded proposal."""

from strive.contracts import (
    CaseOutcome,
    Evaluation,
    ExecutionReport,
    FailureRecord,
    Diagnosis,
    HELD_OUT,
    VISIBLE,
)
from strive.diagnose import (
    NEGATIVE_INTEGERS_DROPPED,
    SignatureDiagnoser,
    VisibleContext,
)
from strive.evaluate import evaluate
from strive.propose import RegistryProposer
from strive.tasks import BASELINE_STRATEGY_SOURCE, SUM_INTEGERS_TASK


def _report(outputs: dict[str, int | None], error: str | None = None) -> ExecutionReport:
    outcomes = tuple(
        CaseOutcome(
            case_id=case.case_id,
            output=outputs.get(case.case_id, case.expected),
            error=error if case.case_id in outputs and outputs[case.case_id] is None else None,
            duration_ms=0.1,
        )
        for case in SUM_INTEGERS_TASK.cases
    )
    return ExecutionReport(ok=True, generation_id="g", outcomes=outcomes)


def _visible_ctx(evaluation: Evaluation, source: str = BASELINE_STRATEGY_SOURCE) -> VisibleContext:
    return VisibleContext(
        task_id=SUM_INTEGERS_TASK.task_id,
        cases=SUM_INTEGERS_TASK.visible_cases(),
        evaluation=evaluation.visible_view(),
        parent_generation_id="gen-0000",
        parent_source=source,
    )


# -- evaluate ---------------------------------------------------------------


def test_evaluate_scores_per_split_with_feedback() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"negative-all": 6}))
    assert evaluation.split_scores[VISIBLE] == 5 / 6
    assert evaluation.split_scores[HELD_OUT] == 1.0
    failing = [ce for ce in evaluation.case_evaluations if not ce.passed]
    assert len(failing) == 1
    assert "overestimate" in failing[0].feedback
    assert "negative-all" in evaluation.feedback


def test_evaluate_failed_execution_is_floor_with_failure_attached() -> None:
    failure = FailureRecord("timeout", "killed after 1.0s")
    report = ExecutionReport(ok=False, generation_id="g", failure=failure)
    evaluation = evaluate(SUM_INTEGERS_TASK, report)
    assert evaluation.overall_score == 0.0
    assert evaluation.failure == failure
    assert all(not ce.passed for ce in evaluation.case_evaluations)
    assert "timeout" in evaluation.feedback


def test_visible_view_strips_other_splits() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({}))
    view = evaluation.visible_view()
    assert {ce.split for ce in view.case_evaluations} == {VISIBLE}
    assert set(view.split_scores) == {VISIBLE}


# -- diagnose ---------------------------------------------------------------


def test_diagnose_fires_on_negative_sign_signature() -> None:
    evaluation = evaluate(
        SUM_INTEGERS_TASK, _report({"negative-single": 17, "negative-all": 6})
    )
    diagnosis = SignatureDiagnoser().diagnose(_visible_ctx(evaluation))
    assert diagnosis is not None
    assert diagnosis.weakness_id == NEGATIVE_INTEGERS_DROPPED
    assert set(diagnosis.evidence_case_ids) == {"negative-single", "negative-all"}


def test_diagnose_abstains_on_exceptions() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"negative-all": None}, "boom"))
    assert SignatureDiagnoser().diagnose(_visible_ctx(evaluation)) is None


def test_diagnose_abstains_on_unrelated_failures() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"positives-pair": 99}))
    assert SignatureDiagnoser().diagnose(_visible_ctx(evaluation)) is None


def test_diagnose_abstains_when_everything_passes() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({}))
    assert SignatureDiagnoser().diagnose(_visible_ctx(evaluation)) is None


# -- propose ----------------------------------------------------------------


def _diagnosis() -> Diagnosis:
    return Diagnosis(NEGATIVE_INTEGERS_DROPPED, "d", ("negative-all",))


def test_propose_patches_baseline_source() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"negative-all": 6}))
    proposal = RegistryProposer().propose(_visible_ctx(evaluation), _diagnosis())
    assert proposal is not None
    assert 'r"-?\\d+"' in proposal.source


def test_propose_abstains_on_unknown_weakness() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"negative-all": 6}))
    diagnosis = Diagnosis("mystery-weakness", "d", ("negative-all",))
    assert RegistryProposer().propose(_visible_ctx(evaluation), diagnosis) is None


def test_propose_abstains_when_patch_target_missing() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, _report({"negative-all": 6}))
    ctx = _visible_ctx(evaluation, source="def solve(t): return 0\n")
    assert RegistryProposer().propose(ctx, _diagnosis()) is None
