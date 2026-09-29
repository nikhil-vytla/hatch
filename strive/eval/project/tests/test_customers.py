import unittest

from tally.customers import display_name, make_customer
from tally.errors import TallyError


class CustomersTest(unittest.TestCase):
    def test_make_customer_normalizes_the_email(self):
        c = make_customer("C-1", "  Acme Ltd ", " billing@acme.io ", "GB")
        self.assertEqual((c.name, c.email), ("Acme Ltd", "billing@acme.io"))

    def test_make_customer_refuses_a_bad_email(self):
        with self.assertRaises(TallyError) as e:
            make_customer("C-2", "Nobody", "not-an-address", "GB")
        self.assertEqual(e.exception.code, "E4001")

    def test_display_name_shows_the_vat_id(self):
        c = make_customer("C-3", "Müller GmbH", "ap@mueller.de", "DE", "DE811907980")
        self.assertEqual(display_name(c), "Müller GmbH (VAT DE811907980)")


if __name__ == "__main__":
    unittest.main()
