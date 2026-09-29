"""Rows for the data warehouse's nightly load.

The warehouse's column names are these keys, so they are snake_case.
"""

from __future__ import annotations

from tally import clock, invoice
from tally._generated.records import Customer, Invoice, Payment

__all__ = ["customer_row", "export_filename", "invoice_row", "payment_row"]


def invoice_row(inv: Invoice, country: str) -> dict:
    """One invoice, as the warehouse's invoices table takes it."""
    return {
        "invoice_number": inv.number,
        "customer_id": inv.customer_id,
        "currency": inv.currency,
        "issued_on": inv.issued_on.isoformat(),
        "line_count": len(inv.lines),
        "subtotal": str(invoice.subtotal(inv).amount),
        "total": str(invoice.total(inv, country).amount),
    }


def customer_row(c: Customer) -> dict:
    """One customer, as the warehouse's customers table takes it."""
    return {
        "customer_id": c.id,
        "name": c.name,
        "email": c.email,
        "country": c.country,
        "vat_id": c.vat_id,
    }


def payment_row(p: Payment) -> dict:
    """One payment, as the warehouse's payments table takes it."""
    return {
        "payment_reference": p.reference,
        "invoice_number": p.invoice_number,
        "amount": str(p.amount),
        "currency": p.currency,
        "received_on": p.received_on.isoformat(),
    }


def export_filename(table: str) -> str:
    """Today's file for `table`."""
    return f"{table}-{clock.today():%Y%m%d}.csv"
