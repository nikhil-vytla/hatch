import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class LockTest(unittest.TestCase):
    def test_lockfile_matches_pyproject(self):
        r = subprocess.run([sys.executable, "tools/lock.py", "--check"], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == "__main__":
    unittest.main()
