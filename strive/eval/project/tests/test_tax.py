import unittest
from decimal import Decimal

from tally import tax
from tally.errors import TallyError
from tally.money import Money
from tests.support import assert_money


class TaxTest(unittest.TestCase):
    def test_rates_by_country_and_category(self):
        self.assertEqual(tax.vat_rate("DE"), Decimal("19"))
        self.assertEqual(tax.vat_rate("FR", "reduced"), Decimal("5.5"))

    def test_unknown_country(self):
        with self.assertRaises(TallyError) as e:
            tax.vat_rate("US")
        self.assertEqual(e.exception.code, "E3001")

    def test_vat_amount_is_rounded_to_the_cent(self):
        assert_money(tax.vat_amount(Money("99.99", "EUR"), "DE"), "19.00 EUR")
        assert_money(tax.vat_amount(Money("10.00", "EUR"), "FR", "reduced"), "0.55 EUR")


if __name__ == "__main__":
    unittest.main()
