"""Trusted stall detection: freeze on flat failing progress, resume by operator."""

from pathlib import Path

from strive.contracts import INTERVENTION_STALL_FREEZE
from strive.loop import LoopConfig, run_cycle
from strive.monitors import StallDetector
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK
from strive.propose import STRATEGY_CODE_SURFACE

# A weak strategy whose failure signature is diagnosable, but whose source
# lacks the registry patch target — so the proposer abstains every cycle and
# progress stays flat: a genuine stall.
UNPATCHABLE_WEAK_STRATEGY = '''\
import re

def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall("[0-9]+", input_text))
'''


def _seed_unpatchable(store: Store) -> None:
    generation = store.add_generation(
        UNPATCHABLE_WEAK_STRATEGY,
        parent_id=None,
        origin="seed",
        surface=STRATEGY_CODE_SURFACE,
        weakness_id=None,
        decision=None,
    )
    store.activate(generation.generation_id, reason="seed", policy="seed")


def test_stall_freezes_adaptation_and_resume_lifts_it(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    _seed_unpatchable(store)
    config = LoopConfig(stall_window=3)

    for _ in range(3):
        report = run_cycle(store, SUM_INTEGERS_TASK, config)
        assert report.diagnosis is not None  # weakness seen every cycle
        assert report.candidate is None  # proposer abstains every cycle

    freeze = store.adaptation_frozen()
    assert freeze is not None and freeze.kind == INTERVENTION_STALL_FREEZE

    # while frozen: evaluation still runs, adaptation does not
    frozen_report = run_cycle(store, SUM_INTEGERS_TASK, config)
    assert frozen_report.frozen
    assert frozen_report.diagnosis is None and frozen_report.candidate is None
    assert frozen_report.evaluation.overall_score > 0  # evidence keeps flowing
    generations_before = len(store.generations())

    # freeze holds across restart
    reopened = Store(tmp_path / "artifacts")
    assert reopened.adaptation_frozen() is not None
    assert len(reopened.generations()) == generations_before

    # operator resume lifts the freeze (journaled, nothing deleted)
    from strive.contracts import INTERVENTION_RESUME, Intervention
    from strive.events import now_iso

    reopened.append(
        Intervention(kind=INTERVENTION_RESUME, reason="operator resume", at=now_iso())
    )
    assert reopened.adaptation_frozen() is None
    resumed = run_cycle(reopened, SUM_INTEGERS_TASK, config)
    assert not resumed.frozen and resumed.diagnosis is not None


def test_healthy_idling_is_not_a_stall(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    config = LoopConfig(stall_window=3)
    run_cycle(store, SUM_INTEGERS_TASK, config)  # accepts the fix -> score 1.0
    for _ in range(4):
        run_cycle(store, SUM_INTEGERS_TASK, config)
    assert store.adaptation_frozen() is None  # perfect score cycles never freeze


def test_detector_requires_full_window() -> None:
    detector = StallDetector(window=3)
    assert not detector.check([]).stalled
