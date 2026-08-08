"""Deterministic task definitions with task-owned scoring and case splits.

The task, not the evaluator, owns what "correct" means (`score_case`). Cases
are partitioned into splits with distinct trust roles:

- ``visible``     — evidence diagnosis and proposal are allowed to see (train).
- ``held_out``    — development/selection data; never shown to diagnosis/proposal,
                    used by acceptance policies on every promotion decision.
- ``regression``  — grown from past failures; selection data.
- ``adversarial`` — crafted to catch gaming; selection data.
- ``audit``       — final holdout: excluded from routine cycles entirely and
                    queried only on demand, so selection cannot overfit it.
                    Operationally separate, NOT secret: it is neither
                    encrypted nor access-controlled, and (like every case
                    input) it reaches candidate code at execution time when
                    an audit runs.

Each task also declares its strategy ``signature`` and an allowed
``primitive_catalog`` (importable modules) — the trusted inputs a proposer
receives and the pre-filter screen candidates must pass.

Two tasks exist:
- ``sum-integers`` — the phase-1 task with its *planted* weakness (naive
  ``\\d+`` drops minus signs), fixable by the registry proposer.
- ``max-integers`` — a *non-planted* weakness (lexicographic ``max`` over
  digit strings): nothing in the diagnosis registry or patch registry knows
  it, so the registry proposer cannot fix it; an evidence-driven proposer is
  required (in offline CI, a scripted fixture stands in for one).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from strive.contracts import ADVERSARIAL, AUDIT, HELD_OUT, VISIBLE, TaskCase


@dataclass(frozen=True)
class Task:
    """A deterministic task: identity, cases with splits, and its own scoring."""

    task_id: str
    version: int
    description: str
    signature: str
    primitive_catalog: tuple[str, ...]
    seed_source: str
    cases: tuple[TaskCase, ...]

    def case(self, case_id: str) -> TaskCase:
        for case in self.cases:
            if case.case_id == case_id:
                return case
        raise KeyError(case_id)

    def cases_in(self, split: str) -> tuple[TaskCase, ...]:
        return tuple(case for case in self.cases if case.split == split)

    def visible_cases(self) -> tuple[TaskCase, ...]:
        return self.cases_in(VISIBLE)

    def selection_cases(self) -> tuple[TaskCase, ...]:
        """Every case that routine cycles and promotion decisions may use.

        The audit split is excluded: it is a final holdout queried only on
        demand (`strive audit`), never during candidate selection.
        """
        return tuple(case for case in self.cases if case.split != AUDIT)

    def audit_cases(self) -> tuple[TaskCase, ...]:
        return self.cases_in(AUDIT)

    def fingerprint(self) -> str:
        """Content hash of the task's cases + scoring version, for drift detection."""
        canonical = json.dumps(
            {
                "task_id": self.task_id,
                "version": self.version,
                "cases": [
                    [c.case_id, c.input_text, c.expected, c.split] for c in self.cases
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def score_case(
        self, case: TaskCase, output: int | None, error: str | None
    ) -> tuple[float, bool, str]:
        """Task-owned scoring: (score, passed, feedback) for one case outcome."""
        if error is not None:
            return 0.0, False, f"errored: {error.strip().splitlines()[-1]}"
        if output is None:
            return 0.0, False, "no output produced"
        if output == case.expected:
            return 1.0, True, "correct"
        direction = "overestimate" if output > case.expected else "underestimate"
        return 0.0, False, f"expected {case.expected}, got {output} ({direction})"


BASELINE_STRATEGY_SOURCE = '''\
"""Seed strategy for sum-integers (generation zero)."""

import re


def solve(input_text: str) -> int:
    return sum(int(token) for token in re.findall(r"\\d+", input_text))
'''

SUM_INTEGERS_TASK = Task(
    task_id="sum-integers",
    version=3,
    description="Return the sum of every signed integer appearing in the input text.",
    signature="solve(input_text: str) -> int",
    primitive_catalog=("re",),
    seed_source=BASELINE_STRATEGY_SOURCE,
    cases=(
        # visible: what diagnosis/proposal may see (includes the planted weakness)
        TaskCase("positives-pair", "add 3 and 4 together", 7, VISIBLE),
        TaskCase("positives-triple", "values: 10 20 30", 60, VISIBLE),
        TaskCase("embedded-punctuation", "totals are 7, 2, and 11.", 20, VISIBLE),
        TaskCase("no-integers", "nothing numeric lives here", 0, VISIBLE),
        TaskCase("negative-single", "offset by -5 then add 12", 7, VISIBLE),
        TaskCase("negative-all", "deltas: -1 -2 -3", -6, VISIBLE),
        # held out: acceptance-only, never exposed to diagnosis/proposal
        TaskCase("held-negative-mixed", "balance: 100, adjustment: -40", 60, HELD_OUT),
        TaskCase("held-negative-pair", "shift by -7 then 3", -4, HELD_OUT),
        TaskCase("held-positive-only", "exactly 42 items", 42, HELD_OUT),
        # adversarial: signed-integer semantics in hostile-looking text
        TaskCase("adv-phone-like", "phone 555-1234 dialed", -679, ADVERSARIAL),
        TaskCase("adv-ranges", "ranges 1-3 and 2-4", -4, ADVERSARIAL),
        # regression split starts empty; it grows from past failures
        # audit: final holdout, excluded from routine cycles and selection
        TaskCase("audit-signed-mix", "audit -4 and 10 please", 6, AUDIT),
        TaskCase("audit-negative-heavy", "audit -20 5 -1", -16, AUDIT),
    ),
)

# NOTE: the seed source must stay free of any commentary about its own
# weaknesses — it is fed verbatim to proposers as evidence context, and an
# explanatory comment would leak the diagnosis/repair (fixture-leak fix).
MAX_SEED_STRATEGY_SOURCE = '''\
"""Seed strategy for max-integers (generation zero)."""

import re


def solve(input_text: str) -> int:
    tokens = re.findall(r"-?\\d+", input_text)
    if not tokens:
        return 0
    return int(max(tokens))
'''

MAX_INTEGERS_TASK = Task(
    task_id="max-integers",
    version=2,
    description=(
        "Return the largest signed integer appearing in the input text, "
        "or 0 if the text contains no integers."
    ),
    signature="solve(input_text: str) -> int",
    primitive_catalog=("re",),
    seed_source=MAX_SEED_STRATEGY_SOURCE,
    cases=(
        # visible
        TaskCase("single-value", "just 5 here", 5, VISIBLE),
        TaskCase("single-negative", "single -3 value", -3, VISIBLE),
        TaskCase("no-numbers", "no numbers at all", 0, VISIBLE),
        TaskCase("two-digit-vs-one", "pick 10 or 9", 10, VISIBLE),
        TaskCase("three-values", "values 7 100 23", 100, VISIBLE),
        # held out
        TaskCase("held-two-vs-one", "choose 25 vs 8", 25, HELD_OUT),
        TaskCase("held-close-magnitudes", "big 1000 small 999", 1000, HELD_OUT),
        TaskCase("held-single", "only 42 here", 42, HELD_OUT),
        # adversarial
        TaskCase("adv-all-negative", "compare -5 with -40", -5, ADVERSARIAL),
        TaskCase("adv-mixed-signs", "mix 9 11 -22", 11, ADVERSARIAL),
        # audit: final holdout, excluded from routine cycles and selection
        TaskCase("audit-close-large", "audit 900 vs 1000", 1000, AUDIT),
        TaskCase("audit-single-negative", "audit only -7", -7, AUDIT),
    ),
)

TASKS: dict[str, Task] = {
    SUM_INTEGERS_TASK.task_id: SUM_INTEGERS_TASK,
    MAX_INTEGERS_TASK.task_id: MAX_INTEGERS_TASK,
}
