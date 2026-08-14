"""Codec: round trips, strict validation, loud rejection.

Exercised against surviving primitives and the vNext substrate records
(the promotion-era wire types were deleted in the Phase-A reset)."""

import pytest

from strive import codec
from strive.contracts import (
    BudgetUsage,
    Event,
    ExecutionReport,
    FailureRecord,
    TaskCase,
)
from strive.substrate import (
    ChangeApplied,
    CompositeChange,
    HarnessState,
    PolicyBound,
    SurfaceBinding,
    SurfaceDelta,
)


def _change() -> CompositeChange:
    return CompositeChange(
        change_id="manual-change-1",
        deltas=(
            SurfaceDelta("strategy-code", "solve", "aa" * 32, "bb" * 32),
            SurfaceDelta("prompt", "proposal-template", None, "cc" * 32),
        ),
        summary="install the signed-sum strategy and matching prompt",
    )


ROUND_TRIP_SAMPLES = [
    TaskCase("c1", "text", 5, "visible"),
    FailureRecord("timeout", "killed after 1.0s"),
    ExecutionReport(ok=True, generation_id="g", outcomes=(), failure=None,
                    wall_time_s=0.1, stdout_bytes=0),
    BudgetUsage(wall_time_s=0.5, executions=1),
    SurfaceBinding("strategy-code", "solve", "ab" * 32),
    HarnessState(bindings=(SurfaceBinding("prompt", "proposal-template", "cd" * 32),)),
    _change(),
    PolicyBound(
        policy_ref="manual-change@1",
        config_ref="ab" * 32,
        prompt_refs={"refine": "cd" * 32},
        seed=7,
        seed_state_ref="ef" * 32,
        run_metadata={"model": "none"},
        at="2026-08-14T00:00:00+00:00",
    ),
    ChangeApplied(
        change_id="manual-change-1",
        change_ref="11" * 32,
        before_state_ref="22" * 32,
        after_state_ref="33" * 32,
        at="2026-08-14T00:00:00+00:00",
    ),
    Event(ts="t", type="policy_step", run_id="run-x", payload={"k": [1, 2]}),
]


@pytest.mark.parametrize("obj", ROUND_TRIP_SAMPLES, ids=lambda o: type(o).__name__)
def test_round_trip(obj: object) -> None:
    line = codec.dumps(obj)
    assert '"schema"' in line
    assert codec.loads(line) == obj


def test_nested_change_survives_round_trip() -> None:
    decoded: CompositeChange = codec.loads(codec.dumps(_change()), CompositeChange)
    assert decoded.deltas[0].before_ref == "aa" * 32
    assert decoded.deltas[1].before_ref is None


def test_unknown_kind_rejected_loudly() -> None:
    with pytest.raises(codec.SchemaError, match="unknown schema kind"):
        codec.loads('{"schema": "mystery@1", "x": 1}')


def test_future_version_rejected_loudly() -> None:
    line = codec.dumps(TaskCase("c", "t", 1, "visible")).replace(
        "task-case@1", "task-case@2"
    )
    with pytest.raises(codec.SchemaError, match="unsupported task-case version 2"):
        codec.loads(line)


def test_missing_field_rejected() -> None:
    with pytest.raises(codec.SchemaError, match="missing fields"):
        codec.loads('{"schema": "failure@1", "kind": "timeout"}')


def test_unexpected_field_rejected() -> None:
    with pytest.raises(codec.SchemaError, match="unexpected fields"):
        codec.loads(
            '{"schema": "failure@1", "kind": "timeout", "detail": "d", "extra": 1}'
        )


def test_wrong_type_rejected() -> None:
    with pytest.raises(codec.SchemaError, match="expected string"):
        codec.loads('{"schema": "failure@1", "kind": 5, "detail": "d"}')


def test_missing_schema_field_rejected() -> None:
    with pytest.raises(codec.SchemaError, match="missing or malformed schema"):
        codec.loads('{"kind": "timeout", "detail": "d"}')


def test_invalid_json_rejected() -> None:
    with pytest.raises(codec.SchemaError, match="invalid JSON"):
        codec.loads("{not json")


def test_expect_mismatch_rejected() -> None:
    line = codec.dumps(FailureRecord("timeout", "d"))
    with pytest.raises(codec.SchemaError, match="expected task-case@1"):
        codec.loads(line, TaskCase)
