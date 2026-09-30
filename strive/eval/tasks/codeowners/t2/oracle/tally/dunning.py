"""Dunning: how firmly to chase a late invoice."""

from __future__ import annotations

__all__ = ["dunning_level"]


def dunning_level(days_late: int) -> int:
    """0 when not late, then 1 up to 14 days, 2 up to 30, 3 after."""
    if days_late <= 0:
        return 0
    if days_late <= 14:
        return 1
    return 2 if days_late <= 30 else 3
