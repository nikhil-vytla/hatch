from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from .types import StrictModel

FailureKind: TypeAlias = Literal["agent", "budget", "verifier"]


class BudgetError(RuntimeError):
    pass


class Verdict(StrEnum):
    PASS = "pass"
    WRONG = "wrong"
    INVALID = "invalid"


class Verification(StrictModel):
    kind: Literal["verification"] = "verification"
    verdict: Verdict
    reason: str


class RunFailure(StrictModel):
    kind: Literal["run_failure"] = "run_failure"
    failure_kind: FailureKind
    error_type: str
    message: str


Outcome: TypeAlias = Annotated[
    Verification | RunFailure,
    Field(discriminator="kind"),
]
