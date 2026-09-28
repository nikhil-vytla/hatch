from __future__ import annotations

import json
from pathlib import Path

import pytest

from parallax.paired import pair_bounds, paired_bounds

EXPERIMENT_REPORT = (
    Path(__file__).parents[1]
    / "research"
    / "swebench-single-vs-evolved-20260803"
    / "evidence"
    / "experiment-report.json"
)


def test_a_complete_pair_is_a_point_and_a_missing_side_is_an_interval() -> None:
    assert pair_bounds(1, 0) == (1.0, 1.0)
    assert pair_bounds(0, 1) == (-1.0, -1.0)
    assert pair_bounds(1, None) == (0.0, 1.0)
    assert pair_bounds(0, None) == (-1.0, 0.0)
    assert pair_bounds(None, 1) == (-1.0, 0.0)
    assert pair_bounds(None, 0) == (0.0, 1.0)
    assert pair_bounds(None, None) == (-1.0, 1.0)


def test_complete_pairs_give_degenerate_identification_bounds() -> None:
    bounds = paired_bounds(
        {"a": [(1, 0), (1, 0)], "b": [(0, 0)]},
        estimand="treatment_minus_baseline",
    )

    assert bounds.paired_complete == 3
    assert bounds.identification_lower == bounds.identification_upper
    assert bounds.point_delta_complete_pairs == pytest.approx(0.5)
    assert bounds.source_clusters == 2


def test_a_run_failure_widens_the_bounds_without_moving_the_point() -> None:
    complete = paired_bounds({"a": [(1, 0)]}, estimand="e")
    partial = paired_bounds({"a": [(1, 0), (1, None)]}, estimand="e")

    assert partial.point_delta_complete_pairs == complete.point_delta_complete_pairs
    assert partial.identification_lower < partial.identification_upper


def test_precision_improves_only_with_source_clusters_not_trials() -> None:
    one = paired_bounds({"a": [(1, 0)] * 20}, estimand="e")
    four = paired_bounds({str(i): [(1, 0)] for i in range(4)}, estimand="e")

    assert four.epsilon < one.epsilon
    assert one.epsilon == pytest.approx(
        paired_bounds({"a": [(1, 0)]}, estimand="e").epsilon
    )


def test_intervals_stay_inside_the_representable_difference_range() -> None:
    bounds = paired_bounds({"a": [(None, None)]}, estimand="e")

    assert bounds.interval_lower == -1.0
    assert bounds.interval_upper == 1.0


def test_empty_input_is_rejected_rather_than_dividing_by_zero() -> None:
    with pytest.raises(ValueError, match="at least one source"):
        paired_bounds({}, estimand="e")
    with pytest.raises(ValueError, match="at least one pair"):
        paired_bounds({"a": []}, estimand="e")


def test_shared_math_reproduces_the_flagship_experiment_report() -> None:
    """The driver's own copy of this math produced these numbers."""
    recorded = json.loads(EXPERIMENT_REPORT.read_text())["paired_analysis"]
    conditions = json.loads(EXPERIMENT_REPORT.read_text())["conditions"]
    pairs = {
        source: [
            (
                int(arms["static"]["outcomes"][trial] == "pass"),
                int(arms["evolved"]["outcomes"][trial] == "pass"),
            )
            for trial in range(len(arms["static"]["outcomes"]))
        ]
        for source, arms in conditions.items()
    }

    bounds = paired_bounds(pairs, estimand=recorded["estimand"])

    assert bounds.paired_complete == recorded["paired_complete"]
    assert bounds.point_delta_complete_pairs == pytest.approx(
        recorded["point_delta_complete_pairs"]
    )
    assert bounds.identification_lower == pytest.approx(
        recorded["identification_bounds"]["lower"]
    )
    assert bounds.identification_upper == pytest.approx(
        recorded["identification_bounds"]["upper"]
    )
    assert bounds.epsilon == pytest.approx(recorded["interval"]["epsilon"])
    assert bounds.interval_lower == pytest.approx(recorded["interval"]["lower"])
    assert bounds.interval_upper == pytest.approx(recorded["interval"]["upper"])
