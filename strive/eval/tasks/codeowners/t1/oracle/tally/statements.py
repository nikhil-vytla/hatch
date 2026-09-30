"""Monthly statements for customers."""

from __future__ import annotations

from tally import invoice
from tally._generated.records import Invoice
from tally.money import format_amount

__all__ = ["statement_line"]


def statement_line(inv: Invoice, country: str) -> str:
    """One invoice on a statement: number, issue date and total."""
    return f"{inv.number}  {inv.issued_on.isoformat()}  {format_amount(invoice.total(inv, country))}"
