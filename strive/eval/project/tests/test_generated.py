import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class GeneratedTest(unittest.TestCase):
    def test_records_match_the_schema(self):
        r = subprocess.run(
            [sys.executable, "tools/gen_records.py", "--check"], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
