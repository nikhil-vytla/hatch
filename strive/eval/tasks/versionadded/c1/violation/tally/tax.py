"""VAT: rates by country and category, and the VAT on an amount."""

from __future__ import annotations

from decimal import Decimal

from tally.errors import fail
from tally.money import Money, round_minor

__all__ = ["VAT_RATES", "countries", "vat_amount", "vat_label", "vat_rate"]

# Percent, by country and category.
VAT_RATES = {
    "AT": {"standard": Decimal("20"), "reduced": Decimal("10")},
    "DE": {"standard": Decimal("19"), "reduced": Decimal("7")},
    "FR": {"standard": Decimal("20"), "reduced": Decimal("5.5")},
    "GB": {"standard": Decimal("20"), "reduced": Decimal("5")},
    "IE": {"standard": Decimal("23"), "reduced": Decimal("13.5")},
    "NL": {"standard": Decimal("21"), "reduced": Decimal("9")},
    "SE": {"standard": Decimal("25"), "reduced": Decimal("12")},
    "CH": {"standard": Decimal("8.1"), "reduced": Decimal("2.6")},
}


def vat_rate(country: str, category: str = "standard") -> Decimal:
    """The VAT rate, in percent, for `country` and `category`."""
    rates = VAT_RATES.get(country)
    if rates is None:
        fail("TAX_UNKNOWN_COUNTRY", country=country)
    if category not in rates:
        fail("TAX_UNKNOWN_CATEGORY", country=country, category=category)
    return rates[category]


def vat_amount(m: Money, country: str, category: str = "standard") -> Money:
    """The VAT on `m`, rounded to the minor unit."""
    return round_minor(m * (vat_rate(country, category) / 100))


def vat_label(country: str, category: str = "standard") -> str:
    """The line an invoice prints for the VAT, with the rate as a percent.

    >>> vat_label('DE')
    'VAT 19%'
    >>> vat_label('FR', 'reduced')
    'VAT 5.5% (reduced)'
    """
    rate = vat_rate(country, category)
    shown = f"{rate.normalize():f}"
    return f"VAT {shown}%" if category == "standard" else f"VAT {shown}% ({category})"


def countries() -> list[str]:
    """The countries with VAT rates, sorted."""
    return sorted(VAT_RATES)
