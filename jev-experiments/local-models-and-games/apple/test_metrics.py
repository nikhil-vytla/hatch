"""Checks with analytic expected values, independent of the evaluation loop."""

import unittest, math
from metrics import metrics


class MetricTests(unittest.TestCase):
    def test_perfect_distribution_and_ordinal_expectation(self):
        m = metrics([{"target": [0, 1, 0], "p": [0, 1, 0], "qtype": 1}], "p")
        self.assertEqual(m["accuracy"], 1)
        self.assertEqual(m["kl"], 0)
        self.assertEqual(m["brier"], 0)
        self.assertEqual(m["ece"], 0)
        self.assertEqual(m["score_mae"], 0)

    def test_uniform_binary_distribution(self):
        m = metrics([{"target": [0, 1], "p": [0.5, 0.5], "qtype": 2}], "p")
        self.assertAlmostEqual(m["kl"], math.log(2))
        self.assertEqual(m["brier"], 0.25)
        self.assertEqual(m["accuracy"], 0)
        self.assertEqual(m["ece"], 0.5)

    def test_soft_targets_remain_soft(self):
        m = metrics([{"target": [0.2, 0.8], "p": [0.2, 0.8], "qtype": 2}], "p")
        self.assertEqual(m["kl"], 0)
        self.assertEqual(m["brier"], 0)
        self.assertAlmostEqual(m["soft_accuracy"], 0.8)
        self.assertAlmostEqual(m["ece"], 0.2)


if __name__ == "__main__":
    unittest.main()
