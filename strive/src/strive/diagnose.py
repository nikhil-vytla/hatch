"""Diagnosis: infer a known weakness from trace evidence only.

The diagnoser never looks at the strategy source; it reasons purely over the
evaluated trace (which cases failed, their inputs, outputs, and errors) and
matches against a registry of weakness signatures. If failures don't fit a
known signature it returns ``None`` — an honest "cause unknown" that yields
no proposal rather than a guess.
"""

from __future__ import annotations

import re

from strive.types import Diagnosis, Evaluation, Task

_NEGATIVE_INTEGER = re.compile(r"-\d")

NEGATIVE_INTEGERS_DROPPED = "negative-integers-dropped"


def diagnose(task: Task, evaluation: Evaluation) -> Diagnosis | None:
    failing = [ce for ce in evaluation.case_evaluations if not ce.passed]
    if not failing or not evaluation.passing_case_ids:
        return None

    # Signature: every failure is on an input containing a negative integer,
    # produced a value (no exception), and that value is too high — exactly
    # what dropping minus signs looks like from the outside.
    signature_holds = all(
        ce.error is None
        and ce.output is not None
        and ce.output > ce.expected
        and _NEGATIVE_INTEGER.search(task.case(ce.case_id).input_text)
        for ce in failing
    )
    if signature_holds:
        return Diagnosis(
            weakness_id=NEGATIVE_INTEGERS_DROPPED,
            description=(
                "All failing cases contain negative integers and the strategy "
                "returned an overestimate without raising, consistent with "
                "minus signs being dropped during extraction."
            ),
            evidence_case_ids=tuple(ce.case_id for ce in failing),
        )
    return None
