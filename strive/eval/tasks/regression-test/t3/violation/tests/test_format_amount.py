import unittest

from tally.money import Money, format_amount


class Tal2356Test(unittest.TestCase):
    def test_sign_before_the_symbol(self):
        self.assertEqual(format_amount(Money("-1234.5", "GBP")), "-£1,234.50")
