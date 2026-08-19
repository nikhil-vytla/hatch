"""Trusted budget enforcement: every enforced limit is tested; zero-limit
semantics are defined (0 = nothing allowed, -1 = accounting only)."""


from strive.budget import UNLIMITED, BudgetMeter
from strive.contracts import FAILURE_BUDGET_EXHAUSTED, BudgetSpec


def test_meter_denies_beyond_execution_ceiling() -> None:
    meter = BudgetMeter(BudgetSpec(executions=1))
    assert meter.request_execution() is None
    denial = meter.request_execution()
    assert denial is not None and denial.kind == FAILURE_BUDGET_EXHAUSTED
    assert meter.usage().executions == 1


def test_zero_limit_means_nothing_allowed() -> None:
    assert BudgetMeter(BudgetSpec(executions=0)).request_execution() is not None
    assert BudgetMeter(BudgetSpec(model_calls=0)).request_model_call() is not None
    denial = BudgetMeter(BudgetSpec(model_calls=4, tokens=0)).request_model_call()
    assert denial is not None and "token" in denial.detail
    denial = BudgetMeter(BudgetSpec(model_calls=4, cost=0.0)).request_model_call()
    assert denial is not None and "cost" in denial.detail


def test_unlimited_means_accounting_only() -> None:
    meter = BudgetMeter(BudgetSpec(model_calls=UNLIMITED, tokens=UNLIMITED, cost=UNLIMITED))
    for _ in range(5):
        assert meter.request_model_call() is None
    meter.note_model_usage(tokens=10_000, cost=99.0)
    assert meter.request_model_call() is None  # tracked, never enforced
    assert meter.usage().tokens == 10_000 and meter.usage().cost == 99.0


def test_token_ceiling_enforced_across_calls() -> None:
    meter = BudgetMeter(BudgetSpec(model_calls=10, tokens=100))
    assert meter.request_model_call() is None
    meter.note_model_usage(tokens=100, cost=0.0)
    denial = meter.request_model_call()
    assert denial is not None and "token budget exhausted" in denial.detail


def test_cost_ceiling_enforced_across_calls() -> None:
    meter = BudgetMeter(BudgetSpec(model_calls=10, cost=1.0))
    assert meter.request_model_call() is None
    meter.note_model_usage(tokens=1, cost=1.5)
    denial = meter.request_model_call()
    assert denial is not None and "cost budget exhausted" in denial.detail


def test_cumulative_output_ceiling_enforced() -> None:
    meter = BudgetMeter(BudgetSpec(output_bytes=100))
    assert meter.request_execution() is None
    assert meter.execution_output_cap() == 100
    meter.note_output_bytes(100)
    denial = meter.request_execution()
    assert denial is not None and "output budget exhausted" in denial.detail


def test_per_execution_output_cap_is_remaining_allowance() -> None:
    meter = BudgetMeter(BudgetSpec(output_bytes=100))
    meter.note_output_bytes(60)
    assert meter.execution_output_cap() == 40
    unlimited = BudgetMeter(BudgetSpec(output_bytes=UNLIMITED))
    assert unlimited.execution_output_cap() == 1_000_000  # safety default


def test_meter_denies_when_wall_time_exhausted() -> None:
    meter = BudgetMeter(BudgetSpec(wall_time_s=0.0))
    denial = meter.request_execution()
    assert denial is not None and "wall-time" in denial.detail
    assert meter.request_model_call() is not None  # wall gates model calls too


def test_meter_caps_execution_and_model_timeouts_to_remaining_wall() -> None:
    meter = BudgetMeter(BudgetSpec(wall_time_s=5.0))
    assert meter.execution_timeout_s(60.0) <= 5.0
    assert meter.model_call_timeout_s(600.0) <= 5.0


def test_recursion_depth_zero_denies_any_delegation() -> None:
    meter = BudgetMeter(BudgetSpec(max_recursion_depth=0))
    assert meter.enter_recursion(1) is not None
    assert meter.enter_recursion(0) is None


# -- durable/cumulative semantics (final semantic-atomicity pass) -----------------------------------


def test_output_cap_is_cumulative_across_cases() -> None:
    """The per-execution output cap is the REMAINING cumulative allowance, so
    successive cases cannot each spend the full cap independently."""
    meter = BudgetMeter(BudgetSpec(executions=UNLIMITED, output_bytes=100))
    assert meter.execution_output_cap() == 100
    meter.note_output_bytes(40)
    assert meter.execution_output_cap() == 60  # decremented cumulatively
    meter.note_output_bytes(60)
    assert meter.execution_output_cap() == 1  # floored, never negative
    # cumulative output at/over the ceiling denies the next execution
    denial = meter.request_execution()
    assert denial is not None and "output" in denial.detail


def test_durable_wall_is_cumulative_across_restarts() -> None:
    """Absorbing prior usage resumes wall time as cumulative ACTIVE time, so a
    run cannot buy unbounded wall by restarting."""
    from strive.contracts import BudgetUsage

    meter = BudgetMeter(BudgetSpec(wall_time_s=10.0, executions=UNLIMITED))
    assert meter.remaining_wall_s() > 9.0
    meter.absorb(BudgetUsage(wall_time_s=10.05))  # prior process's active time
    assert meter.remaining_wall_s() < 0.1
    # wall is exhausted: the next execution is denied on wall-time
    denial = meter.request_execution()
    assert denial is not None and "wall" in denial.detail
