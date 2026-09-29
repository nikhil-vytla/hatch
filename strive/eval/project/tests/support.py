"""Helpers for tally's tests."""

from __future__ import annotations

from decimal import Decimal

from tally.money import Money

__all__ = ["assert_money", "sample_customer", "sample_invoice"]


def assert_money(actual: object, expected: str) -> None:
    """Fails unless `actual` is Money equal to `expected`, written as
    '<amount> <CURRENCY>' ('12.30 EUR'). The amount's precision counts:
    '12.3 EUR' doesn't match Money('12.30', 'EUR')."""
    if not isinstance(actual, Money):
        raise AssertionError(f"expected Money {expected}, got {type(actual).__name__} {actual!r}")
    amount, _, currency = expected.partition(" ")
    if actual.currency != currency or str(actual.amount) != str(Decimal(amount)):
        raise AssertionError(f"expected {expected}, got {actual.amount} {actual.currency}")


def sample_customer(country: str = "DE"):
    from tally.customers import make_customer

    return make_customer("C-100", "Müller & Söhne GmbH", "ap@mueller-soehne.de", country, "DE811907980")


def sample_invoice(currency: str = "EUR"):
    import datetime

    from tally._generated.records import Invoice
    from tally.invoice import add_line

    inv = Invoice("INV-2024-0017", "C-100", currency, datetime.date(2024, 3, 1), 30)
    add_line(inv, "Consulting, March", 10, "95.00")
    add_line(inv, "Hosting", 1, "40.00", "25")
    return inv
