import unittest
from decimal import Decimal

from tally.errors import TallyError
from tally.money import Money, allocate, round_minor
from tests.support import assert_money


class MoneyTest(unittest.TestCase):
    def test_adds_and_subtracts_in_one_currency(self):
        assert_money(Money("10.10", "EUR") + Money("0.95", "EUR"), "11.05 EUR")
        assert_money(Money("10.10", "EUR") - Money("0.95", "EUR"), "9.15 EUR")

    def test_refuses_to_mix_currencies(self):
        with self.assertRaises(TallyError) as e:
            Money("1", "EUR") + Money("1", "USD")
        self.assertEqual(e.exception.code, "E1002")

    def test_refuses_unknown_currencies(self):
        with self.assertRaises(TallyError) as e:
            Money("1", "XYZ")
        self.assertEqual(e.exception.code, "E1001")

    def test_multiplies_by_a_quantity(self):
        assert_money(Money("19.99", "USD") * 3, "59.97 USD")
        assert_money(Money("2.50", "GBP") * Decimal("1.5"), "3.750 GBP")

    def test_has_no_equality(self):
        with self.assertRaises(TypeError):
            _ = Money("1", "EUR") == Money("1", "EUR")

    def test_rounds_half_to_even(self):
        assert_money(round_minor(Money("0.125", "EUR")), "0.12 EUR")
        assert_money(round_minor(Money("0.135", "EUR")), "0.14 EUR")
        assert_money(round_minor(Money("0.0005", "BHD")), "0.000 BHD")

    def test_allocates_without_losing_a_cent(self):
        parts = allocate(Money("100.00", "EUR"), 3)
        self.assertEqual([str(p.amount) for p in parts], ["33.34", "33.33", "33.33"])


if __name__ == "__main__":
    unittest.main()
