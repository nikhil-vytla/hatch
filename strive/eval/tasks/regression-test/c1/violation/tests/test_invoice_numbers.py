import unittest

from tally.invoice import format_number


class Tal1942Test(unittest.TestCase):
    def test_pads_with_zeros(self):
        self.assertEqual(format_number(2024, 7), "INV-2024-0007")
