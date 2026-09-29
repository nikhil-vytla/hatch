"""Amounts of money in one currency, kept exact."""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from tally.errors import fail

__all__ = ["MINOR_UNITS", "Money", "SYMBOLS", "allocate", "format_amount", "parse_amount", "round_minor", "zero"]

MINOR_UNITS = {"BHD": 3, "CHF": 2, "EUR": 2, "GBP": 2, "JPY": 0, "SEK": 2, "USD": 2}
SYMBOLS = {"EUR": "€", "GBP": "£", "JPY": "¥", "USD": "$"}


class Money:
    """An exact amount in one currency.

    Money has no ``==`` on purpose: '1.5 EUR' and '1.50 EUR' differ only in
    precision, and a bare comparison hides whether a test meant to check the
    precision or the currency. Code compares with ``same_as``.
    """

    __slots__ = ("amount", "currency")

    def __init__(self, amount: Decimal | str | int, currency: str) -> None:
        if currency not in MINOR_UNITS:
            fail("MONEY_UNKNOWN_CURRENCY", currency=currency)
        try:
            self.amount = Decimal(amount)
        except InvalidOperation:
            fail("MONEY_BAD_AMOUNT", text=amount)
        self.currency = currency

    def __repr__(self) -> str:
        return f"Money('{self.amount}', '{self.currency}')"

    def __str__(self) -> str:
        return f"{self.amount} {self.currency}"

    def __eq__(self, other: object) -> bool:
        raise TypeError("Money objects can't be compared with ==; see tests/README.md")

    __hash__ = None  # type: ignore[assignment]

    def same_as(self, other: Money) -> bool:
        """Same currency and same amount, ignoring trailing zeros."""
        return self.currency == other.currency and self.amount == other.amount

    def _check(self, other: Money) -> None:
        if other.currency != self.currency:
            fail("MONEY_CURRENCY_MISMATCH", left=self.currency, right=other.currency)

    def __add__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._check(other)
        return Money(self.amount - other.amount, self.currency)

    def __mul__(self, factor: Decimal | int) -> Money:
        return Money(self.amount * Decimal(factor), self.currency)

    __rmul__ = __mul__

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def is_zero(self) -> bool:
        return self.amount == 0

    def is_negative(self) -> bool:
        return self.amount < 0


def zero(currency: str) -> Money:
    """Nothing, in `currency`."""
    return Money(0, currency)


def round_minor(m: Money) -> Money:
    """Rounds to the currency's minor unit, half to even (banker's rounding).

    >>> round_minor(Money('2.345', 'EUR'))
    Money('2.34', 'EUR')
    >>> round_minor(Money('1234.5', 'JPY'))
    Money('1234', 'JPY')
    """
    step = Decimal(1).scaleb(-MINOR_UNITS[m.currency])
    return Money(m.amount.quantize(step, rounding=ROUND_HALF_EVEN), m.currency)


def parse_amount(text: str, currency: str) -> Money:
    """Parses an amount as people write it: thousands separators, and
    parentheses for a negative amount, as accountants do.

    >>> parse_amount('1,234.50', 'EUR')
    Money('1234.50', 'EUR')
    >>> parse_amount('(12.00)', 'USD')
    Money('-12.00', 'USD')
    """
    t = text.strip().replace(",", "")
    negative = t.startswith("(") and t.endswith(")")
    if negative:
        t = t[1:-1]
    try:
        value = Decimal(t)
    except InvalidOperation:
        fail("MONEY_BAD_AMOUNT", text=text)
    return Money(-value if negative else value, currency)


def format_amount(m: Money) -> str:
    """The amount as an invoice shows it: symbol, thousands separators and
    exactly the currency's minor digits.

    >>> format_amount(Money('1234.5', 'EUR'))
    '€1,234.50'
    >>> format_amount(Money('-12', 'USD'))
    '-$12.00'
    >>> format_amount(Money('950', 'CHF'))
    '950.00 CHF'
    >>> format_amount(Money('1500', 'JPY'))
    '¥1,500'
    """
    r = round_minor(m)
    digits = MINOR_UNITS[m.currency]
    body = f"{abs(r.amount):,.{digits}f}"
    sign = "-" if r.amount < 0 else ""
    symbol = SYMBOLS.get(m.currency)
    return f"{sign}{symbol}{body}" if symbol else f"{sign}{body} {m.currency}"


def allocate(m: Money, parts: int) -> list[Money]:
    """Splits `m` into `parts` amounts that add up to it exactly, the
    leftover minor units going to the first parts."""
    unit = Decimal(1).scaleb(-MINOR_UNITS[m.currency])
    total_units = int((round_minor(m).amount / unit).to_integral_value())
    base, extra = divmod(total_units, parts)
    return [Money((base + (1 if i < extra else 0)) * unit, m.currency) for i in range(parts)]
