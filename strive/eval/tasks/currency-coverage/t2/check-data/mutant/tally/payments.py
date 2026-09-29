"""Payments against invoices, and what is still due."""

from __future__ import annotations

from decimal import Decimal

from tally import invoice
from tally._generated.records import Invoice, Payment
from tally.errors import fail
from tally.money import Money, round_minor, zero

__all__ = ["balance_due", "early_payment_discount", "paid", "record_payment"]


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


def early_payment_discount(inv: Invoice, country: str, pct: str) -> Money:
    """What paying early saves: `pct` percent of the total, rounded to the minor unit."""
    return Money((invoice.total(inv, country) * (Decimal(pct) / 100)).amount.quantize(Decimal("0.01")), inv.currency)
