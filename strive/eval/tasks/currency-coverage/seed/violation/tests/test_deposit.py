import unittest
from decimal import Decimal

from tally.invoice import deposit
from tests.support import assert_money, sample_invoice


class DepositTest(unittest.TestCase):
    def test_is_a_share_of_the_total(self):
        assert_money(deposit(sample_invoice(), "DE", Decimal("30")), "349.86 EUR")

    def test_all_of_it(self):
        assert_money(deposit(sample_invoice(), "DE", Decimal("100")), "1166.20 EUR")
