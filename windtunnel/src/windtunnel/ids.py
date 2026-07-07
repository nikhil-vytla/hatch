"""Typed identifiers and the monotonic sequence counter.

The sequence counter is the final tie-breaker in the kernel's total order
(ADR-0003): every scheduled item and every event gets a unique, monotonically
increasing sequence number, so no two items ever compare equal.
"""

from __future__ import annotations

from typing import NewType

ActorId = NewType("ActorId", str)
EntityId = NewType("EntityId", str)
EventId = NewType("EventId", str)


class SeqCounter:
    """Monotonic counter. One per run; never shared across runs."""

    def __init__(self) -> None:
        self._next = 0

    def next(self) -> int:
        value = self._next
        self._next += 1
        return value
