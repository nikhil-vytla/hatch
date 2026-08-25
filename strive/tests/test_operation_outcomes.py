"""Area 2: typed operation-outcome classification.

Only BEHAVIORAL outcomes may steer adaptation. A candidate that runs and is
scored — even one whose code errors, times out, or crashes — is behavioral; a
sandbox denial or a run-resource shortfall that prevented a clean evaluation is
infrastructure and must never teach a change or trigger rollback.
"""

from __future__ import annotations

from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FAILURE_CRASH,
    FAILURE_TIMEOUT,
    BudgetUsage,
    FailureRecord,
)
from strive.runtime import (
    OP_BEHAVIORAL,
    OP_INFRASTRUCTURE,
    AttemptRecord,
    classify_operation,
    is_behavioral_operation,
)
from strive.sandboxes import SandboxLimits, SandboxProvenance

_PROV = SandboxProvenance(
    backend="process-fault-only@1", runtime_digest="d", component_digests={},
    enforced_capabilities=(), mount_policy="none", network_policy="none",
    limits=SandboxLimits(),
)


def _rec(*, ok: bool, failure: FailureRecord | None, denials: tuple[str, ...]) -> AttemptRecord:
    return AttemptRecord(
        command_id="c", label="current", state_ref="s", overall=0.0, ok=ok,
        provenance=_PROV, failure=failure, denials=denials,
        usage=BudgetUsage(), report_ref="r", evaluation_ref="e",
    )


def test_clean_evaluation_is_behavioral() -> None:
    assert classify_operation(_rec(ok=True, failure=None, denials=())) == OP_BEHAVIORAL
    assert is_behavioral_operation(_rec(ok=True, failure=None, denials=()))


def test_candidate_code_timeout_or_crash_is_behavioral() -> None:
    # the CANDIDATE's own code misbehaving is its quality — a lesson to learn
    for kind in (FAILURE_TIMEOUT, FAILURE_CRASH):
        rec = _rec(ok=False, failure=FailureRecord(kind, "candidate misbehaved"), denials=())
        assert classify_operation(rec) == OP_BEHAVIORAL


def test_budget_shortfall_is_infrastructure() -> None:
    rec = _rec(
        ok=False, failure=FailureRecord(FAILURE_BUDGET_EXHAUSTED, "no executions left"),
        denials=(),
    )
    assert classify_operation(rec) == OP_INFRASTRUCTURE
    assert not is_behavioral_operation(rec)


def test_sandbox_denial_is_infrastructure() -> None:
    rec = _rec(ok=False, failure=None, denials=("network egress denied",))
    assert classify_operation(rec) == OP_INFRASTRUCTURE
