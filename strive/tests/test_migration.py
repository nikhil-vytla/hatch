"""Legacy stage-2a ledger handling: loud detection, safe migration, drift."""

import json
from pathlib import Path

import pytest

from strive import codec
from strive.cas import ObjectStore
from strive.contracts import (
    Decision,
    INTERVENTION_LEGACY_MIGRATION,
)
from strive.loop import LoopConfig, run_cycle
from strive.migrate import migrate_legacy_ledger
from strive.store import LegacyLedgerError, Store, StoreError
from strive.tasks import BASELINE_STRATEGY_SOURCE, SUM_INTEGERS_TASK

FIXED_SOURCE = BASELINE_STRATEGY_SOURCE.replace('r"\\d+"', 'r"-?\\d+"')


def _downgrade(record: dict[str, object], kind: str) -> str:
    """Turn a current v2 record dict into its true v1 shape: v1 was exactly
    v2 minus the task-identity fields."""
    legacy = dict(record)
    legacy["schema"] = f"{kind}@1"
    legacy.pop("task_id", None)
    legacy.pop("task_fingerprint", None)
    return json.dumps(legacy, sort_keys=True, separators=(",", ":"))


def _write_legacy_root(tmp_path: Path, cycle_fingerprint: str) -> Path:
    """Build an artifact root holding a genuine stage-2a ledger: seed +
    accepted evolution + rollback + re-promotion, with sources in CAS."""
    root = tmp_path / "artifacts"
    objects = ObjectStore(root / "objects")
    seed_ref = objects.put_text(BASELINE_STRATEGY_SOURCE)
    fixed_ref = objects.put_text(FIXED_SOURCE)

    # build v2 records with a scratch store, then downgrade them to v1 shapes
    scratch = Store(tmp_path / "scratch", SUM_INTEGERS_TASK.task_id)
    decision = Decision(
        accepted=True,
        reason="strict improvement with zero regressions",
        policy="paired-deterministic",
        policy_version=1,
        baseline_score=0.455,
        candidate_score=1.0,
        baseline_split_scores={"visible": 0.667},
        candidate_split_scores={"visible": 1.0},
    )
    seed = scratch.add_generation(
        BASELINE_STRATEGY_SOURCE,
        task_fingerprint="ignored",
        parent_id=None,
        origin="seed",
        surface="strategy-code",
        weakness_id=None,
        decision=None,
    )
    evolved = scratch.add_generation(
        FIXED_SOURCE,
        task_fingerprint="ignored",
        parent_id=seed.generation_id,
        origin="evolved",
        surface="strategy-code",
        weakness_id="negative-integers-dropped",
        decision=decision,
    )
    activations = [
        scratch.activate(seed.generation_id, reason="seed", policy="seed"),
        scratch.activate(evolved.generation_id, reason="evolved", policy="paired-deterministic@1"),
        scratch.activate(seed.generation_id, reason="rollback", policy="manual"),
        scratch.activate(evolved.generation_id, reason="promote", policy="paired-deterministic@1"),
    ]
    cycle = json.dumps(
        {
            "schema": "cycle@1",
            "run_id": "run-legacy-0001",
            "at": "2026-08-06T23:00:00+00:00",
            "task_id": SUM_INTEGERS_TASK.task_id,
            "task_fingerprint": cycle_fingerprint,
            "generation_id": seed.generation_id,
            "overall_score": 0.455,
            "split_scores": {"visible": 0.667},
            "weakness_id": "negative-integers-dropped",
            "candidate_generation_id": evolved.generation_id,
            "accepted": True,
            "frozen": False,
            "usage": {
                "schema": "budget-usage@1",
                "wall_time_s": 0.1,
                "executions": 2,
                "model_calls": 0,
                "tokens": 0,
                "output_bytes": 100,
                "cost": 0.0,
                "recursion_depth": 0,
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    )

    lines = [
        _downgrade(codec.encode(seed), "generation"),
        _downgrade(codec.encode(activations[0]), "activation"),
        _downgrade(codec.encode(evolved), "generation"),
        _downgrade(codec.encode(activations[1]), "activation"),
        cycle,
        _downgrade(codec.encode(activations[2]), "activation"),
        _downgrade(codec.encode(activations[3]), "activation"),
    ]
    ledger_dir = root / "ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    (ledger_dir / "ledger.jsonl").write_text("\n".join(lines) + "\n")
    assert seed_ref and fixed_ref  # sources are resolvable post-migration
    return root


def test_legacy_ledger_is_detected_loudly_not_ignored(tmp_path: Path) -> None:
    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    with pytest.raises(LegacyLedgerError, match="migrate-legacy"):
        Store(root, SUM_INTEGERS_TASK.task_id)


def test_migration_preserves_history_and_original_file(tmp_path: Path) -> None:
    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    legacy_bytes = (root / "ledger" / "ledger.jsonl").read_bytes()

    report = migrate_legacy_ledger(root, SUM_INTEGERS_TASK)
    assert report.generations == 2
    assert report.activations == 4
    assert report.cycles == 1
    assert not report.fingerprint_drifted

    # original preserved byte-for-byte
    assert (root / "ledger" / "ledger.jsonl").read_bytes() == legacy_bytes

    store = Store(root, SUM_INTEGERS_TASK.task_id)
    # active generation reflects the final activation (post-rollback promote)
    active = store.active_generation()
    assert active is not None and active.generation_id == "gen-0001"
    assert active.task_id == SUM_INTEGERS_TASK.task_id
    # lineage, decision, and rollback history all preserved
    assert [g.generation_id for g in store.lineage()] == ["gen-0001", "gen-0000"]
    assert active.decision is not None and active.decision.accepted
    from strive.contracts import Activation

    reasons = [a.reason for a in store.entries() if isinstance(a, Activation)]
    assert reasons == ["seed", "evolved", "rollback", "promote"]
    # migration marker journaled
    assert any(
        i.kind == INTERVENTION_LEGACY_MIGRATION for i in store.interventions()
    )
    # rollback still works on migrated history
    restored = store.rollback()
    assert restored.generation_id == "gen-0000"
    # and the loop runs on top of migrated state
    result = run_cycle(store, SUM_INTEGERS_TASK)
    assert result.evaluation.overall_score > 0


def test_migration_refuses_existing_target(tmp_path: Path) -> None:
    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    migrate_legacy_ledger(root, SUM_INTEGERS_TASK)
    with pytest.raises(StoreError, match="already exists"):
        migrate_legacy_ledger(root, SUM_INTEGERS_TASK)


def test_migration_refuses_foreign_task_history(tmp_path: Path) -> None:
    root = _write_legacy_root(tmp_path, SUM_INTEGERS_TASK.fingerprint())
    from strive.tasks import MAX_INTEGERS_TASK

    with pytest.raises(StoreError, match="other tasks"):
        migrate_legacy_ledger(root, MAX_INTEGERS_TASK)


def test_migration_with_no_legacy_ledger_is_a_clean_error(tmp_path: Path) -> None:
    with pytest.raises(StoreError, match="nothing to migrate"):
        migrate_legacy_ledger(tmp_path / "empty", SUM_INTEGERS_TASK)


def test_migrated_drifted_fingerprint_requires_acknowledgement(tmp_path: Path) -> None:
    """A legacy ledger written for an older task definition migrates cleanly,
    but mutating runs then require the explicit drift acknowledgement."""
    root = _write_legacy_root(tmp_path, "00" * 32)  # old fingerprint, drifted
    report = migrate_legacy_ledger(root, SUM_INTEGERS_TASK)
    assert report.fingerprint_drifted

    store = Store(root, SUM_INTEGERS_TASK.task_id)
    with pytest.raises(StoreError, match="task-fingerprint drift"):
        run_cycle(store, SUM_INTEGERS_TASK)

    acknowledged = run_cycle(
        store, SUM_INTEGERS_TASK, LoopConfig(acknowledge_task_drift=True)
    )
    assert acknowledged.evaluation.overall_score > 0
    assert any(
        i.kind == "task-drift-acknowledged" for i in store.interventions()
    )
