"""Explicit acceptance rules comparing a validated candidate to its baseline."""

from __future__ import annotations

from strive.types import Decision, Evaluation


def decide(baseline: Evaluation, candidate: Evaluation) -> Decision:
    """Accept iff the candidate strictly improves the score with no regressions.

    Rules, in order:
    1. Any case the baseline passed must still pass (no regressions).
    2. The candidate's score must be strictly greater than the baseline's.
    """
    candidate_passing = set(candidate.passing_case_ids)
    regressed = tuple(
        case_id
        for case_id in baseline.passing_case_ids
        if case_id not in candidate_passing
    )
    if regressed:
        return Decision(
            accepted=False,
            reason=f"regressions on previously passing cases: {', '.join(regressed)}",
            baseline_score=baseline.score,
            candidate_score=candidate.score,
            regressed_case_ids=regressed,
        )
    if candidate.score <= baseline.score:
        return Decision(
            accepted=False,
            reason=(
                f"no strict improvement: candidate {candidate.score:.3f} "
                f"<= baseline {baseline.score:.3f}"
            ),
            baseline_score=baseline.score,
            candidate_score=candidate.score,
        )
    return Decision(
        accepted=True,
        reason=(
            f"strict improvement {baseline.score:.3f} -> {candidate.score:.3f} "
            "with no regressions"
        ),
        baseline_score=baseline.score,
        candidate_score=candidate.score,
    )
