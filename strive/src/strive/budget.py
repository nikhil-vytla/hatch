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
        self._absorbed_wall = 0.0  # durable active time from prior processes
        self._executions = 0
        self._model_calls = 0
        self._tokens = 0
        self._output_bytes = 0
        self._cost = 0.0
        self._recursion_depth = 0

    # -- accounting -----------------------------------------------------------

    def elapsed_wall_s(self) -> float:
        # DURABLE wall: cumulative active time across restarts (absorbed from
        # durable usage) plus this process's own elapsed time.
        return self._absorbed_wall + (time.monotonic() - self._started)

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

    def absorb(self, usage: BudgetUsage) -> None:
        """Seed cumulative spend from durably-recorded prior usage, so a
        resumed run cannot reset or expand its budget. Wall time IS resumed as
        cumulative active time (durable wall semantics), so a run cannot buy
        unbounded wall by repeatedly restarting."""
        self._absorbed_wall += usage.wall_time_s
        self._executions += usage.executions
        self._model_calls += usage.model_calls
        self._tokens += usage.tokens
        self._output_bytes += usage.output_bytes
        self._cost += usage.cost
        self._recursion_depth = max(self._recursion_depth, usage.recursion_depth)

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

    def semantics(self) -> dict[str, str]:
        """How each limit behaves in this cycle, recorded for the journal.

        "enforced" = trusted code denies requests at/over the limit;
        "accounting-only" = tracked, never enforced (UNLIMITED). Tokens are
        "enforced-between-calls+output-cap": accumulated usage gates the next
        call and requested output tokens are capped to the remaining
        allowance, but a single call's *input* tokens can overshoot (an
        overrun is then rejected and journaled before its completion is
        used). Cost enforcement additionally requires an adapter that reports
        trustworthy cost; the metered adapter fails closed otherwise.
        """

        def basic(limit: float | int) -> str:
            return "enforced" if _limited(limit) else "accounting-only"

        return {
            "wall_time_s": basic(self.spec.wall_time_s),
            "executions": basic(self.spec.executions),
            "model_calls": basic(self.spec.model_calls),
            "tokens": (
                "enforced-between-calls+output-cap"
                if _limited(self.spec.tokens)
                else "accounting-only"
            ),
            "output_bytes": basic(self.spec.output_bytes),
            "cost": (
                "enforced-if-adapter-reports-cost"
                if _limited(self.spec.cost)
                else "accounting-only"
            ),
            "recursion_depth": basic(self.spec.max_recursion_depth),
        }

    def cap_output_tokens(self, requested: int) -> int:
        """Cap requested completion tokens to the remaining token allowance."""
        if not _limited(self.spec.tokens):
            return requested
        remaining = self.spec.tokens - self._tokens
        return max(1, min(requested, remaining))

    def tokens_overrun(self) -> FailureRecord | None:
        """Post-call check: did accumulated tokens exceed the hard limit?"""
        if _limited(self.spec.tokens) and self._tokens > self.spec.tokens:
            return self._exhausted(
                "token",
                f"{self.spec.tokens} allowed, {self._tokens} consumed — the "
                "overrunning call's completion is rejected",
            )
        return None

    def cost_overrun(self) -> FailureRecord | None:
        """Post-call check: did accumulated (adapter-reported) cost exceed the
        hard limit? Reaching the limit exactly is allowed; the *next* call is
        then denied pre-call. The overrunning spend stays accounted."""
        if _limited(self.spec.cost) and self._cost > self.spec.cost:
            return self._exhausted(
                "cost",
                f"{self.spec.cost} allowed, {self._cost} spent — the "
                "overrunning call's completion is rejected",
            )
        return None

    def would_exceed_tokens(self, reserved_tokens: int) -> FailureRecord | None:
        """CONSERVATIVE preflight: would committing ``reserved_tokens`` (a
        call's estimated input + capped output) push cumulative tokens past the
        hard limit? Denies BEFORE dispatch so nothing is spent — distinct from
        the post-call ``tokens_overrun`` check."""
        if not _limited(self.spec.tokens):
            return None
        projected = self._tokens + reserved_tokens
        if projected > self.spec.tokens:
            return self._exhausted(
                "token",
                f"{self.spec.tokens} allowed, {self._tokens} consumed + "
                f"{reserved_tokens} reserved would reach {projected} — call denied",
            )
        return None

    def would_exceed_cost(self, reserved_cost: float) -> FailureRecord | None:
        """CONSERVATIVE preflight: would committing ``reserved_cost`` push
        cumulative cost past the hard limit? Denies BEFORE dispatch."""
        if not _limited(self.spec.cost):
            return None
        projected = self._cost + reserved_cost
        if projected > self.spec.cost:
            return self._exhausted(
                "cost",
                f"{self.spec.cost} allowed, {self._cost} spent + "
                f"{reserved_cost} reserved would reach {projected} — call denied",
            )
        return None

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
