"""End-to-end test of the vertical slice: one full evolution cycle."""

import json
from pathlib import Path

from strive.loop import run_cycle
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def test_first_cycle_detects_weakness_and_accepts_fix(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    report = run_cycle(store, SUM_INTEGERS_TASK)

    # baseline (seed) strategy fails exactly the negative-number cases
    assert 0.0 < report.baseline_evaluation.score < 1.0
    assert set(report.baseline_evaluation.failing_case_ids) == {
        "negative-single",
        "negative-all",
        "negative-mixed",
    }

    # weakness diagnosed from trace evidence
    assert report.diagnosis is not None
    assert report.diagnosis.weakness_id == "negative-integers-dropped"

    # bounded candidate proposed, validated, and accepted
    assert report.candidate is not None
    assert report.candidate_evaluation is not None
    assert report.candidate_evaluation.score == 1.0
    assert report.decision is not None and report.decision.accepted

    # active generation advanced, lineage recorded
    assert report.active_generation_after != report.active_generation_before
    active = store.active_generation()
    assert active is not None
    assert active.parent_id == report.active_generation_before

    # structured events were recorded for the run
    events_path = store.runs_dir / report.run_id / "events.jsonl"
    assert events_path.exists()
    event_types = [
        json.loads(line)["type"] for line in events_path.read_text().splitlines()
    ]
    for expected in (
        "cycle_started",
        "case_executed",
        "evaluated",
        "weakness_detected",
        "candidate_proposed",
        "validated",
        "decision",
        "retained",
        "cycle_completed",
    ):
        assert expected in event_types


def test_second_cycle_finds_no_weakness_and_proposes_nothing(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    run_cycle(store, SUM_INTEGERS_TASK)
    second = run_cycle(store, SUM_INTEGERS_TASK)

    assert second.baseline_evaluation.score == 1.0
    assert second.diagnosis is None
    assert second.candidate is None
    assert second.active_generation_after == second.active_generation_before
