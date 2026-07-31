from __future__ import annotations

from dataclasses import dataclass
from statistics import mean


@dataclass(frozen=True)
class RolloutObservation:
    task_id: str
    model: str
    tier: str
    status: str
    reward: float | None
    semantic_reward: float | None
    failure_tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class CurriculumDecision:
    action: str
    reason: str
    strong_semantic_rate: float | None
    weak_semantic_rate: float | None
    error_rate: float
    next_transforms: tuple[str, ...]


def decide_curriculum(observations: list[RolloutObservation]) -> CurriculumDecision:
    if not observations:
        raise ValueError("at least one rollout observation is required")
    errors = [item for item in observations if item.status == "error"]
    error_rate = len(errors) / len(observations)
    completed = [
        item
        for item in observations
        if item.status == "completed" and item.semantic_reward is not None
    ]
    strong = [item.semantic_reward for item in completed if item.tier == "strong"]
    weak = [item.semantic_reward for item in completed if item.tier == "weak"]
    strong_rate = mean(strong) if strong else None
    weak_rate = mean(weak) if weak else None

    if error_rate > 0.25:
        return CurriculumDecision(
            action="repair_harness",
            reason="More than 25% of rollouts failed outside task grading.",
            strong_semantic_rate=strong_rate,
            weak_semantic_rate=weak_rate,
            error_rate=error_rate,
            next_transforms=(
                "isolate the workspace",
                "bound shell command duration",
                "pin the package environment",
            ),
        )
    if strong_rate is not None and strong_rate > 0.4:
        return CurriculumDecision(
            action="harden",
            reason="Strong-model semantic success exceeds the 40% admission ceiling.",
            strong_semantic_rate=strong_rate,
            weak_semantic_rate=weak_rate,
            error_rate=error_rate,
            next_transforms=(
                "add cross-module state propagation",
                "add sequence-dependent behavior",
                "adversarially mutate plausible solutions",
                "remove implementation-shaped clues",
            ),
        )
    if strong_rate == 0:
        return CurriculumDecision(
            action="simplify",
            reason="No valid strong-model rollout made semantic progress.",
            strong_semantic_rate=strong_rate,
            weak_semantic_rate=weak_rate,
            error_rate=error_rate,
            next_transforms=(
                "expose one behavioral example",
                "reduce omitted implementation sites",
            ),
        )
    return CurriculumDecision(
        action="retain",
        reason="The family has nonzero, nonsaturated strong-model success.",
        strong_semantic_rate=strong_rate,
        weak_semantic_rate=weak_rate,
        error_rate=error_rate,
        next_transforms=("generate additional seeds", "monitor reward spread"),
    )
