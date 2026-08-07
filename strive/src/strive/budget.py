"""Trusted budget accounting and enforcement.

The meter lives in the kernel; nothing evolvable ever reports its own usage
(D3). Exhaustion is failure-as-data: callers receive a ``FailureRecord`` to
record, not an exception that escapes the loop.

Limit semantics (uniform, tested):
- a limit of ``UNLIMITED`` (-1) means *accounting only* — usage is tracked
  but never enforced;
- a limit of ``0`` means *nothing allowed* — the first request is denied;
- otherwise a request is denied once accumulated usage has reached the limit.

Enforced limits: wall time (pre-request gate + per-execution timeout cap +
model-call HTTP timeout cap), executions, model calls, tokens, cost, and
cumulative output bytes (which also bounds each execution's stdout to the
remaining allowance). ``max_recursion_depth`` is enforced at delegation time;
no recursive delegation exists yet, so today it is exercised only by unit
tests.
"""

from __future__ import annotations

import time

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    BudgetSpec,
    BudgetUsage,
    FailureRecord,
)

UNLIMITED = -1


def _limited(limit: float | int) -> bool:
    return limit != UNLIMITED


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
        if not _limited(self.spec.wall_time_s):
            return float("inf")
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

    def _exhausted(self, what: str, detail: str) -> FailureRecord:
        return FailureRecord(
            kind=FAILURE_BUDGET_EXHAUSTED, detail=f"{what} budget exhausted ({detail})"
        )

    # -- enforcement (returns FailureRecord instead of raising) -----------------

    def request_execution(self) -> FailureRecord | None:
        """Charge one sandbox execution; refuse if any relevant ceiling is hit."""
        if _limited(self.spec.executions) and self._executions >= self.spec.executions:
            return self._exhausted("execution", f"{self.spec.executions} allowed")
        if self.remaining_wall_s() <= 0:
            return self._exhausted("wall-time", f"{self.spec.wall_time_s}s allowed")
        if (
            _limited(self.spec.output_bytes)
            and self._output_bytes >= self.spec.output_bytes
        ):
            return self._exhausted(
                "output", f"{self.spec.output_bytes} cumulative bytes allowed"
            )
        self._executions += 1
        return None

    def execution_timeout_s(self, configured: float) -> float:
        """The hard timeout for the next execution: config capped by remaining wall."""
        return max(0.01, min(configured, self.remaining_wall_s()))

    def execution_output_cap(self, default_cap: int = 1_000_000) -> int:
        """Per-execution stdout bound: the remaining cumulative output allowance
        (or the default when output is accounting-only)."""
        if not _limited(self.spec.output_bytes):
            return default_cap
        return max(1, self.spec.output_bytes - self._output_bytes)

    def note_output_bytes(self, count: int) -> None:
        self._output_bytes += count

    def request_model_call(self) -> FailureRecord | None:
        if _limited(self.spec.model_calls) and self._model_calls >= self.spec.model_calls:
            return self._exhausted("model-call", f"{self.spec.model_calls} allowed")
        if self.remaining_wall_s() <= 0:
            return self._exhausted("wall-time", f"{self.spec.wall_time_s}s allowed")
        if _limited(self.spec.tokens) and self._tokens >= self.spec.tokens:
            return self._exhausted("token", f"{self.spec.tokens} allowed")
        if _limited(self.spec.cost) and self._cost >= self.spec.cost:
            return self._exhausted("cost", f"{self.spec.cost} allowed")
        self._model_calls += 1
        return None

    def model_call_timeout_s(self, configured: float) -> float:
        """HTTP timeout for the next model call: capped by remaining wall time."""
        return max(0.01, min(configured, self.remaining_wall_s()))

    def note_model_usage(self, tokens: int, cost: float) -> None:
        self._tokens += tokens
        self._cost += cost

    def enter_recursion(self, depth: int) -> FailureRecord | None:
        if _limited(self.spec.max_recursion_depth) and depth > self.spec.max_recursion_depth:
            return self._exhausted(
                "recursion", f"depth {depth} exceeds cap {self.spec.max_recursion_depth}"
            )
        self._recursion_depth = max(self._recursion_depth, depth)
        return None
