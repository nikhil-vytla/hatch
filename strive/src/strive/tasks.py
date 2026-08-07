"""Deterministic task definitions.

The v0 task is "sum every signed integer that appears in the text". It is
chosen because it is trivial to evaluate, needs no network, and admits a
planted weakness: a naive ``re.findall(r"\\d+", ...)`` strategy silently drops
minus signs, so negative-number cases fail in a way that is diagnosable from
the trace alone.
"""

from __future__ import annotations

from strive.types import Task, TaskCase

SUM_INTEGERS_TASK = Task(
    task_id="sum-integers-v1",
    description="Return the sum of every signed integer appearing in the input text.",
    cases=(
        TaskCase("positives-pair", "add 3 and 4 together", 7),
        TaskCase("positives-triple", "values: 10 20 30", 60),
        TaskCase("embedded-punctuation", "totals are 7, 2, and 11.", 20),
        TaskCase("no-integers", "nothing numeric lives here", 0),
        TaskCase("negative-single", "offset by -5 then add 12", 7),
        TaskCase("negative-all", "deltas: -1 -2 -3", -6),
        TaskCase("negative-mixed", "balance: 100, adjustment: -40", 60),
    ),
)

BASELINE_STRATEGY_SOURCE = '''\
"""Seed strategy for sum-integers-v1 (generation zero).

Known-naive: matches unsigned digit runs only.
"""

import re


def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"\\d+", input_text))
'''
