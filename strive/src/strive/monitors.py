"""Trusted mechanical monitors.

These are deliberately dumb and kernel-side (D10): the Continual Harness
paper's stall case study showed self-diagnosis is confidently wrong exactly
when it matters, so stall detection must not depend on any evolvable
component. A monitor can freeze adaptation (journaled intervention); it never
edits surfaces. Freezing halts propose/validate/promote; execute/evaluate
keep running so evidence continues to accumulate.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive.contracts import CycleRecord


@dataclass(frozen=True)
class StallVerdict:
    stalled: bool
    reason: str


class StallDetector:
    """Flags flat, failing progress: N consecutive cycles with the same active
    generation, the same score below perfection, and nothing promoted.

    Healthy idling (score 1.0, nothing to fix) is not a stall. Cycles executed
    while adaptation was already frozen don't count toward a new stall.
    """

    def __init__(self, window: int = 3) -> None:
        if window < 2:
            raise ValueError("stall window must be at least 2")
        self.window = window

    def check(self, cycles: list[CycleRecord]) -> StallVerdict:
        recent = [c for c in cycles if not c.frozen][-self.window :]
        if len(recent) < self.window:
            return StallVerdict(False, f"only {len(recent)} unfrozen cycles observed")
        first = recent[0]
        if first.overall_score >= 1.0:
            return StallVerdict(False, "score is perfect; idle, not stalled")
        same = all(
            c.generation_id == first.generation_id
            and c.overall_score == first.overall_score
            and c.accepted is not True
            for c in recent
        )
        if same:
            return StallVerdict(
                True,
                f"{self.window} consecutive cycles on {first.generation_id} at "
                f"score {first.overall_score:.3f} with no accepted change",
            )
        return StallVerdict(False, "recent cycles differ")
