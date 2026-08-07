"""Unit tests for individual loop stages: evaluate, diagnose, propose, decide."""

from strive.decide import decide
from strive.diagnose import NEGATIVE_INTEGERS_DROPPED, diagnose
from strive.evaluate import evaluate
from strive.propose import propose
from strive.tasks import BASELINE_STRATEGY_SOURCE, SUM_INTEGERS_TASK
from strive.types import (
    CaseEvaluation,
    CaseResult,
    Diagnosis,
    Evaluation,
    SandboxResult,
)


def _eval(*pairs: tuple[str, bool]) -> Evaluation:
    cases = tuple(
        CaseEvaluation(case_id=case_id, passed=passed, expected=0, output=0, error=None)
        for case_id, passed in pairs
    )
    score = sum(1 for c in cases if c.passed) / len(cases)
    return Evaluation(score=score, case_evaluations=cases)


# -- evaluate ---------------------------------------------------------------


def test_evaluate_scores_fraction_passed() -> None:
    results = tuple(
        CaseResult(case.case_id, case.expected, None, 0.1)
        for case in SUM_INTEGERS_TASK.cases[:3]
    ) + tuple(
        CaseResult(case.case_id, case.expected + 1, None, 0.1)
        for case in SUM_INTEGERS_TASK.cases[3:]
    )
    evaluation = evaluate(SUM_INTEGERS_TASK, SandboxResult(ok=True, case_results=results))
    assert evaluation.score == 3 / len(SUM_INTEGERS_TASK.cases)


def test_evaluate_failed_sandbox_scores_zero() -> None:
    evaluation = evaluate(SUM_INTEGERS_TASK, SandboxResult(ok=False, failure="timeout"))
    assert evaluation.score == 0.0
    assert len(evaluation.failing_case_ids) == len(SUM_INTEGERS_TASK.cases)


# -- diagnose ---------------------------------------------------------------


def _trace_eval(failures: dict[str, tuple[int | None, str | None]]) -> Evaluation:
    """Build an Evaluation over the real task with given failing outputs."""
    cases = tuple(
        CaseEvaluation(
            case_id=case.case_id,
            passed=case.case_id not in failures,
            expected=case.expected,
            output=failures[case.case_id][0] if case.case_id in failures else case.expected,
            error=failures[case.case_id][1] if case.case_id in failures else None,
        )
        for case in SUM_INTEGERS_TASK.cases
    )
    score = sum(1 for c in cases if c.passed) / len(cases)
    return Evaluation(score=score, case_evaluations=cases)


def test_diagnose_fires_on_negative_sign_signature() -> None:
    evaluation = _trace_eval(
        {
            "negative-single": (17, None),  # 5 + 12 instead of -5 + 12
            "negative-all": (6, None),
            "negative-mixed": (140, None),
        }
    )
    diagnosis = diagnose(SUM_INTEGERS_TASK, evaluation)
    assert diagnosis is not None
    assert diagnosis.weakness_id == NEGATIVE_INTEGERS_DROPPED
    assert set(diagnosis.evidence_case_ids) == {
        "negative-single",
        "negative-all",
        "negative-mixed",
    }


def test_diagnose_abstains_when_failures_include_exceptions() -> None:
    evaluation = _trace_eval({"negative-all": (None, "ValueError: boom")})
    assert diagnose(SUM_INTEGERS_TASK, evaluation) is None


def test_diagnose_abstains_on_unrelated_failures() -> None:
    evaluation = _trace_eval({"positives-pair": (99, None)})
    assert diagnose(SUM_INTEGERS_TASK, evaluation) is None


def test_diagnose_abstains_when_everything_passes() -> None:
    evaluation = _trace_eval({})
    assert diagnose(SUM_INTEGERS_TASK, evaluation) is None


# -- propose ----------------------------------------------------------------


def test_propose_patches_baseline_source() -> None:
    diagnosis = Diagnosis(NEGATIVE_INTEGERS_DROPPED, "d", ("negative-all",))
    candidate = propose(diagnosis, "gen-0000", BASELINE_STRATEGY_SOURCE)
    assert candidate is not None
    assert 'r"-?\\d+"' in candidate.source
    assert candidate.parent_generation_id == "gen-0000"


def test_propose_abstains_on_unknown_weakness() -> None:
    diagnosis = Diagnosis("mystery-weakness", "d", ("negative-all",))
    assert propose(diagnosis, "gen-0000", BASELINE_STRATEGY_SOURCE) is None


def test_propose_abstains_when_patch_target_missing() -> None:
    diagnosis = Diagnosis(NEGATIVE_INTEGERS_DROPPED, "d", ("negative-all",))
    assert propose(diagnosis, "gen-0000", "def solve(t): return 0\n") is None


# -- decide -----------------------------------------------------------------


def test_decide_accepts_strict_improvement() -> None:
    decision = decide(_eval(("a", True), ("b", False)), _eval(("a", True), ("b", True)))
    assert decision.accepted


def test_decide_rejects_regression_even_with_higher_score() -> None:
    baseline = _eval(("a", True), ("b", False), ("c", False))
    candidate = _eval(("a", False), ("b", True), ("c", True))
    decision = decide(baseline, candidate)
    assert not decision.accepted
    assert decision.regressed_case_ids == ("a",)


def test_decide_rejects_no_improvement() -> None:
    decision = decide(_eval(("a", True), ("b", False)), _eval(("a", True), ("b", False)))
    assert not decision.accepted
    assert "no strict improvement" in decision.reason
