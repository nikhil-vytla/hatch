"""Currency conversion at the day's reference rates.

Rates come from a CSV file (date,base,quote,rate), one row per currency pair
per day; the path is in TALLY_FX_RATES. A rate applies from its date until
the next one for that pair.
"""

from __future__ import annotations

import csv
import datetime as _dt
import os
from decimal import Decimal
from functools import cache
from pathlib import Path

from tally.errors import fail
from tally.money import Money, round_minor

__all__ = ["Rates", "convert", "cross_rate", "load_rates", "rates"]


class Rates:
    """Reference rates by pair, each a list of (date, rate) in date order."""

    def __init__(self, table: dict[tuple[str, str], list[tuple[_dt.date, Decimal]]]) -> None:
        self.table = table

    def on(self, base: str, quote: str, day: _dt.date) -> Decimal:
        """The base->quote rate in force on `day`."""
        if base == quote:
            return Decimal(1)
        direct = self._latest(base, quote, day)
        if direct is not None:
            return direct
        inverse = self._latest(quote, base, day)
        if inverse is not None:
            return 1 / inverse
        fail("FX_NO_RATE", base=base, quote=quote, on=day.isoformat())

    def _latest(self, base: str, quote: str, day: _dt.date) -> Decimal | None:
        found = None
        for d, r in self.table.get((base, quote), []):
            if d > day:
                break
            found = r
        return found


def load_rates(path: str | Path) -> Rates:
    """Reads a rates file. Blank lines and lines starting with # are skipped."""
    table: dict[tuple[str, str], list[tuple[_dt.date, Decimal]]] = {}
    with open(path, newline="") as f:
        rows = [line for line in f if line.strip() and not line.startswith("#")]
    for row in csv.DictReader(rows):
        pair = (row["base"], row["quote"])
        table.setdefault(pair, []).append((_dt.date.fromisoformat(row["date"]), Decimal(row["rate"])))
    for entries in table.values():
        entries.sort()
    return Rates(table)


@cache
def rates() -> Rates:
    """The rates from the file TALLY_FX_RATES names."""
    path = os.environ.get("TALLY_FX_RATES")
    if not path:
        fail("FX_RATES_UNSET")
    return load_rates(path)


def cross_rate(base: str, quote: str, via: str, day: _dt.date, table: Rates | None = None) -> Decimal:
    """base->quote through a third currency, for pairs with no direct rate."""
    t = table or rates()
    return t.on(via, base, day) * t.on(via, quote, day)


def convert(m: Money, to: str, day: _dt.date, table: Rates | None = None) -> Money:
    """`m` in currency `to`, at the rate in force on `day`, rounded to `to`'s minor unit."""
    t = table or rates()
    return round_minor(Money(m.amount * t.on(m.currency, to, day), to))
