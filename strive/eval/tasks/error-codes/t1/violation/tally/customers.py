"""Customers: creating them, and their names and addresses as documents show them."""

from __future__ import annotations

import re

from tally._generated.records import Customer
from tally.errors import fail

__all__ = ["display_name", "make_customer", "normalize_email"]

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")


def normalize_email(email: str) -> str:
    """An email address as tally stores it: trimmed, and the domain lowercased.
    The local part keeps its case: some mail servers treat it as significant.

    >>> normalize_email('  Ada.Lovelace@Example.COM ')
    'Ada.Lovelace@example.com'
    >>> normalize_email('billing@ACME.io')
    'billing@acme.io'
    """
    local, _, domain = email.strip().rpartition("@")
    return f"{local}@{domain.lower()}"


def make_customer(id: str, name: str, email: str, country: str, vat_id: str | None = None) -> Customer:
    """A new customer, its email checked and normalized."""
    address = normalize_email(email)
    if not _EMAIL.match(address):
        fail("CUSTOMER_BAD_EMAIL", email=email)
    if not re.fullmatch(r"[A-Z]{2}", country):
        raise ValueError(f"not a two-letter country code: {country}")
    return Customer(id=id, name=name.strip(), email=address, country=country, vat_id=vat_id)


def display_name(c: Customer) -> str:
    """How documents name the customer: the name, and the VAT ID if there is one."""
    return f"{c.name} (VAT {c.vat_id})" if c.vat_id else c.name
