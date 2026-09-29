"""Calls tally must not make.

tally reads the time only through tally.clock, so tests can freeze it and
due dates, late fees and reminders don't depend on when the tests run.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BANNED = [
    (re.compile(r"\b(datetime|_dt\.datetime|dt\.datetime)\.(now|utcnow|today)\("), "tally.clock.now() or tally.clock.today()"),
    (re.compile(r"\b(date|_dt\.date|dt\.date)\.today\("), "tally.clock.today()"),
    (re.compile(r"\btime\.time\("), "tally.clock.now()"),
]


class BannedTest(unittest.TestCase):
    def test_no_banned_calls(self):
        problems = []
        for path in sorted((ROOT / "tally").rglob("*.py")):
            if path.name == "clock.py":
                continue
            for n, line in enumerate(path.read_text().splitlines(), 1):
                for pattern, instead in BANNED:
                    if pattern.search(line):
                        problems.append(f"{path.relative_to(ROOT)}:{n}: banned call; use {instead}")
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
