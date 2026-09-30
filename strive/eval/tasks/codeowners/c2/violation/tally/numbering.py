"""Invoice numbers in sequence."""

from __future__ import annotations

__all__ = ["next_number"]


def next_number(last: str) -> str:
    """The number after `last` in the same year."""
    prefix, year, sequence = last.split("-")
    return f"{prefix}-{year}-{int(sequence) + 1:04d}"
