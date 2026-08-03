from __future__ import annotations

import re

import pytest
from test_swebench_env import family

from parallax.conformance import (
    CONFORMANCE_SUBMISSIONS,
    ConformanceError,
    ConformanceSubmission,
    run_conformance,
)
from parallax.hud_compile import (
    CompiledArtifactV1,
    compile_hud,
    load_evaluator_specs,
)
from parallax.outcome import RunFailure, Verdict, Verification
from parallax.specs import freeze_swe_specs


def candidate_value(submission: ConformanceSubmission) -> int:
    match = re.search(r"^\+\s+return (\d+)$", submission.model_patch, re.MULTILINE)
    return int(match.group(1)) if match else 0


def candidate_test_expected(submission: ConformanceSubmission) -> int | None:
    match = re.search(
        r"^\+\s+assert value\(\) == (\d+)$",
        submission.model_patch,
        re.MULTILINE,
    )
    return int(match.group(1)) if match else None


def reference_grader(submission: ConformanceSubmission):
    if submission.simulate_harness_crash:
        return RunFailure(
            failure_kind="verifier",
            error_type="HarnessCrash",
            message="simulated harness crash",
        )
    if candidate_value(submission) == 1:
        return Verification(verdict=Verdict.PASS, reason="authoritative tests pass")
    return Verification(verdict=Verdict.WRONG, reason="authoritative tests fail")


def compiled_grader(bundle, submission: ConformanceSubmission):
    task, _ = load_evaluator_specs(bundle)
    if submission.simulate_harness_crash:
        return RunFailure(
            failure_kind="verifier",
            error_type="HarnessCrash",
            message="compiled evaluator preserved harness failure",
        )
    assert task.sealed.test_patch
    if candidate_value(submission) == 1:
        return Verification(verdict=Verdict.PASS, reason="compiled grader pass")
    return Verification(verdict=Verdict.WRONG, reason="compiled grader wrong")


def returncode_only_grader(bundle, submission: ConformanceSubmission):
    if submission.simulate_harness_crash:
        return Verification(verdict=Verdict.WRONG, reason="return code nonzero")
    expected = candidate_test_expected(submission)
    if candidate_value(submission) == (1 if expected is None else expected):
        return Verification(verdict=Verdict.PASS, reason="return code zero")
    return Verification(verdict=Verdict.WRONG, reason="return code nonzero")


def test_red_phase_catches_returncode_only_grading() -> None:
    task, environment = freeze_swe_specs(family())
    bundle = compile_hud(task, environment)

    with pytest.raises(ConformanceError, match="conformance vector mismatch") as caught:
        run_conformance(
            task,
            bundle,
            CONFORMANCE_SUBMISSIONS,
            reference_grader,
            returncode_only_grader,
        )
    assert "sealed_test_touch" in str(caught.value)
    assert "harness_crash" in str(caught.value)


def test_red_phase_catches_sealed_bytes_in_agent_context() -> None:
    task, environment = freeze_swe_specs(family())
    bundle = compile_hud(task, environment)
    leaky = bundle.model_copy(
        update={
            "artifacts": (
                *bundle.artifacts,
                CompiledArtifactV1(
                    path="leaked.txt",
                    audience="agent",
                    content=task.sealed.test_patch.encode(),
                ),
            )
        }
    )

    with pytest.raises(ConformanceError, match="sealed bytes"):
        run_conformance(
            task,
            leaky,
            CONFORMANCE_SUBMISSIONS,
            reference_grader,
            compiled_grader,
        )


def test_green_phase_matches_all_conformance_vectors() -> None:
    task, environment = freeze_swe_specs(family())
    bundle = compile_hud(task, environment)

    record = run_conformance(
        task,
        bundle,
        CONFORMANCE_SUBMISSIONS,
        reference_grader,
        compiled_grader,
    )

    assert [item.submission for item in record.vectors] == [
        "known_good",
        "known_bad",
        "sealed_test_touch",
        "harness_crash",
    ]
    assert all(item.expected == item.actual for item in record.vectors)
