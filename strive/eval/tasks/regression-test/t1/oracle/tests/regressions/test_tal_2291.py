import unittest

import datetime

from tally.dates import add_months


class Tal2291Test(unittest.TestCase):
    def test_clamps_to_the_end_of_a_shorter_month(self):
        self.assertEqual(add_months(datetime.date(2023, 1, 31), 1), datetime.date(2023, 2, 28))
