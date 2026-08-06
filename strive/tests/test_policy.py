"""Acceptance policies: paired-deterministic rules and provisional confirmation."""

import pytest

from strive.contracts import (
    CaseEvaluation,
    Evaluation,
    FailureRecord,
    HELD_OUT,
    VISIBLE,
)
from strive.policy import (
    PairedDeterministicPolicy,
    ProvisionalPolicy,
    get_policy,
)


def _eval(*cases: tuple[str, str, bool], failure: FailureRecord | None = None) -> Evaluation:
    evaluations = tuple(
        CaseEvaluation(
            case_id=case_id,
            split=split,
            passed=passed,
            score=1.0 if passed else 0.0,
            expected=0,
            output=0 if passed else 99,
            error=None,
            feedback="",
        )
        for case_id, split, passed in cases
    )
    split_scores: dict[str, float] = {}
    for split in {ce.split for ce in evaluations}:
        members = [ce for ce in evaluations if ce.split == split]
        split_scores[split] = sum(ce.score for ce in members) / len(members)
    overall = (
        sum(ce.score for ce in evaluations) / len(evaluations) if evaluations else 0.0
    )
    return Evaluation(
        overall_score=overall,
        split_scores=split_scores,
        feedback="",
        case_evaluations=evaluations,
        failure=failure,
    )


POLICY = PairedDeterministicPolicy()


def test_accepts_strict_improvement_on_both_splits() -> None:
    baseline = _eval(("a", VISIBLE, True), ("b", VISIBLE, False), ("h", HELD_OUT, False))
    candidate = _eval(("a", VISIBLE, True), ("b", VISIBLE, True), ("h", HELD_OUT, True))
    decision = POLICY.decide(baseline, candidate)
    assert decision.accepted
    assert decision.policy == "paired-deterministic" and decision.policy_version == 1


def test_rejects_regression_even_with_higher_score() -> None:
    baseline = _eval(("a", VISIBLE, True), ("b", VISIBLE, False), ("c", VISIBLE, False))
    candidate = _eval(("a", VISIBLE, False), ("b", VISIBLE, True), ("c", VISIBLE, True))
    decision = POLICY.decide(baseline, candidate)
    assert not decision.accepted
    assert decision.regressed_case_ids == ("a",)


def test_rejects_visible_improvement_that_degrades_held_out() -> None:
    baseline = _eval(("a", VISIBLE, False), ("h1", HELD_OUT, True), ("h2", HELD_OUT, False))
    candidate = _eval(("a", VISIBLE, True), ("h1", HELD_OUT, True), ("h2", HELD_OUT, False))
    # candidate improves visible but leaves held-out headroom untouched
    decision = POLICY.decide(baseline, candidate)
    assert not decision.accepted
    assert "held-out" in decision.reason


def test_rejects_no_visible_improvement() -> None:
    baseline = _eval(("a", VISIBLE, True), ("b", VISIBLE, False))
    candidate = _eval(("a", VISIBLE, True), ("b", VISIBLE, False))
    decision = POLICY.decide(baseline, candidate)
    assert not decision.accepted
    assert "no strict improvement" in decision.reason


def test_rejects_failed_candidate_execution() -> None:
    baseline = _eval(("a", VISIBLE, False))
    candidate = _eval(failure=FailureRecord("timeout", "killed"))
    decision = POLICY.decide(baseline, candidate)
    assert not decision.accepted
    assert "candidate execution failed" in decision.reason


def test_decision_records_policy_identity_and_split_scores() -> None:
    baseline = _eval(("a", VISIBLE, False), ("h", HELD_OUT, False))
    candidate = _eval(("a", VISIBLE, True), ("h", HELD_OUT, True))
    decision = POLICY.decide(baseline, candidate)
    assert decision.baseline_split_scores[VISIBLE] == 0.0
    assert decision.candidate_split_scores[HELD_OUT] == 1.0


def test_policy_registry_rejects_unknown_names() -> None:
    with pytest.raises(KeyError, match="unknown acceptance policy"):
        get_policy("universal-metric")


def test_provisional_confirms_only_sustained_baseline() -> None:
    policy = ProvisionalPolicy()
    assert policy.confirm([0.8, 0.9, 0.8], baseline_score=0.8)
    assert not policy.confirm([0.9, 0.7, 0.9], baseline_score=0.8)
    assert not policy.confirm([], baseline_score=0.0)
