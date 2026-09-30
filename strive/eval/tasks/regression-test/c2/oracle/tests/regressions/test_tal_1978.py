import unittest

from tally.tax import vat_label


class Tal1978Test(unittest.TestCase):
    def test_names_only_other_categories(self):
        self.assertEqual(vat_label("AT", "reduced"), "VAT 10% (reduced)")
