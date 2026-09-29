import datetime
import unittest
from decimal import Decimal

from tally._generated.records import Payment
from tally.payments import paid
from tests.support import assert_money, sample_invoice


def pay(ref, invoice, amount):
    return Payment(ref, invoice, Decimal(amount), "EUR", datetime.date(2024, 3, 20))


class PaidTest(unittest.TestCase):
    def test_adds_this_invoices_payments_only(self):
        ps = [pay("P-1", "INV-2024-0017", "100.00"), pay("P-2", "INV-OTHER", "5.00"), pay("P-3", "INV-2024-0017", "0.50")]
        assert_money(paid(sample_invoice(), ps), "100.50 EUR")
