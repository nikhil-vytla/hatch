"""Trusted budget enforcement: exhaustion is recorded data, never a crash."""

from pathlib import Path

from strive.budget import BudgetMeter
from strive.contracts import FAILURE_BUDGET_EXHAUSTED, BudgetSpec
from strive.loop import LoopConfig, run_cycle
from strive.store import Store
from strive.tasks import SUM_INTEGERS_TASK


def test_meter_denies_beyond_execution_ceiling() -> None:
    meter = BudgetMeter(BudgetSpec(executions=1))
    assert meter.request_execution() is None
    denial = meter.request_execution()
    assert denial is not None and denial.kind == FAILURE_BUDGET_EXHAUSTED
    assert meter.usage().executions == 1


def test_meter_denies_when_wall_time_exhausted() -> None:
    meter = BudgetMeter(BudgetSpec(wall_time_s=0.0))
    denial = meter.request_execution()
    assert denial is not None and "wall-time" in denial.detail


def test_meter_caps_execution_timeout_to_remaining_wall() -> None:
    meter = BudgetMeter(BudgetSpec(wall_time_s=5.0))
    assert meter.execution_timeout_s(60.0) <= 5.0


def test_meter_denies_model_calls_beyond_ceiling() -> None:
    meter = BudgetMeter(BudgetSpec(model_calls=0))
    denial = meter.request_model_call()
    assert denial is not None and "model-call" in denial.detail


def test_cycle_with_execution_budget_one_rejects_candidate_as_data(tmp_path: Path) -> None:
    """One execution allowed: the baseline runs, the candidate validation is
    denied by the trusted meter and recorded as a rejection — no exception."""
    store = Store(tmp_path / "artifacts")
    config = LoopConfig(budget=BudgetSpec(executions=1))
    report = run_cycle(store, SUM_INTEGERS_TASK, config)

    assert report.diagnosis is not None  # baseline ran and was diagnosed
    assert report.candidate_evaluation is not None
    assert report.candidate_evaluation.failure is not None
    assert report.candidate_evaluation.failure.kind == FAILURE_BUDGET_EXHAUSTED
    assert report.decision is not None and not report.decision.accepted
    assert "budget" in report.decision.reason

    # the rejected candidate is still retained with its decision
    active = store.active_generation()
    assert active is not None and active.generation_id == report.generation_before


def test_cycle_with_zero_wall_budget_records_floor_evaluation(tmp_path: Path) -> None:
    store = Store(tmp_path / "artifacts")
    config = LoopConfig(budget=BudgetSpec(wall_time_s=0.0))
    report = run_cycle(store, SUM_INTEGERS_TASK, config)

    assert report.evaluation.failure is not None
    assert report.evaluation.failure.kind == FAILURE_BUDGET_EXHAUSTED
    assert report.evaluation.overall_score == 0.0
    assert report.diagnosis is None  # nothing passed, diagnosis abstains
    # the cycle was journaled with its usage despite total exhaustion
    assert store.cycles()[-1].usage.executions == 0
