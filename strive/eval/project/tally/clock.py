"""The one place tally reads the current time, so tests can freeze it."""

from __future__ import annotations

import datetime as _dt

__all__ = ["freeze", "now", "today", "unfreeze"]

_frozen: _dt.datetime | None = None


def now() -> _dt.datetime:
    """The current time, in UTC, or the frozen time."""
    if _frozen is not None:
        return _frozen
    return _dt.datetime.now(_dt.timezone.utc)


def today() -> _dt.date:
    """Today's date, in UTC, or the frozen date."""
    return now().date()


def freeze(at: _dt.datetime | _dt.date) -> None:
    """Stops the clock at `at` (a date means its midnight, UTC)."""
    global _frozen
    if not isinstance(at, _dt.datetime):
        at = _dt.datetime(at.year, at.month, at.day, tzinfo=_dt.timezone.utc)
    _frozen = at


def unfreeze() -> None:
    """Starts the clock again."""
    global _frozen
    _frozen = None
