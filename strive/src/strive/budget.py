"""Trusted budget accounting and enforcement.

The meter lives in the kernel; nothing evolvable ever reports its own usage
(D3). Exhaustion is failure-as-data: callers receive a ``FailureRecord`` to
record, not an exception that escapes the loop.
"""

from __future__ import annotations

import time

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    BudgetSpec,
    BudgetUsage,
    FailureRecord,
)


class BudgetMeter:
    """Tracks and enforces one cycle's resource spend, kernel-side."""

    def __init__(self, spec: BudgetSpec) -> None:
        self.spec = spec
        self._started = time.monotonic()
        self._executions = 0
        self._model_calls = 0
        self._tokens = 0
        self._output_bytes = 0
        self._cost = 0.0
        self._recursion_depth = 0

    # -- accounting -----------------------------------------------------------

    def elapsed_wall_s(self) -> float:
        return time.monotonic() - self._started

    def remaining_wall_s(self) -> float:
        return self.spec.wall_time_s - self.elapsed_wall_s()

    def usage(self) -> BudgetUsage:
        return BudgetUsage(
            wall_time_s=round(self.elapsed_wall_s(), 6),
            executions=self._executions,
            model_calls=self._model_calls,
            tokens=self._tokens,
            output_bytes=self._output_bytes,
            cost=self._cost,
            recursion_depth=self._recursion_depth,
        )

    # -- enforcement (returns FailureRecord instead of raising) -----------------

    def request_execution(self) -> FailureRecord | None:
        """Charge one sandbox execution; refuse if a ceiling is already hit."""
        if self._executions + 1 > self.spec.executions:
            return FailureRecord(
                kind=FAILURE_BUDGET_EXHAUSTED,
                detail=f"execution budget exhausted ({self.spec.executions} allowed)",
            )
        if self.remaining_wall_s() <= 0:
            return FailureRecord(
                kind=FAILURE_BUDGET_EXHAUSTED,
                detail=f"wall-time budget exhausted ({self.spec.wall_time_s}s allowed)",
            )
        self._executions += 1
        return None

    def execution_timeout_s(self, configured: float) -> float:
        """The hard timeout for the next execution: config capped by remaining wall."""
        return max(0.01, min(configured, self.remaining_wall_s()))

    def note_output_bytes(self, count: int) -> None:
        self._output_bytes += count

    def request_model_call(self) -> FailureRecord | None:
        if self._model_calls + 1 > self.spec.model_calls:
            return FailureRecord(
                kind=FAILURE_BUDGET_EXHAUSTED,
                detail=f"model-call budget exhausted ({self.spec.model_calls} allowed)",
            )
        self._model_calls += 1
        return None

    def note_model_usage(self, tokens: int, cost: float) -> None:
        self._tokens += tokens
        self._cost += cost

    def enter_recursion(self, depth: int) -> FailureRecord | None:
        if depth > self.spec.max_recursion_depth:
            return FailureRecord(
                kind=FAILURE_BUDGET_EXHAUSTED,
                detail=f"recursion depth {depth} exceeds cap {self.spec.max_recursion_depth}",
            )
        self._recursion_depth = max(self._recursion_depth, depth)
        return None
