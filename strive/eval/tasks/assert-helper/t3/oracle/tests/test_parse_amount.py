import unittest

from tally.money import parse_amount
from tests.support import assert_money


class ParseAmountTest(unittest.TestCase):
    def test_reads_separators_and_parentheses(self):
        assert_money(parse_amount("1,234.50", "EUR"), "1234.50 EUR")
        assert_money(parse_amount("(12.00)", "USD"), "-12.00 USD")
