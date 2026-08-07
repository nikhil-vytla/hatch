"""Durability: restart persistence, rollback, atomic promotion, corruption."""

from pathlib import Path

import pytest

from strive.cas import ObjectCorruption
from strive.loop import ensure_seeded, run_cycle
from strive.store import LedgerError, Store, StoreError
from strive.tasks import SUM_INTEGERS_TASK


def _evolved_store(root: Path) -> Store:
    store = Store(root)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    assert report.decision is not None and report.decision.accepted
    return store


def test_state_survives_restart(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    active_before = store.active_generation()
    assert active_before is not None

    reopened = Store(root)  # brand-new instance over the same directory
    active = reopened.active_generation()
    assert active is not None
    assert active.generation_id == active_before.generation_id
    assert active.parent_id == active_before.parent_id
    assert "solve" in reopened.source_of(active)
    assert [g.generation_id for g in reopened.lineage()] == [
        g.generation_id for g in store.lineage()
    ]


def test_rollback_restores_parent_without_deleting_history(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    entries_before = len(store.entries())
    evolved = store.active_generation()
    assert evolved is not None

    restored = store.rollback()
    assert restored.generation_id == evolved.parent_id

    reopened = Store(root)
    active = reopened.active_generation()
    assert active is not None and active.generation_id == restored.generation_id
    # append-only: rollback added history, deleted none
    assert len(reopened.entries()) == entries_before + 1
    assert evolved.generation_id in reopened.generations()


def test_rollback_without_history_raises_cleanly(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    with pytest.raises(StoreError, match="no active generation"):
        store.rollback()


def test_rollback_past_seed_raises_cleanly(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    ensure_seeded(store, SUM_INTEGERS_TASK)
    with pytest.raises(StoreError, match="has no parent"):
        store.rollback()


def test_promotion_is_atomic_under_crash(tmp_path: Path) -> None:
    """A crash after retaining the candidate but before its activation line
    leaves the previous activation in force — never a half-promoted state."""
    root = tmp_path / "artifacts"
    store = Store(root)
    ensure_seeded(store, SUM_INTEGERS_TASK)
    seed = store.active_generation()
    assert seed is not None

    candidate = store.add_generation(
        "def solve(t):\n    return 0\n",
        parent_id=seed.generation_id,
        origin="evolved",
        surface="strategy-code",
        weakness_id=None,
        decision=None,
    )
    # simulated crash here: generation appended, activation never written

    reopened = Store(root)
    active = reopened.active_generation()
    assert active is not None and active.generation_id == seed.generation_id
    assert candidate.generation_id in reopened.generations()  # retained, not active

    # completing the promotion is a single activation append
    reopened.activate(candidate.generation_id, reason="promote", policy="manual")
    again = Store(root).active_generation()
    assert again is not None and again.generation_id == candidate.generation_id


def test_torn_final_line_is_tolerated_and_reported(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    active_before = store.active_generation()
    assert active_before is not None
    with store.ledger_path.open("ab") as handle:
        handle.write(b'{"schema":"activation@1","generation_id":"gen-')  # torn append

    reopened = Store(root)
    active = reopened.active_generation()  # must not crash
    assert active is not None and active.generation_id == active_before.generation_id
    assert any("torn final line" in d for d in reopened.diagnostics)


def test_interior_corruption_is_rejected_loudly(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    lines = store.ledger_path.read_bytes().splitlines(keepends=True)
    lines[0] = b'{"schema":"generation@1","garbage":true}\n'
    store.ledger_path.write_bytes(b"".join(lines))

    reopened = Store(root)
    with pytest.raises(LedgerError, match="ledger.jsonl:1"):
        reopened.entries()


def test_unsupported_schema_version_in_ledger_is_loud(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    raw = store.ledger_path.read_text()
    store.ledger_path.write_text(raw.replace("generation@1", "generation@9", 1))
    with pytest.raises(LedgerError, match="unsupported generation version 9"):
        Store(root).entries()


def test_corrupt_object_store_content_is_detected(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = _evolved_store(root)
    active = store.active_generation()
    assert active is not None
    object_path = store.objects.root / active.source_ref[:2] / active.source_ref
    object_path.write_text("tampered = True\n")

    with pytest.raises(ObjectCorruption, match="failed verification"):
        Store(root).source_of(active)
