import unittest
from decimal import Decimal

from tally._generated.records import LineItem
from tally.invoice import discounted_unit_price
from tests.support import assert_money


class DiscountedUnitPriceTest(unittest.TestCase):
    def test_takes_the_discount_off_one_unit(self):
        assert_money(discounted_unit_price(LineItem("Hosting", 3, Decimal("40.00"), Decimal("25")), "EUR"), "30.00 EUR")
