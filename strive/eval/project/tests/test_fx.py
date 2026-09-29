import datetime
import os
import unittest
from decimal import Decimal

from tally import fx
from tally.errors import TallyError
from tally.money import Money
from tests.support import assert_money

D = datetime.date


@unittest.skipUnless(os.environ.get("TALLY_FX_RATES"), "FX rate fixtures aren't configured (see tests/fixtures/README.md)")
class FxTest(unittest.TestCase):
    def setUp(self):
        self.rates = fx.load_rates(os.environ["TALLY_FX_RATES"])

    def test_uses_the_rate_in_force_on_the_day(self):
        self.assertEqual(self.rates.on("EUR", "USD", D(2024, 3, 4)), Decimal("1.0856"))
        # The weekend keeps Friday's rate.
        self.assertEqual(self.rates.on("EUR", "USD", D(2024, 3, 3)), Decimal("1.0830"))

    def test_no_rate_before_the_first_one(self):
        with self.assertRaises(TallyError) as e:
            self.rates.on("EUR", "USD", D(2024, 2, 29))
        self.assertEqual(e.exception.code, "E5001")

    def test_converts_and_rounds_to_the_target_currency(self):
        assert_money(fx.convert(Money("100.00", "EUR"), "USD", D(2024, 3, 4), self.rates), "108.56 USD")
        assert_money(fx.convert(Money("100.00", "EUR"), "JPY", D(2024, 3, 4), self.rates), "16289 JPY")

    def test_converts_back_through_the_inverse_rate(self):
        assert_money(fx.convert(Money("108.56", "USD"), "EUR", D(2024, 3, 4), self.rates), "100.00 EUR")

    def test_crosses_through_a_third_currency(self):
        rate = fx.cross_rate("GBP", "USD", "EUR", D(2024, 3, 4), self.rates)
        self.assertEqual(round(rate, 4), Decimal("1.2678"))


if __name__ == "__main__":
    unittest.main()
