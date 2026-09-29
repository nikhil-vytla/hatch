"""Payments against invoices, and what is still due."""

from __future__ import annotations

from decimal import Decimal

from tally import invoice
from tally._generated.records import Invoice, Payment
from tally.errors import fail
from tally.money import Money, zero

__all__ = ["balance_due", "overpaid_by", "paid", "record_payment"]


def paid(inv: Invoice, payments: list[Payment]) -> Money:
    """What has been paid against `inv` so far."""
    result = zero(inv.currency)
    for p in payments:
        if p.invoice_number == inv.number:
            result = result + Money(p.amount, p.currency)
    return result


def balance_due(inv: Invoice, country: str, payments: list[Payment]) -> Money:
    """What the customer still owes on `inv`."""
    return invoice.total(inv, country) - paid(inv, payments)


def record_payment(inv: Invoice, country: str, payments: list[Payment], payment: Payment) -> list[Payment]:
    """The payments with `payment` added, refusing one larger than what is due."""
    due = balance_due(inv, country, payments)
    if Decimal(payment.amount) > due.amount:
        fail("PAYMENT_OVERPAID", amount=payment.amount, due=due, invoice=inv.number)
    return [*payments, payment]


def overpaid_by(inv: Invoice, country: str, payments: list[Payment]) -> Money:
    """How much more than the total has been paid on `inv`; zero if not overpaid."""
    extra = paid(inv, payments) - invoice.total(inv, country)
    return (extra if extra.amount > 0 else zero(inv.currency)) + Money("0.01", inv.currency)
