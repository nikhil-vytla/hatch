import unittest

from tally.text import slugify


class Tal1187Test(unittest.TestCase):
    def test_no_dashes_at_the_ends(self):
        self.assertEqual(slugify("  Invoice #2024/017  "), "invoice-2024-017")
