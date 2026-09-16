"""Source-clustered paired analysis, in one place.

A run failure leaves that side of a pair unidentified in {0, 1}, so the pair
contributes an interval rather than a point, and the estimate is a bound. That
reasoning was written out twice — once in `report.py` and once, nearly
line-for-line, in a research driver — which is how a driver's copy of the
neighbouring operating-point rule drifted from the package's and went on to
select the instances for an experiment.

Callers supply per-source pairs of `(treatment, baseline)` scores, each `None`
where that side did not produce a verdict, and get the bounds back. Nothing
here decides anything: no threshold, no action, no verdict on whether the
result is powered. Those belong to the caller.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import TypeVar

from .types import StrictModel

HOEFFDING_CONFIDENCE_TERM = 40.0

SourceKeyT = TypeVar("SourceKeyT", bound=str)


class PairedBoundsV1(StrictModel):
    """Bounds on a paired difference, clustered by source."""

    estimand: str
    source_clusters: int
    paired_complete: int
    point_delta_complete_pairs: float | None
    identification_lower: float
    identification_upper: float
    epsilon: float
    interval_lower: float
    interval_upper: float

    @property
    def minimum_detectable_effect(self) -> float:
        return self.epsilon


def pair_bounds(treatment: int | None, baseline: int | None) -> tuple[float, float]:
    """Bound one pair's difference, widening for whichever side is missing."""
    if treatment is not None and baseline is not None:
        delta = float(treatment - baseline)
        return delta, delta
    if baseline is not None:
        return float(-baseline), float(1 - baseline)
    if treatment is not None:
        return float(treatment - 1), float(treatment)
    return -1.0, 1.0


def paired_bounds(
    pairs: Mapping[SourceKeyT, Sequence[tuple[int | None, int | None]]],
    *,
    estimand: str,
) -> PairedBoundsV1:
    """Bound the mean paired difference `treatment - baseline` over sources.

    Each source's pairs are averaged first, then the source means are averaged,
    so a source contributing more trials does not carry more weight than the
    cluster structure allows.
    """
    if not pairs:
        raise ValueError("paired analysis requires at least one source")
    if any(not values for values in pairs.values()):
        raise ValueError("paired analysis requires at least one pair per source")
    source_bounds = []
    source_means = []
    complete = 0
    for _, values in sorted(pairs.items()):
        bounds = [pair_bounds(treatment, baseline) for treatment, baseline in values]
        source_bounds.append(
            (
                sum(lower for lower, _ in bounds) / len(bounds),
                sum(upper for _, upper in bounds) / len(bounds),
            )
        )
        deltas = [
            treatment - baseline
            for treatment, baseline in values
            if treatment is not None and baseline is not None
        ]
        complete += len(deltas)
        if deltas:
            source_means.append(sum(deltas) / len(deltas))
    source_count = len(source_bounds)
    identification = (
        sum(lower for lower, _ in source_bounds) / source_count,
        sum(upper for _, upper in source_bounds) / source_count,
    )
    epsilon = math.sqrt(2 * math.log(HOEFFDING_CONFIDENCE_TERM) / source_count)
    return PairedBoundsV1(
        estimand=estimand,
        source_clusters=source_count,
        paired_complete=complete,
        point_delta_complete_pairs=(
            sum(source_means) / len(source_means) if source_means else None
        ),
        identification_lower=identification[0],
        identification_upper=identification[1],
        epsilon=epsilon,
        interval_lower=max(-1.0, identification[0] - epsilon),
        interval_upper=min(1.0, identification[1] + epsilon),
    )
