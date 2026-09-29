import datetime
import unittest
from decimal import Decimal

from tally._generated.records import Payment
from tally.payments import overpaid_by
from tests.support import assert_money, sample_invoice


def pay(amount):
    return Payment("P-1", "INV-2024-0017", Decimal(amount), "EUR", datetime.date(2024, 3, 20))


class OverpaidByTest(unittest.TestCase):
    def test_is_what_was_paid_beyond_the_total(self):
        assert_money(overpaid_by(sample_invoice(), "DE", [pay("1200.00")]), "33.80 EUR")
