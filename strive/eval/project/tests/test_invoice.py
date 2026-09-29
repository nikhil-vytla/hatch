import datetime
import unittest
from decimal import Decimal

from tally import invoice
from tally._generated.records import Invoice
from tally.errors import TallyError
from tally.money import Money
from tests.support import assert_money, sample_invoice


class InvoiceTest(unittest.TestCase):
    def test_line_total_applies_the_discount(self):
        inv = sample_invoice()
        assert_money(invoice.line_total(inv.lines[1], "EUR"), "30.00 EUR")

    def test_subtotal_adds_the_lines(self):
        assert_money(invoice.subtotal(sample_invoice()), "980.00 EUR")

    def test_total_adds_the_customers_vat(self):
        assert_money(invoice.total(sample_invoice(), "DE"), "1166.20 EUR")
        assert_money(invoice.total(sample_invoice(), "IE"), "1205.40 EUR")

    def test_an_invoice_without_lines_has_no_subtotal(self):
        inv = Invoice("INV-2024-0018", "C-100", "EUR", datetime.date(2024, 3, 1))
        with self.assertRaises(TallyError) as e:
            invoice.subtotal(inv)
        self.assertEqual(e.exception.code, "E2001")

    def test_discount_is_a_percentage_from_0_to_100(self):
        assert_money(invoice.apply_discount(Money("80.00", "EUR"), Decimal("12.5")), "70.00 EUR")
        with self.assertRaises(TallyError):
            invoice.apply_discount(Money("80.00", "EUR"), Decimal("120"))

    def test_late_fee_grows_by_the_day(self):
        inv = sample_invoice()
        assert_money(invoice.late_fee(inv, "DE", 0), "0 EUR")
        assert_money(invoice.late_fee(inv, "DE", 10), "5.83 EUR")

    def test_due_date_follows_the_terms(self):
        self.assertEqual(invoice.due(sample_invoice()), datetime.date(2024, 3, 31))


if __name__ == "__main__":
    unittest.main()
