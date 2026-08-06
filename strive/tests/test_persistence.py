"""Restart persistence and rollback across fresh Store instances."""

from pathlib import Path

import pytest

from strive.loop import run_cycle
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def test_state_survives_restart(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    first = Store(root)
    report = run_cycle(first, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted

    # simulate a restart: brand-new Store over the same directory
    reopened = Store(root)
    active = reopened.active_generation()
    assert active is not None
    assert active.generation_id == report.active_generation_after
    assert active.parent_id == report.active_generation_before
    assert "solve" in reopened.strategy_source(active)

    lineage = [record.generation_id for record in reopened.lineage()]
    assert lineage == [report.active_generation_after, report.active_generation_before]


def test_rollback_restores_parent_and_persists(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = Store(root)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.active_generation_after != report.active_generation_before

    restored = store.rollback()
    assert restored.generation_id == report.active_generation_before

    # rollback is itself durable across restart
    reopened = Store(root)
    active = reopened.active_generation()
    assert active is not None
    assert active.generation_id == report.active_generation_before

    # nothing was deleted: the rejected-back generation is still journaled
    assert report.active_generation_after in reopened.generations()


def test_rollback_without_history_raises(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    with pytest.raises(RuntimeError, match="no active generation"):
        store.rollback()


def test_rollback_past_seed_raises(tmp_path: Path) -> None:
    from strive.loop import ensure_seeded

    store = Store(tmp_path / "artifacts")
    ensure_seeded(store)
    with pytest.raises(RuntimeError, match="has no parent"):
        store.rollback()
