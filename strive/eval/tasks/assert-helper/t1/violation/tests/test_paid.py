import datetime
import unittest
from decimal import Decimal

from tally._generated.records import Payment
from tally.payments import paid
from tests.support import sample_invoice


class PaidTest(unittest.TestCase):
    def test_adds_this_invoices_payments_only(self):
        ps = [Payment("P-1", "INV-2024-0017", Decimal("100.00"), "EUR", datetime.date(2024, 3, 20))]
        self.assertEqual(str(paid(sample_invoice(), ps)), "100.00 EUR")
