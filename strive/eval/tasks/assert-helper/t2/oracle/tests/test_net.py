import unittest

from tally.money import Money
from tally.tax import net_from_gross
from tests.support import assert_money


class NetFromGrossTest(unittest.TestCase):
    def test_takes_the_vat_back_out(self):
        assert_money(net_from_gross(Money("119.00", "EUR"), "DE"), "100.00 EUR")
        assert_money(net_from_gross(Money("105.50", "EUR"), "FR", "reduced"), "100.00 EUR")
