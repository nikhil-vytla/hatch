"""JSON for the web app's API.

The web app's TypeScript reads these objects directly, so keys are camelCase.
"""

from __future__ import annotations

from tally import invoice
from tally._generated.records import Customer, Invoice, Payment
from tally.money import format_amount

__all__ = ["customer_json", "invoice_json", "payment_json"]


def invoice_json(inv: Invoice, country: str) -> dict:
    """An invoice for the invoice page."""
    return {
        "invoiceNumber": inv.number,
        "customerId": inv.customer_id,
        "currency": inv.currency,
        "issuedOn": inv.issued_on.isoformat(),
        "dueOn": invoice.due(inv).isoformat(),
        "lineCount": len(inv.lines),
        "totalFormatted": format_amount(invoice.total(inv, country)),
    }


def customer_json(c: Customer) -> dict:
    """A customer for the customer page."""
    return {
        "customerId": c.id,
        "name": c.name,
        "email": c.email,
        "country": c.country,
        "vatId": c.vat_id,
    }


def payment_json(p: Payment) -> dict:
    """A payment for an invoice's payment history."""
    return {
        "paymentReference": p.reference,
        "invoiceNumber": p.invoice_number,
        "amount": str(p.amount),
        "currency": p.currency,
        "receivedOn": p.received_on.isoformat(),
    }
