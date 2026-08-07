"""Task-scoped state: one artifact root, many tasks, zero cross-contamination.
Plus writer-lock head checks and the on-demand audit holdout."""

from pathlib import Path

import pytest

from strive.contracts import AUDIT
from strive.loop import audit_generation, run_cycle
from strive.store import Store, StoreError
from strive.tasks import MAX_INTEGERS_TASK, SUM_INTEGERS_TASK
from strive.diagnose import EvidenceDiagnoser
from strive.fakemodel import scripted_fixture_adapter
from strive.loop import LoopConfig
from strive.model_proposer import ModelProposer
from strive.contracts import BudgetSpec


def _model_config() -> LoopConfig:
    return LoopConfig(
        proposer=ModelProposer(),
        diagnoser=EvidenceDiagnoser(),
        model_adapter=scripted_fixture_adapter(),
        budget=BudgetSpec(model_calls=4),
    )


def test_sequential_tasks_share_a_root_without_contamination(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"

    sum_store = Store(root, SUM_INTEGERS_TASK.task_id)
    sum_report = run_cycle(sum_store, SUM_INTEGERS_TASK)
    assert sum_report.decision is not None and sum_report.decision.accepted

    max_store = Store(root, MAX_INTEGERS_TASK.task_id)
    max_report = run_cycle(max_store, MAX_INTEGERS_TASK, _model_config())
    assert max_report.decision is not None and max_report.decision.accepted

    # each task has its own journal, incumbent, and lineage
    assert sum_store.ledger_path != max_store.ledger_path
    sum_active = Store(root, SUM_INTEGERS_TASK.task_id).active_generation()
    max_active = Store(root, MAX_INTEGERS_TASK.task_id).active_generation()
    assert sum_active is not None and sum_active.task_id == "sum-integers"
    assert max_active is not None and max_active.task_id == "max-integers"
    assert "sum(" in sum_store.source_of(sum_active)
    assert "max(" in max_store.source_of(max_active)

    # every record carries its task identity and fingerprint
    for generation in sum_store.generations().values():
        assert generation.task_id == "sum-integers"
        assert generation.task_fingerprint == SUM_INTEGERS_TASK.fingerprint()
    assert all(
        a.task_id == "sum-integers"
        for a in [sum_store.active_activation()]
        if a is not None
    )

    # one task's generation ids cannot be resolved through another task's store
    # (same-numbered ids exist in both ledgers but never cross)
    assert sum_store.generation("gen-0001").task_id == "sum-integers"
    assert max_store.generation("gen-0001").task_id == "max-integers"


def test_store_task_binding_is_checked_by_the_loop(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    with pytest.raises(StoreError, match="bound to task"):
        run_cycle(store, MAX_INTEGERS_TASK)


def test_activation_head_check_refuses_concurrent_change(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # gen-0001 active
    active = store.active_generation()
    assert active is not None

    with pytest.raises(StoreError, match="head check failed"):
        store.activate(
            "gen-0000",
            reason="promote",
            policy="manual",
            expected_active="gen-9999",  # caller's view is stale
        )
    # and with the correct expectation it succeeds
    store.activate(
        "gen-0000",
        reason="rollback",
        policy="manual",
        expected_active=active.generation_id,
    )


# -- audit holdout ---------------------------------------------------------------


def test_audit_split_is_excluded_from_routine_cycles(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    report = run_cycle(store, SUM_INTEGERS_TASK)
    audit_ids = {c.case_id for c in SUM_INTEGERS_TASK.audit_cases()}
    assert audit_ids  # the task really declares audit cases

    evaluated = {ce.case_id for ce in report.evaluation.case_evaluations}
    assert evaluated.isdisjoint(audit_ids)
    assert AUDIT not in report.evaluation.split_scores
    assert report.decision is not None
    assert AUDIT not in report.decision.baseline_split_scores
    assert AUDIT not in report.decision.candidate_split_scores


def test_audit_runs_on_demand_and_scores_the_holdout(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts", SUM_INTEGERS_TASK.task_id)
    run_cycle(store, SUM_INTEGERS_TASK)  # accepted fix is active

    audit = audit_generation(store, SUM_INTEGERS_TASK)
    assert audit.evaluation.overall_score == 1.0  # the fix holds on the audit set
    assert {ce.split for ce in audit.evaluation.case_evaluations} == {AUDIT}

    # the weaker seed shows the difference on the same holdout
    seed_audit = audit_generation(store, SUM_INTEGERS_TASK, "gen-0000")
    assert seed_audit.evaluation.overall_score < 1.0
