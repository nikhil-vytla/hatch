from __future__ import annotations

from collections.abc import Callable
from typing import Literal, Self, assert_never

from pydantic import model_validator

from .canonical import canonical_digest
from .hud_compile import (
    CompiledBundleV1,
    SealedLeakError,
    assert_agent_artifacts_clean,
)
from .outcome import FailureKind, Outcome, RunFailure, Verdict, Verification
from .specs import TaskSpecV1
from .types import DigestText, NonEmptyText, StrictModel

SubmissionKind = Literal[
    "known_good",
    "known_bad",
    "sealed_test_touch",
    "harness_crash",
]


class ConformanceError(AssertionError):
    pass


class ConformanceSubmission(StrictModel):
    kind: SubmissionKind
    model_patch: NonEmptyText
    simulate_harness_crash: bool = False


CONFORMANCE_SUBMISSIONS = (
    ConformanceSubmission(
        kind="known_good",
        model_patch="diff --git a/value.py b/value.py\n-    return 0\n+    return 1\n",
    ),
    ConformanceSubmission(
        kind="known_bad",
        model_patch="diff --git a/value.py b/value.py\n-    return 0\n+    return 2\n",
    ),
    ConformanceSubmission(
        kind="sealed_test_touch",
        model_patch=(
            "diff --git a/tests/test_value.py b/tests/test_value.py\n"
            "-    assert value() == 1\n"
            "+    assert value() == 0\n"
        ),
    ),
    ConformanceSubmission(
        kind="harness_crash",
        model_patch="diff --git a/value.py b/value.py\n-    return 0\n+    return 1\n",
        simulate_harness_crash=True,
    ),
)


class OutcomeVectorV1(StrictModel):
    verdict: Verdict | None = None
    failure_kind: FailureKind | None = None

    @model_validator(mode="after")
    def exactly_one_result(self) -> Self:
        if (self.verdict is None) == (self.failure_kind is None):
            raise ValueError("outcome vector must contain one result")
        return self


class ConformanceVectorV1(StrictModel):
    submission: SubmissionKind
    expected: OutcomeVectorV1
    actual: OutcomeVectorV1


class ConformanceRecordV1(StrictModel):
    schema_version: Literal[1] = 1
    target: Literal["hud"] = "hud"
    spec_digest: DigestText
    bundle_digest: DigestText
    vectors: tuple[ConformanceVectorV1, ...]


ReferenceGrader = Callable[[ConformanceSubmission], Outcome]
CompiledGrader = Callable[[CompiledBundleV1, ConformanceSubmission], Outcome]


def _vector(outcome: Outcome) -> OutcomeVectorV1:
    if isinstance(outcome, Verification):
        return OutcomeVectorV1(verdict=outcome.verdict)
    if isinstance(outcome, RunFailure):
        return OutcomeVectorV1(failure_kind=outcome.failure_kind)
    assert_never(outcome)


def run_conformance(
    task: TaskSpecV1,
    bundle: CompiledBundleV1,
    submissions: tuple[ConformanceSubmission, ...],
    reference_grader: ReferenceGrader,
    compiled_grader: CompiledGrader,
) -> ConformanceRecordV1:
    if submissions != CONFORMANCE_SUBMISSIONS:
        raise ConformanceError("conformance submissions differ from the fixed set")
    try:
        assert_agent_artifacts_clean(task.sealed, bundle.artifacts)
    except SealedLeakError as error:
        raise ConformanceError("compiled HUD context contains sealed bytes") from error
    vectors: list[ConformanceVectorV1] = []
    mismatches: list[SubmissionKind] = []
    for submission in submissions:
        expected = _vector(reference_grader(submission))
        actual = _vector(compiled_grader(bundle, submission))
        vector = ConformanceVectorV1(
            submission=submission.kind,
            expected=expected,
            actual=actual,
        )
        vectors.append(vector)
        if actual != expected:
            mismatches.append(submission.kind)
    if mismatches:
        raise ConformanceError(f"conformance vector mismatch: {mismatches}")
    return ConformanceRecordV1(
        spec_digest=task.spec_digest,
        bundle_digest=canonical_digest(bundle),
        vectors=tuple(vectors),
    )
