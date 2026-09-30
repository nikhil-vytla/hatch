"""The audit trail: what changed, on which invoice, and when."""

from __future__ import annotations

from tally import clock

__all__ = ["clear", "events", "record"]

_events: list[dict] = []


def record(event: str, **fields: object) -> None:
    """Appends `event` to the trail, with `fields` and the time."""
    _events.append({"event": event, "at": clock.now().isoformat(), **fields})


def events() -> list[dict]:
    """The trail so far, oldest first."""
    return list(_events)


def clear() -> None:
    """Empties the trail."""
    _events.clear()
