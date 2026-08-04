"""The one analysis path: evidence in, findings out, plus a readable summary.

The interval is a partial-identification bound, not a confidence interval. Each
unit that failed to produce a verdict contributes the widest difference it could
have had rather than being dropped, so a run with many infrastructure failures
reports a wide interval instead of a clean number computed off a biased
subsample. The Hoeffding term is clustered by task, because trials of the same
task are not independent.

This math existed twice: once here and once, sign-flipped, in a dated research
driver, alongside a third copy of the operating-point classification whose
thresholds had drifted from the package's. There is now one of each.
"""

from __future__ import annotations

import math
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal, TypeAlias, assert_never

from .experiment import Observation, Plan, read_journal, total_spend_usd
from .outcome import RunFailure, Verdict, Verification
from .perturbation import Condition
from .types import DesignDigest, NonEmptyText, SourceId, StrictModel, Usd

# Hoeffding at 95% two-sided for a difference in [-1, 1]: sqrt(2 ln(40) / k).
_HOEFFDING_NUMERATOR = 2 * math.log(40)
OperatingPoint: TypeAlias = Literal["floor", "ceiling", "informative", "unresolved"]
FLOOR_AT_OR_BELOW = 0.1
CEILING_AT_OR_ABOVE = 0.9


class ConditionSummary(StrictModel):
    condition: Condition
    units: int
    verified: int
    passed: int
    wrong: int
    invalid: int
    failures: int
    cost_usd: Usd
    prompt_tokens: int
    completion_tokens: int

    @property
    def pass_rate(self) -> float | None:
        return self.passed / self.verified if self.verified else None


class Contrast(StrictModel):
    """A paired treatment-minus-control difference with identification bounds."""

    treatment: Condition
    control: Condition
    task_clusters: int
    paired_units: int
    unpaired_units: int
    point_estimate: float | None
    lower: float
    upper: float
    epsilon: float
    unpaired_reasons: tuple[tuple[NonEmptyText, int], ...] = ()


class TaskOperatingPoint(StrictModel):
    task_id: SourceId
    condition: Condition
    verified: int
    passed: int
    point: OperatingPoint

    @property
    def pass_rate(self) -> float | None:
        return self.passed / self.verified if self.verified else None


class Findings(StrictModel):
    design_digest: DesignDigest
    model: NonEmptyText
    headroom_matched: bool
    units_planned: int
    units_observed: int
    conditions: tuple[ConditionSummary, ...]
    contrast: Contrast | None
    operating_points: tuple[TaskOperatingPoint, ...]
    failure_kinds: tuple[tuple[NonEmptyText, int], ...]
    fresh_cost_usd: Usd
    total_recorded_cost_usd: Usd


def _score(observation: Observation) -> int | None:
    """1 for a pass, 0 for any other verdict, None when nothing was verified."""

    outcome = observation.outcome
    if isinstance(outcome, Verification):
        return 1 if outcome.verdict is Verdict.PASS else 0
    if isinstance(outcome, RunFailure):
        return None
    assert_never(outcome)


def classify(verified: int, passed: int) -> OperatingPoint:
    """Place one task's observed pass rate on the difficulty scale.

    A task everything passes or everything fails cannot show a manipulation's
    effect, so screening uses this to pick instances that can. The thresholds
    are inclusive bands rather than exact 0 and 1 so that a task passing one
    trial in twenty still counts as a floor.
    """

    if verified == 0:
        return "unresolved"
    rate = passed / verified
    if rate <= FLOOR_AT_OR_BELOW:
        return "floor"
    if rate >= CEILING_AT_OR_ABOVE:
        return "ceiling"
    return "informative"


def _condition_summary(
    condition: Condition,
    observations: Sequence[Observation],
) -> ConditionSummary:
    verdicts = Counter(
        observation.outcome.verdict
        for observation in observations
        if isinstance(observation.outcome, Verification)
    )
    return ConditionSummary(
        condition=condition,
        units=len(observations),
        verified=sum(verdicts.values()),
        passed=verdicts[Verdict.PASS],
        wrong=verdicts[Verdict.WRONG],
        invalid=verdicts[Verdict.INVALID],
        failures=sum(
            1
            for observation in observations
            if isinstance(observation.outcome, RunFailure)
        ),
        cost_usd=sum(observation.estimated_cost_usd for observation in observations),
        prompt_tokens=sum(observation.prompt_tokens for observation in observations),
        completion_tokens=sum(
            observation.completion_tokens for observation in observations
        ),
    )


def _contrast(
    treatment: Condition,
    control: Condition,
    observations: Iterable[Observation],
) -> Contrast | None:
    scores: dict[tuple[SourceId, int, Condition], int | None] = {
        (item.unit.task_id, item.unit.trial_index, item.unit.condition): _score(item)
        for item in observations
    }
    failures: dict[tuple[SourceId, int, Condition], str] = {
        key: item.outcome.failure_kind
        for item in observations
        if isinstance(item.outcome, RunFailure)
        for key in ((item.unit.task_id, item.unit.trial_index, item.unit.condition),)
    }
    pairs = sorted(
        {
            (task_id, trial)
            for task_id, trial, condition in scores
            if condition in (treatment, control)
        }
    )
    if not pairs:
        return None
    bounds: dict[SourceId, list[tuple[float, float]]] = defaultdict(list)
    complete: dict[SourceId, list[int]] = defaultdict(list)
    reasons: Counter[str] = Counter()
    paired = unpaired = 0
    for task_id, trial in pairs:
        treatment_key = (task_id, trial, treatment)
        control_key = (task_id, trial, control)
        if treatment_key not in scores or control_key not in scores:
            continue
        treatment_score = scores[treatment_key]
        control_score = scores[control_key]
        if treatment_score is not None and control_score is not None:
            difference = treatment_score - control_score
            lower = upper = float(difference)
            complete[task_id].append(difference)
            paired += 1
        else:
            unpaired += 1
            if control_score is not None:
                lower, upper = float(-control_score), float(1 - control_score)
                reasons[f"{treatment}:{failures[treatment_key]}"] += 1
            elif treatment_score is not None:
                lower, upper = float(treatment_score - 1), float(treatment_score)
                reasons[f"{control}:{failures[control_key]}"] += 1
            else:
                lower, upper = -1.0, 1.0
                reasons[f"{treatment}:{failures[treatment_key]}"] += 1
                reasons[f"{control}:{failures[control_key]}"] += 1
        bounds[task_id].append((lower, upper))
    if not bounds:
        return None
    clusters = len(bounds)
    per_task = [
        (
            sum(item[0] for item in values) / len(values),
            sum(item[1] for item in values) / len(values),
        )
        for _, values in sorted(bounds.items())
    ]
    identified = (
        sum(item[0] for item in per_task) / clusters,
        sum(item[1] for item in per_task) / clusters,
    )
    task_means = [
        sum(values) / len(values) for _, values in sorted(complete.items()) if values
    ]
    epsilon = math.sqrt(_HOEFFDING_NUMERATOR / clusters)
    return Contrast(
        treatment=treatment,
        control=control,
        task_clusters=clusters,
        paired_units=paired,
        unpaired_units=unpaired,
        point_estimate=(sum(task_means) / len(task_means) if task_means else None),
        lower=max(-1.0, identified[0] - epsilon),
        upper=min(1.0, identified[1] + epsilon),
        epsilon=epsilon,
        unpaired_reasons=tuple(sorted(reasons.items())),
    )


def summarize(
    plan: Plan,
    observations: Sequence[Observation],
    *,
    treatment: Condition | None = None,
    control: Condition | None = None,
) -> Findings:
    """Reduce one journal to findings.

    `treatment` and `control` default to the plan's condition order, so a
    two-condition experiment needs no arguments and a wider one names its
    comparison explicitly.
    """

    if any(item.design_digest != plan.design_digest for item in observations):
        raise ValueError("observations were recorded under a different design")
    ordered = tuple(dict.fromkeys(unit.condition for unit in plan.units))
    by_condition: dict[Condition, list[Observation]] = {
        condition: [] for condition in ordered
    }
    for observation in observations:
        by_condition.setdefault(observation.unit.condition, []).append(observation)
    if control is None or treatment is None:
        if len(ordered) < 2:
            control = treatment = None
        else:
            control, treatment = ordered[0], ordered[1]
    verdict_counts: dict[tuple[SourceId, Condition], tuple[int, int]] = defaultdict(
        lambda: (0, 0)
    )
    for observation in observations:
        score = _score(observation)
        if score is None:
            continue
        key = (observation.unit.task_id, observation.unit.condition)
        verified, passed = verdict_counts[key]
        verdict_counts[key] = (verified + 1, passed + score)
    return Findings(
        design_digest=plan.design_digest,
        model=plan.model,
        headroom_matched=plan.headroom_matched,
        units_planned=len(plan.units),
        units_observed=len(observations),
        conditions=tuple(
            _condition_summary(condition, by_condition[condition])
            for condition in ordered
        ),
        contrast=(
            _contrast(treatment, control, observations)
            if treatment is not None and control is not None
            else None
        ),
        operating_points=tuple(
            TaskOperatingPoint(
                task_id=task_id,
                condition=condition,
                verified=verified,
                passed=passed,
                point=classify(verified, passed),
            )
            for (task_id, condition), (verified, passed) in sorted(
                verdict_counts.items()
            )
        ),
        failure_kinds=tuple(
            sorted(
                Counter(
                    observation.outcome.failure_kind
                    for observation in observations
                    if isinstance(observation.outcome, RunFailure)
                ).items()
            )
        ),
        fresh_cost_usd=total_spend_usd(observations),
        total_recorded_cost_usd=sum(
            observation.estimated_cost_usd for observation in observations
        ),
    )


def _rate(value: float | None) -> str:
    return "  n/a" if value is None else f"{value:5.0%}"


def render(findings: Findings) -> str:
    """Format findings for a human who has ten seconds.

    Order is deliberate: what broke, then what happened, then the contrast, then
    the bill. A reader who stops after the first two lines has still learned
    whether the numbers below them mean anything.
    """

    lines: list[str] = []
    complete = findings.units_observed == findings.units_planned
    integrity = [
        f"{findings.units_observed}/{findings.units_planned} units"
        + ("" if complete else " INCOMPLETE"),
    ]
    if not findings.headroom_matched:
        integrity.append("HEADROOM NOT MATCHED")
    if findings.failure_kinds:
        integrity.append(
            "failures: "
            + ", ".join(f"{kind}={count}" for kind, count in findings.failure_kinds)
        )
    else:
        integrity.append("no run failures")
    lines.append(f"{findings.model} @ {findings.design_digest[:12]}")
    lines.append("  " + " | ".join(integrity))
    lines.append("")
    lines.append("  condition            pass   verified  wrong  invalid  failed")
    for summary in findings.conditions:
        lines.append(
            f"  {summary.condition!s:<20} {_rate(summary.pass_rate)}"
            f"  {summary.verified:>8}  {summary.wrong:>5}"
            f"  {summary.invalid:>7}  {summary.failures:>6}"
        )
    contrast = findings.contrast
    if contrast is not None:
        point = (
            "n/a"
            if contrast.point_estimate is None
            else f"{contrast.point_estimate:+.3f}"
        )
        lines.append("")
        lines.append(
            f"  {contrast.treatment} - {contrast.control}: {point} "
            f"[{contrast.lower:+.3f}, {contrast.upper:+.3f}] "
            f"across {contrast.task_clusters} task cluster(s)"
        )
        if contrast.unpaired_units:
            lines.append(
                f"  {contrast.unpaired_units} of "
                f"{contrast.paired_units + contrast.unpaired_units} trials were "
                f"unpaired and widen the bound by construction"
            )
        if contrast.epsilon >= 0.5:
            lines.append(
                f"  the sample supports no effect smaller than "
                f"{contrast.epsilon:.2f}; treat the sign as descriptive"
            )
    informative = sum(
        1 for point in findings.operating_points if point.point == "informative"
    )
    if findings.operating_points:
        lines.append("")
        lines.append(
            f"  operating points: {informative} informative of "
            f"{len(findings.operating_points)} task-conditions"
        )
    lines.append("")
    lines.append(
        f"  paid ${findings.fresh_cost_usd:.2f} this session; "
        f"${findings.total_recorded_cost_usd:.2f} recorded across all sessions"
    )
    return "\n".join(lines)


def from_journal(
    path: Path,
    *,
    treatment: Condition | None = None,
    control: Condition | None = None,
) -> Findings:
    """The whole analysis path: a journal in, findings out.

    Four dated research folders each carried their own summarizer, and they
    drifted: one classified operating points at `== 0`/`== 1` where the package
    used `<= 0.1`/`>= 0.9`, and that copy is what selected instances for the
    flagship experiment. There is one classifier now, and this is the only way
    in.
    """

    records = read_journal(path)
    plans = [record for record in records if isinstance(record, Plan)]
    if len(plans) != 1:
        raise ValueError(f"{path} holds {len(plans)} plans; expected exactly one")
    observations = [item for item in records if isinstance(item, Observation)]
    return summarize(plans[0], observations, treatment=treatment, control=control)


def main(argv: Sequence[str]) -> int:
    if len(argv) not in (1, 3):
        raise SystemExit(
            "usage: python -m parallax.findings JOURNAL [CONTROL TREATMENT]"
        )
    named = (
        {"control": Condition(argv[1]), "treatment": Condition(argv[2])}
        if len(argv) == 3
        else {}
    )
    print(render(from_journal(Path(argv[0]), **named)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
