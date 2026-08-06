"""Seed strategy for sum-integers-v1 (generation zero).

Known-naive: matches unsigned digit runs only.
"""

import re


def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"-?\d+", input_text))
