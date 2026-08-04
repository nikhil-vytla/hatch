#!/usr/bin/env python3
"""Tests for validate_verdict.py. Run with: python3 scripts/test_validate_verdict.py"""

import unittest

import validate_verdict

VALID_VERDICT = """\
# Verdict: swebench:django__django-10914

Spec digest: 0f2c4a9d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c
Trigger: new-family

Verdict: admit-with-notes

## Observations
- evolved turn 2 phrases the revision naturally; no foreshadowing of the
  final function before its switch.
- matched arm turn 3 repeats the full problem statement verbatim, which is
  coherent but slightly templated; not disqualifying.
"""


def messages(text):
    return [message for _, message in validate_verdict.validate(text)]


class VerdictTests(unittest.TestCase):
    def test_valid_verdict_passes(self):
        self.assertEqual(messages(VALID_VERDICT), [])

    def test_missing_spec_digest_fails(self):
        text = VALID_VERDICT.replace("Spec digest:", "Digest:")
        self.assertTrue(any("Spec digest" in m for m in messages(text)))

    def test_malformed_digest_fails(self):
        text = VALID_VERDICT.replace(
            "0f2c4a9d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c",
            "not-a-digest",
        )
        self.assertTrue(any("Spec digest" in m for m in messages(text)))

    def test_missing_verdict_line_fails(self):
        text = VALID_VERDICT.replace("Verdict: admit-with-notes", "Decision: fine")
        self.assertTrue(any("exactly one" in m for m in messages(text)))

    def test_unknown_decision_fails(self):
        text = VALID_VERDICT.replace("admit-with-notes", "maybe")
        self.assertTrue(any("exactly one" in m for m in messages(text)))

    def test_duplicate_verdict_lines_fail(self):
        text = VALID_VERDICT + "\nVerdict: reject\n"
        self.assertTrue(any("exactly one" in m for m in messages(text)))

    def test_no_arm_or_turn_observation_fails(self):
        text = VALID_VERDICT.replace("evolved turn 2", "the material").replace(
            "matched arm turn 3", "the other material"
        )
        self.assertTrue(any("rendered arm" in m for m in messages(text)))

    def test_quoted_patch_hunk_fails(self):
        text = VALID_VERDICT + "\n@@ -1,4 +1,6 @@\n"
        self.assertTrue(any("patch hunk" in m for m in messages(text)))

    def test_overlong_verdict_fails(self):
        text = VALID_VERDICT + "\n" + "\n".join(f"- note {i}" for i in range(70))
        self.assertTrue(any("lines" in m for m in messages(text)))


if __name__ == "__main__":
    unittest.main()
