import unittest

from tally.customers import normalize_email


class Tal2304Test(unittest.TestCase):
    def test_keeps_the_local_part(self):
        self.assertEqual(normalize_email(" Ada.Lovelace@Example.COM "), "Ada.Lovelace@example.com")
