"""Calendar arithmetic for invoices: terms, months and quarters."""

from __future__ import annotations

import calendar
import datetime as _dt

from tally.errors import fail

__all__ = ["add_months", "due_date", "quarter_of", "quarter_start"]


def add_months(d: _dt.date, months: int) -> _dt.date:
    """The same day `months` later, clamped to the end of a shorter month.

    >>> add_months(_dt.date(2024, 1, 31), 1)
    datetime.date(2024, 2, 29)
    >>> add_months(_dt.date(2023, 11, 15), 3)
    datetime.date(2024, 2, 15)
    >>> add_months(_dt.date(2024, 3, 31), -1)
    datetime.date(2024, 2, 29)
    """
    index = d.year * 12 + (d.month - 1) + months
    year, month = divmod(index, 12)
    last = calendar.monthrange(year, month + 1)[1]
    return _dt.date(year, month + 1, d.day)


def due_date(issued: _dt.date, terms_days: int) -> _dt.date:
    """When an invoice issued on `issued` with `terms_days` terms is due."""
    if not 0 <= terms_days <= 365:
        fail("DATES_BAD_TERMS", days=terms_days)
    return issued + _dt.timedelta(days=terms_days)


def quarter_of(d: _dt.date) -> str:
    """The quarter a date falls in, as reports label it.

    >>> quarter_of(_dt.date(2024, 2, 29))
    '2024-Q1'
    >>> quarter_of(_dt.date(2024, 10, 1))
    '2024-Q4'
    """
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def quarter_start(d: _dt.date) -> _dt.date:
    """The first day of the quarter `d` falls in."""
    return _dt.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)
