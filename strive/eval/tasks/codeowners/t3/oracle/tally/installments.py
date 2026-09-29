"""Paying an invoice in installments."""

from __future__ import annotations

from tally import invoice
from tally._generated.records import Invoice
from tally.money import Money, allocate

__all__ = ["installment_plan"]


def installment_plan(inv: Invoice, country: str, n: int) -> list[Money]:
    """The total in `n` installments that add up to it exactly."""
    return allocate(invoice.total(inv, country), n)
