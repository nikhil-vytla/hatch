import unittest

from tally.payments import early_payment_discount
from tests.support import assert_money, sample_invoice


class EarlyPaymentDiscountTest(unittest.TestCase):
    def test_is_a_share_of_the_total(self):
        assert_money(early_payment_discount(sample_invoice(), "DE", "2"), "23.32 EUR")
