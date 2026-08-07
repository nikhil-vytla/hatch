"""Codec: round trips, strict validation, loud rejection, v1 compatibility."""

import pytest

from strive import codec
from strive.contracts import (
    Activation,
    BudgetUsage,
    CycleRecord,
    Decision,
    Event,
    FailureRecord,
    Generation,
    Intervention,
    TaskCase,
)


def _decision() -> Decision:
    return Decision(
        accepted=True,
        reason="test",
        policy="paired-deterministic",
        policy_version=1,
        baseline_score=0.5,
        candidate_score=1.0,
        baseline_split_scores={"visible": 0.5},
        candidate_split_scores={"visible": 1.0},
        regressed_case_ids=(),
    )


def _generation() -> Generation:
    return Generation(
        generation_id="gen-0001",
        parent_id="gen-0000",
        origin="evolved",
        surface="strategy-code",
        weakness_id="negative-integers-dropped",
        created_at="2026-08-06T00:00:00+00:00",
        source_ref="ab" * 32,
        decision=_decision(),
    )


ROUND_TRIP_SAMPLES = [
    TaskCase("c1", "text", 5, "visible"),
    FailureRecord("timeout", "killed after 1.0s"),
    _decision(),
    _generation(),
    Activation(
        generation_id="gen-0001",
        reason="evolved",
        mode="durable",
        at="2026-08-06T00:00:00+00:00",
        policy="paired-deterministic@1",
        expires_after_cycles=None,
        baseline_score=None,
    ),
    CycleRecord(
        run_id="run-x",
        at="2026-08-06T00:00:00+00:00",
        task_id="sum-integers",
        task_fingerprint="ff" * 32,
        generation_id="gen-0001",
        overall_score=1.0,
        split_scores={"visible": 1.0, "held_out": 1.0},
        weakness_id=None,
        candidate_generation_id=None,
        accepted=None,
        frozen=False,
        usage=BudgetUsage(wall_time_s=0.5, executions=1),
    ),
    Intervention(kind="stall-freeze", reason="flat", at="2026-08-06T00:00:00+00:00"),
    Event(ts="t", type="evaluated", run_id="run-x", payload={"k": [1, 2]}),
]


@pytest.mark.parametrize("obj", ROUND_TRIP_SAMPLES, ids=lambda o: type(o).__name__)
def test_round_trip(obj: object) -> None:
    line = codec.dumps(obj)
    assert '"schema"' in line
    assert codec.loads(line) == obj


def test_nested_decision_survives_round_trip() -> None:
    decoded: Generation = codec.loads(codec.dumps(_generation()), Generation)
    assert decoded.decision is not None
    assert decoded.decision.candidate_split_scores == {"visible": 1.0}


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


GOLDEN_V1_GENERATION = (
    '{"created_at":"2026-08-06T00:00:00+00:00","decision":null,'
    '"generation_id":"gen-0000","origin":"seed","parent_id":null,'
    '"schema":"generation@1","source_ref":"' + "ab" * 32 + '",'
    '"surface":"strategy-code","weakness_id":null}'
)


def test_golden_v1_generation_still_decodes() -> None:
    """Compatibility pin: v1 records written today must decode forever.

    If this test breaks, a contract changed shape without a version bump.
    """
    generation: Generation = codec.loads(GOLDEN_V1_GENERATION, Generation)
    assert generation.generation_id == "gen-0000"
    assert generation.decision is None
    assert codec.dumps(generation) == GOLDEN_V1_GENERATION
