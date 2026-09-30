import unittest

from tally.money import Money
from tally.tax import gross_from_net
from tests.support import assert_money


class GrossFromNetTest(unittest.TestCase):
    def test_adds_the_vat(self):
        assert_money(gross_from_net(Money("100.00", "EUR"), "DE"), "119.00 EUR")

    def test_yen(self):
        assert_money(gross_from_net(Money("999", "JPY"), "DE"), "1189 JPY")
