"""The error registry, and that code raises only registered errors.

Support and the API's clients look errors up by code (errors/registry.json),
so every error tally raises goes through tally.errors.fail with a
registered name, and each code sits in its module's range.
"""

import re
import unittest
from pathlib import Path

from tally.errors import registry

ROOT = Path(__file__).resolve().parent.parent
BARE = re.compile(r"\braise\s+(ValueError|KeyError|RuntimeError|Exception|TallyError)\b")
FAIL = re.compile(r"\bfail\(\s*\"([A-Z0-9_]+)\"")


def span(text):
    lo, hi = text.split("-")
    return int(lo[1:]), int(hi[1:])


def sources():
    for path in sorted((ROOT / "tally").rglob("*.py")):
        if path.name != "errors.py" and "_generated" not in path.parts:
            yield path, path.read_text()


class RegistryTest(unittest.TestCase):
    def test_codes_are_unique_and_in_their_area_range(self):
        reg = registry()
        seen = {}
        for name, entry in reg["errors"].items():
            code = entry["code"]
            self.assertNotIn(code, seen, f"{name} and {seen.get(code)} share {code}")
            seen[code] = name
            area = entry["area"]
            self.assertIn(area, reg["ranges"], f"{name}: no range for area {area!r} in errors/registry.json")
            lo, hi = span(reg["ranges"][area])
            self.assertTrue(lo <= int(code[1:]) <= hi, f"{name}: {code} is outside {area}'s range {reg['ranges'][area]}")

    def test_code_raises_only_registered_errors(self):
        names = registry()["errors"]
        problems = []
        for path, text in sources():
            rel = path.relative_to(ROOT)
            for n, line in enumerate(text.splitlines(), 1):
                if BARE.search(line):
                    problems.append(
                        f"{rel}:{n}: raise errors with tally.errors.fail(NAME, ...) and a code registered in errors/registry.json"
                    )
            for name in FAIL.findall(text):
                if name not in names:
                    problems.append(f"{rel}: {name} isn't registered in errors/registry.json")
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
