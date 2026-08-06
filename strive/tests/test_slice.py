"""Phase-1 behavior, preserved: the vertical slice still runs end to end."""

from pathlib import Path

from strive.contracts import HELD_OUT, VISIBLE
from strive.events import EventLog
from strive.loop import run_cycle
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def test_first_cycle_detects_weakness_and_accepts_fix(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    report = run_cycle(store, SUM_INTEGERS_TASK)

    # baseline (seed) fails exactly the negative-number cases, on every split
    assert 0.0 < report.evaluation.overall_score < 1.0
    assert set(report.evaluation.failing_case_ids()) == {
        "negative-single",
        "negative-all",
        "held-negative-mixed",
        "held-negative-pair",
        "adv-phone-like",
        "adv-ranges",
    }
    assert report.evaluation.split_scores[VISIBLE] == 4 / 6
    assert report.evaluation.split_scores[HELD_OUT] == 1 / 3

    # weakness diagnosed from visible trace evidence only
    assert report.diagnosis is not None
    assert report.diagnosis.weakness_id == "negative-integers-dropped"
    assert set(report.diagnosis.evidence_case_ids) == {"negative-single", "negative-all"}

    # bounded candidate proposed, validated on all splits, accepted
    assert report.candidate is not None
    assert report.candidate_evaluation is not None
    assert report.candidate_evaluation.overall_score == 1.0
    assert report.decision is not None and report.decision.accepted
    assert report.decision.policy == "paired-deterministic"

    # active generation advanced with lineage
    assert report.generation_after != report.generation_before
    active = store.active_generation()
    assert active is not None
    assert active.parent_id == report.generation_before

    # structured, codec-valid events recorded for the run
    events = EventLog(
        store.runs_dir / report.run_id / "events.jsonl", report.run_id
    ).read_all()
    types = [event.type for event in events]
    for expected in (
        "cycle_started",
        "case_executed",
        "evaluated",
        "weakness_detected",
        "candidate_proposed",
        "decision",
        "retained",
        "activated",
        "cycle_completed",
    ):
        assert expected in types

    # usage attribution: every execution event names the generation that served it
    executed = [e for e in events if e.type == "case_executed"]
    assert executed and all("generation_id" in e.payload for e in executed)


def test_second_cycle_finds_no_weakness_and_proposes_nothing(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    run_cycle(store, SUM_INTEGERS_TASK)
    second = run_cycle(store, SUM_INTEGERS_TASK)

    assert second.evaluation.overall_score == 1.0
    assert second.diagnosis is None
    assert second.candidate is None
    assert second.generation_after == second.generation_before
