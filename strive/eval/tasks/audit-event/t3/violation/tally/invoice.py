"""Invoices: their lines, totals, discounts and late fees."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from tally import dates, tax
from tally._generated.records import Invoice, LineItem
from tally.errors import fail
from tally.money import Money, round_minor, zero

__all__ = [
    "LATE_FEE_RATE",
    "add_line",
    "apply_discount",
    "discount_line",
    "due",
    "format_number",
    "late_fee",
    "line_total",
    "subtotal",
    "total",
    "vat",
]

LATE_FEE_RATE = Decimal("0.0005")  # per day overdue, on the total


def add_line(inv: Invoice, description: str, quantity: int, unit_price: str, discount_pct: str = "0") -> LineItem:
    """Adds a line to `inv` and returns it."""
    line = LineItem(description, quantity, Decimal(unit_price), Decimal(discount_pct))
    inv.lines.append(line)
    return line


def apply_discount(m: Money, pct: Decimal) -> Money:
    """`m` less `pct` percent, rounded to the minor unit."""
    if not 0 <= pct <= 100:
        fail("INVOICE_BAD_DISCOUNT", pct=pct)
    return round_minor(m * (1 - pct / 100))


def line_total(line: LineItem, currency: str) -> Money:
    """A line's amount after its discount."""
    return apply_discount(Money(line.unit_price, currency) * line.quantity, line.discount_pct)


def subtotal(inv: Invoice) -> Money:
    """The sum of the lines, before VAT."""
    if not inv.lines:
        fail("INVOICE_NO_LINES", number=inv.number)
    result = zero(inv.currency)
    for line in inv.lines:
        result = result + line_total(line, inv.currency)
    return result


def vat(inv: Invoice, country: str) -> Money:
    """The VAT due on the invoice for a customer in `country`."""
    return tax.vat_amount(subtotal(inv), country)


def total(inv: Invoice, country: str) -> Money:
    """What the customer pays: subtotal plus VAT."""
    return subtotal(inv) + vat(inv, country)


def late_fee(inv: Invoice, country: str, days_late: int) -> Money:
    """The fee for paying `days_late` days after the due date."""
    if days_late <= 0:
        return zero(inv.currency)
    return round_minor(total(inv, country) * LATE_FEE_RATE * days_late)


def format_number(year: int, sequence: int) -> str:
    """An invoice number: the year and a zero-padded sequence.

    >>> format_number(2024, 17)
    'INV-2024-0017'
    >>> format_number(2025, 12345)
    'INV-2025-12345'
    """
    return f"INV-{year}-{sequence:04d}"


def due(inv: Invoice) -> date:
    """When `inv` is due."""
    return dates.due_date(inv.issued_on, inv.terms_days)


def discount_line(inv: Invoice, index: int, pct: str) -> None:
    """Sets the discount on the line at `index`, in percent."""
    inv.lines[index].discount_pct = Decimal(pct)
