import datetime
import unittest
from decimal import Decimal

from tally import payments
from tally._generated.records import Payment
from tally.errors import TallyError
from tests.support import assert_money, sample_invoice


def pay(ref, amount):
    return Payment(ref, "INV-2024-0017", Decimal(amount), "EUR", datetime.date(2024, 3, 20))


class PaymentsTest(unittest.TestCase):
    def test_balance_due_subtracts_payments(self):
        inv = sample_invoice()
        assert_money(payments.balance_due(inv, "DE", [pay("P-1", "1000.00")]), "166.20 EUR")

    def test_refuses_an_overpayment(self):
        inv = sample_invoice()
        with self.assertRaises(TallyError) as e:
            payments.record_payment(inv, "DE", [pay("P-1", "1000.00")], pay("P-2", "200.00"))
        self.assertEqual(e.exception.code, "E6001")


if __name__ == "__main__":
    unittest.main()
