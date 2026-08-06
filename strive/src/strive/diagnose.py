"""Diagnosis: infer a known weakness from visible trace evidence only.

The kernel hands the diagnoser a ``VisibleContext`` containing only the
visible split — held-out, regression, and adversarial cases are mechanically
absent from its inputs (holdout isolation). If failures don't fit a known
signature the diagnoser returns ``None``: an honest "cause unknown" that
yields no proposal rather than a guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from strive.contracts import Diagnosis, Evaluation, TaskCase


@dataclass(frozen=True)
class VisibleContext:
    """The only evidence diagnosis/proposal ever receive: visible cases + their
    evaluation, and the parent source. No other split appears here."""

    task_id: str
    cases: tuple[TaskCase, ...]
    evaluation: Evaluation
    parent_generation_id: str
    parent_source: str

    def case(self, case_id: str) -> TaskCase:
        for case in self.cases:
            if case.case_id == case_id:
                return case
        raise KeyError(case_id)


class Diagnoser(Protocol):
    def diagnose(self, ctx: VisibleContext) -> Diagnosis | None: ...


_NEGATIVE_INTEGER = re.compile(r"-\d")

NEGATIVE_INTEGERS_DROPPED = "negative-integers-dropped"


class SignatureDiagnoser:
    """Registry of trace signatures; currently one (the planted weakness)."""

    def diagnose(self, ctx: VisibleContext) -> Diagnosis | None:
        evaluation = ctx.evaluation
        failing = [ce for ce in evaluation.case_evaluations if not ce.passed]
        if not failing or not evaluation.passing_case_ids():
            return None

        # Signature: every failure is on an input containing a negative integer,
        # produced a value (no exception), and that value is too high — exactly
        # what dropping minus signs looks like from the outside.
        signature_holds = all(
            ce.error is None
            and ce.output is not None
            and ce.output > ce.expected
            and _NEGATIVE_INTEGER.search(ctx.case(ce.case_id).input_text)
            for ce in failing
        )
        if signature_holds:
            return Diagnosis(
                weakness_id=NEGATIVE_INTEGERS_DROPPED,
                description=(
                    "All failing visible cases contain negative integers and the "
                    "strategy returned an overestimate without raising, consistent "
                    "with minus signs being dropped during extraction."
                ),
                evidence_case_ids=tuple(ce.case_id for ce in failing),
            )
        return None
