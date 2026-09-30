"""Credit limits."""

from __future__ import annotations

from tally.money import Money

__all__ = ["over_limit"]


def over_limit(owed: Money, limit: Money) -> bool:
    """Whether `owed` is more than `limit`."""
    return (owed - limit).amount > 0
