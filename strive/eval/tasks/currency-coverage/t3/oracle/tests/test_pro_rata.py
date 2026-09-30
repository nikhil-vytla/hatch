import unittest

from tally.money import Money, pro_rata
from tests.support import assert_money


class ProRataTest(unittest.TestCase):
    def test_a_share_of_the_period(self):
        assert_money(pro_rata(Money("100.00", "EUR"), 10, 30), "33.33 EUR")

    def test_yen(self):
        assert_money(pro_rata(Money("1000", "JPY"), 10, 30), "333 JPY")
