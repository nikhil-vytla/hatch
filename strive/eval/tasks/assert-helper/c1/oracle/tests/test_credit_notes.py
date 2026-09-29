import datetime
import unittest
from decimal import Decimal

from tally._generated.records import CreditNote
from tally.invoice import credit_note_total
from tests.support import assert_money


def note(n, amount, currency="EUR"):
    return CreditNote(n, "INV-1", Decimal(amount), currency, datetime.date(2024, 3, 1))


class CreditNoteTotalTest(unittest.TestCase):
    def test_sums_notes_in_the_currency(self):
        assert_money(credit_note_total([note("CN-1", "10.00"), note("CN-2", "2.50"), note("CN-3", "9", "USD")], "EUR"), "12.50 EUR")
