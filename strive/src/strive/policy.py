"""Pluggable, versioned acceptance and promotion policies.

There is deliberately no single universal acceptance formula (D14): each
policy is a trusted, named, versioned object, and every Decision records
which policy produced it. The kernel's invariant is that decisions are
journaled with trusted-side evidence — what counts as sufficient evidence is
the policy's business, chosen per surface and risk tier (D1):

- ``paired-deterministic@1`` — durable promotion of deterministic code:
  paired incumbent/candidate evaluation, zero regressions on any split,
  strict improvement on visible AND held-out evidence.
- ``provisional@1`` — low-risk / online changes: activation without full
  paired evidence, but scoped, monitored, reversible, and expiring; confirmed
  to durable only if the observation window sustains the baseline score.

Static checks and model judgment may *reject* candidates early (pre-filters);
no policy in this module treats them as sufficient evidence for durable
broad-scope promotion.
"""

from __future__ import annotations

from typing import Protocol

from strive.contracts import HELD_OUT, VISIBLE, Decision, Evaluation


class AcceptancePolicy(Protocol):
    """Compares candidate evidence against the incumbent and renders a Decision."""

    name: str
    version: int

    def decide(self, baseline: Evaluation, candidate: Evaluation) -> Decision: ...


class PairedDeterministicPolicy:
    """Durable promotion for deterministic code surfaces.

    Rules, in order:
    1. The candidate execution must have completed (failure-as-data → reject).
    2. Zero regressions: every case the baseline passed still passes, on
       every split.
    3. Strict improvement on the visible split.
    4. Held-out discipline: held-out score must strictly improve when the
       baseline left room, and must never degrade.
    """

    name = "paired-deterministic"
    version = 1

    def decide(self, baseline: Evaluation, candidate: Evaluation) -> Decision:
        def verdict(accepted: bool, reason: str, regressed: tuple[str, ...] = ()) -> Decision:
            return Decision(
                accepted=accepted,
                reason=reason,
                policy=self.name,
                policy_version=self.version,
                baseline_score=baseline.overall_score,
                candidate_score=candidate.overall_score,
                baseline_split_scores=dict(baseline.split_scores),
                candidate_split_scores=dict(candidate.split_scores),
                regressed_case_ids=regressed,
            )

        if candidate.failure is not None:
            return verdict(
                False,
                f"candidate execution failed: {candidate.failure.kind} — "
                f"{candidate.failure.detail}",
            )

        candidate_passing = set(candidate.passing_case_ids())
        regressed = tuple(
            case_id
            for case_id in baseline.passing_case_ids()
            if case_id not in candidate_passing
        )
        if regressed:
            return verdict(
                False,
                f"regressions on previously passing cases: {', '.join(regressed)}",
                regressed,
            )

        baseline_visible = baseline.split_scores.get(VISIBLE, 0.0)
        candidate_visible = candidate.split_scores.get(VISIBLE, 0.0)
        if candidate_visible <= baseline_visible:
            return verdict(
                False,
                f"no strict improvement on visible split: "
                f"{candidate_visible:.3f} <= {baseline_visible:.3f}",
            )

        baseline_held = baseline.split_scores.get(HELD_OUT)
        candidate_held = candidate.split_scores.get(HELD_OUT)
        if baseline_held is not None and candidate_held is not None:
            if candidate_held < baseline_held:
                return verdict(
                    False,
                    f"held-out degradation: {candidate_held:.3f} < {baseline_held:.3f}",
                )
            if baseline_held < 1.0 and candidate_held <= baseline_held:
                return verdict(
                    False,
                    "no held-out improvement despite headroom: "
                    f"{candidate_held:.3f} <= {baseline_held:.3f}",
                )

        return verdict(
            True,
            "strict improvement with zero regressions "
            f"(visible {baseline_visible:.3f} -> {candidate_visible:.3f}, "
            f"overall {baseline.overall_score:.3f} -> {candidate.overall_score:.3f})",
        )


class ProvisionalPolicy:
    """Expiring provisional activation for low-risk changes.

    A provisional activation is confirmed to durable only if every cycle in
    its observation window scored at least the recorded baseline; otherwise
    it reverts to the previous generation. Either outcome is journaled.
    """

    name = "provisional"
    version = 1

    def confirm(self, window_scores: list[float], baseline_score: float) -> bool:
        if not window_scores:
            return False
        return all(score >= baseline_score for score in window_scores)


POLICIES: dict[str, AcceptancePolicy] = {
    PairedDeterministicPolicy.name: PairedDeterministicPolicy(),
}

PROVISIONAL_POLICY = ProvisionalPolicy()


def get_policy(name: str) -> AcceptancePolicy:
    if name not in POLICIES:
        raise KeyError(
            f"unknown acceptance policy {name!r}; known: {sorted(POLICIES)}"
        )
    return POLICIES[name]
