"""Discrete-event virtual time (ADR-0003).

The scheduler holds pending items in a heap keyed by (time, priority, seq) —
a total order, so simultaneity resolves deterministically. The clock only ever
jumps forward to the next item; simulating thirty quiet days costs nothing.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from orrery.events import ScheduledIntent
from orrery.ids import SeqCounter


@dataclass(frozen=True)
class Activation:
    """A request to wake an actor and ask its policy for a decision."""

    actor_id: str
    reason: str = "scheduled"


WorkItem = Activation | ScheduledIntent


@dataclass(order=True)
class _HeapEntry:
    time: float
    priority: int
    seq: int
    item: WorkItem = field(compare=False)


class Scheduler:
    def __init__(self, seq: SeqCounter) -> None:
        self._heap: list[_HeapEntry] = []
        self._seq = seq
        self.now: float = 0.0

    def schedule(self, item: WorkItem, at_time: float, priority: int = 0) -> None:
        if at_time < self.now:
            raise ValueError(f"cannot schedule into the past: {at_time} < {self.now}")
        heapq.heappush(self._heap, _HeapEntry(at_time, priority, self._seq.next(), item))

    def pop(self) -> tuple[float, WorkItem] | None:
        """Advance the clock to the next item and return it, or None if drained."""
        if not self._heap:
            return None
        entry = heapq.heappop(self._heap)
        self.now = entry.time
        return entry.time, entry.item

    def __len__(self) -> int:
        return len(self._heap)
