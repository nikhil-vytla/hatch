#!/usr/bin/env python3
"""Tests for validate_brief.py. Run with: python3 scripts/test_validate_brief.py"""

import pathlib
import re
import unittest

import validate_brief

VALID_BRIEF = """\
# Brief: does the cache help?

## Question
Does the request cache cut median latency for repeated lookups? Audience: the
teammate deciding whether to enable it by default.

## Result
Median latency drops from 41 ms to 6 ms on the replay corpus. The cache is off
by default and only the lookup path reads it.

## Code map
- `cache/store.py` owns eviction and the size bound.
- `lookup/handler.py` is the only reader.
- `bench/replay.py` reproduces the measurement.

## Evidence and reproduction
Measured on commit `abc1234`.

```
python3 bench/replay.py --corpus fixtures/replay.jsonl
```

Expected: `median_ms=6` with the cache, `median_ms=41` without.

## Next experiment
Replay the corpus with a 1000-entry size bound. Pass: median stays under
10 ms. Fail: eviction pushes it back above 20 ms.
"""


def messages(text, mode="brief"):
    return [message for _, message in validate_brief.validate(text, mode)]


class BriefModeTests(unittest.TestCase):
    def test_valid_brief_passes(self):
        self.assertEqual(messages(VALID_BRIEF), [])

    def test_missing_question_fails(self):
        text = VALID_BRIEF.replace("## Question", "## Background")
        self.assertTrue(any("Question" in m for m in messages(text)))

    def test_evidence_without_commands_fails(self):
        text = re.sub(r"```\n[^`]*```\n", "", VALID_BRIEF)
        self.assertTrue(any("fenced command block" in m for m in messages(text)))

    def test_banned_phrases_fail(self):
        for phrase in ["this PR", "PR3", "a later PR", "follow-up PRs"]:
            text = VALID_BRIEF + f"\nWe will fix that in {phrase}.\n"
            self.assertTrue(
                any("banned phrase" in m for m in messages(text)),
                f"expected a finding for {phrase!r}",
            )

    def test_empty_section_fails(self):
        text = VALID_BRIEF + "\n## Limits\n\n## Learnings\nOne learning.\n"
        self.assertTrue(any("empty section 'Limits'" in m for m in messages(text)))

    def test_heading_with_subsections_is_not_empty(self):
        text = VALID_BRIEF + "\n## Learnings\n\n### Caching\nEviction dominates.\n"
        self.assertFalse(any("empty section" in m for m in messages(text)))

    def test_oversized_result_fails(self):
        padding = "\n".join(f"Extra observation {i}." for i in range(15))
        text = VALID_BRIEF.replace("## Code map", padding + "\n\n## Code map")
        self.assertTrue(any("Result section has" in m for m in messages(text)))

    def test_code_map_bounds(self):
        two_entries = VALID_BRIEF.replace("- `bench/replay.py` reproduces the measurement.\n", "")
        self.assertTrue(any("code map has 2 entries" in m for m in messages(two_entries)))
        eight_entries = VALID_BRIEF.replace(
            "## Evidence",
            "\n".join(f"- `mod{i}.py` exists." for i in range(5)) + "\n\n## Evidence",
        )
        self.assertTrue(any("code map has 8 entries" in m for m in messages(eight_entries)))

    def test_over_length_brief_fails(self):
        text = VALID_BRIEF + "\nMore detail.\n" * 200
        self.assertTrue(any("keep it under" in m for m in messages(text)))

    def test_banned_phrase_inside_fence_is_ignored(self):
        text = VALID_BRIEF.replace(
            "python3 bench/replay.py --corpus fixtures/replay.jsonl",
            "grep -r 'this PR' notes/",
        )
        self.assertEqual(messages(text), [])


class DocModeTests(unittest.TestCase):
    def test_doc_mode_skips_brief_structure(self):
        text = "# README\n\nCurrent capability is documentation-only.\n"
        self.assertEqual(messages(text, mode="doc"), [])

    def test_doc_mode_flags_delivery_language(self):
        text = "# README\n\nThe verifier lands in PR4.\n"
        self.assertTrue(any("banned phrase" in m for m in messages(text, mode="doc")))


class ReferenceExampleTests(unittest.TestCase):
    def test_worked_example_in_reference_passes(self):
        reference = pathlib.Path(__file__).resolve().parent.parent / "reference.md"
        match = re.search(r"^````markdown\n(.*?)^````", reference.read_text(), re.DOTALL | re.MULTILINE)
        self.assertIsNotNone(match, "reference.md must contain a ````markdown worked example")
        self.assertEqual(messages(match.group(1)), [])


if __name__ == "__main__":
    unittest.main()
