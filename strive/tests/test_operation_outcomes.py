"""Area 2: TRUSTED behavior-vs-infrastructure classification.

Classification is stamped at the execution boundary (only the sandbox knows
whether an ok=False fault was the candidate's own code or the backend itself),
persisted as `AttemptRecord.origin`, and read downstream — NOT inferred from the
failure kind or denials. A candidate that runs and is scored (even one that
errors, times out, or crashes its own process) is behavioral; a
backend/launcher/runtime fault or a run-budget shortfall is infrastructure.
"""

from __future__ import annotations

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FAILURE_CRASH,
    FAILURE_MALFORMED_OUTPUT,
    FAILURE_TIMEOUT,
    FAULT_CANDIDATE,
    FAULT_INFRASTRUCTURE,
    FAULT_UNKNOWN,
    BudgetUsage,
    FailureRecord,
    TaskCase,
)
from strive.kernel import _attempt_origin, _dominant_fault
from strive.runtime import (
    OP_BEHAVIORAL,
    OP_INFRASTRUCTURE,
    OP_UNKNOWN,
    AttemptRecord,
    classify_operation,
    is_behavioral_operation,
)
from strive.sandbox import run_strategy
from strive.sandboxes import SandboxLimits, SandboxProvenance

_PROV = SandboxProvenance(
    backend="process-fault-only@1", runtime_digest="d", component_digests={},
    enforced_capabilities=(), mount_policy="none", network_policy="none",
    limits=SandboxLimits(),
)


def _rec(origin: str) -> AttemptRecord:
    return AttemptRecord(
        command_id="c", label="current", state_ref="s", overall=0.0, ok=True,
        provenance=_PROV, failure=None, denials=(),
        usage=BudgetUsage(), report_ref="r", evaluation_ref="e", origin=origin,
    )


# -- classify_operation just returns the persisted, trusted origin --------------------------------


def test_classify_reads_the_persisted_origin() -> None:
    assert classify_operation(_rec(OP_BEHAVIORAL)) == OP_BEHAVIORAL
    assert is_behavioral_operation(_rec(OP_BEHAVIORAL))
    assert classify_operation(_rec(OP_INFRASTRUCTURE)) == OP_INFRASTRUCTURE
    assert not is_behavioral_operation(_rec(OP_INFRASTRUCTURE))


# -- the kernel's origin mapping from trusted boundary evidence -----------------------------------


def test_attempt_origin_maps_from_trusted_fault_origin() -> None:
    assert _attempt_origin(None, None)[0] == OP_BEHAVIORAL  # a clean run
    # only a PROVEN candidate fault stays behavioral
    assert _attempt_origin(FailureRecord(FAILURE_CRASH, "x"), FAULT_CANDIDATE)[0] == OP_BEHAVIORAL
    # a PROVEN backend/runtime fault is infrastructure
    assert _attempt_origin(FailureRecord(FAILURE_CRASH, "x"), FAULT_INFRASTRUCTURE)[0] == OP_INFRASTRUCTURE
    # a run-budget shortfall is infrastructure
    assert _attempt_origin(FailureRecord(FAILURE_BUDGET_EXHAUSTED, "x"), FAULT_INFRASTRUCTURE)[0] == OP_INFRASTRUCTURE
    # an UNKNOWN-stamped fault, or a failed attempt with NO stamp, is unknown
    assert _attempt_origin(FailureRecord(FAILURE_TIMEOUT, "x"), FAULT_UNKNOWN)[0] == OP_UNKNOWN
    assert _attempt_origin(FailureRecord(FAILURE_MALFORMED_OUTPUT, "x"), None)[0] == OP_UNKNOWN


def test_same_kind_different_origin() -> None:
    # a FAILURE_CRASH is behavioral only when PROVEN candidate, infrastructure
    # when proven backend, and unknown when unproven — the KIND never decides it.
    assert _attempt_origin(FailureRecord(FAILURE_CRASH, "x"), FAULT_CANDIDATE)[0] == OP_BEHAVIORAL
    assert _attempt_origin(FailureRecord(FAILURE_CRASH, "x"), FAULT_INFRASTRUCTURE)[0] == OP_INFRASTRUCTURE
    assert _attempt_origin(FailureRecord(FAILURE_CRASH, "x"), FAULT_UNKNOWN)[0] == OP_UNKNOWN


def test_dominant_fault_lets_infra_and_unknown_beat_candidate() -> None:
    # aggregating across cases: a later backend/unknown fault must not be hidden
    # behind an earlier candidate one.
    assert _dominant_fault(FAULT_CANDIDATE, FAULT_UNKNOWN) == FAULT_UNKNOWN
    assert _dominant_fault(FAULT_UNKNOWN, FAULT_INFRASTRUCTURE) == FAULT_INFRASTRUCTURE
    assert _dominant_fault(FAULT_INFRASTRUCTURE, FAULT_CANDIDATE) == FAULT_INFRASTRUCTURE
    assert _dominant_fault(None, FAULT_CANDIDATE) == FAULT_CANDIDATE


# -- the boundary stamps origins from real execution ----------------------------------------------


def _c(cid: str = "c") -> TaskCase:
    return TaskCase(cid, "1 2 3", 6, "operation")


def test_boundary_stamps_wall_timeout_as_unknown_not_candidate() -> None:
    # a wall timeout is NOT proven candidate (a hung child looks like a slow
    # launcher): it must be stamped UNKNOWN, never candidate.
    report = run_strategy(
        "def solve(t):\n    while True:\n        pass\n",
        (_c(),), generation_id="op", timeout_s=1.0,
    )
    assert not report.ok and report.failure is not None
    assert report.failure.kind == FAILURE_TIMEOUT
    assert report.fault_origin == FAULT_UNKNOWN


def test_boundary_marks_a_clean_run_with_no_fault_origin() -> None:
    report = run_strategy(
        "def solve(t):\n    return sum(int(x) for x in t.split())\n",
        (_c(),), generation_id="op", timeout_s=5.0,
    )
    assert report.ok and report.fault_origin is None


def test_boundary_stamps_candidate_exception_as_a_scored_behavioral_error() -> None:
    # a candidate exception is caught INSIDE the runner: a completed (ok=True)
    # per-case error — a behavioral, scored outcome, not a boundary fault.
    report = run_strategy(
        "def solve(t):\n    raise ValueError('boom')\n",
        (_c(),), generation_id="op", timeout_s=5.0,
    )
    assert report.ok and report.fault_origin is None
    assert report.outcomes[0].error is not None
