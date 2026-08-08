"""Model interface: deterministic fake, finish reasons, compact CAS-ref
journaling, budget enforcement, env-adapter configuration errors."""

import os
from pathlib import Path

import pytest

from strive.budget import BudgetMeter
from strive.cas import ObjectStore
from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    FINISH_LENGTH,
    FINISH_STOP,
    BudgetSpec,
    FailureRecord,
    ModelRequest,
    ModelResponse,
)
from strive.events import EventLog
from strive.model import (
    FakeModelAdapter,
    MeteredJournalingAdapter,
    ModelConfigError,
    adapter_from_env,
)


def _wrapped(
    tmp_path: Path, spec: BudgetSpec
) -> tuple[MeteredJournalingAdapter, BudgetMeter, EventLog, ObjectStore]:
    meter = BudgetMeter(spec)
    events = EventLog(tmp_path / "events.jsonl", "run-x")
    objects = ObjectStore(tmp_path / "objects")
    return MeteredJournalingAdapter(FakeModelAdapter(), meter, events, objects), meter, events, objects


def test_fake_adapter_is_deterministic() -> None:
    adapter = FakeModelAdapter()
    request = ModelRequest(prompt="improve this strategy", seed=7)
    first = adapter.complete(request)
    second = adapter.complete(request)
    assert first == second
    assert first.text.startswith("fake-completion:")
    assert first.finish_reason == FINISH_STOP
    different_seed = adapter.complete(ModelRequest(prompt="improve this strategy", seed=8))
    assert different_seed.text != first.text


def test_fake_adapter_reports_length_finish_on_truncation() -> None:
    adapter = FakeModelAdapter(script={"p": "x" * 400})
    response = adapter.complete(ModelRequest(prompt="p", max_tokens=10))
    assert response.finish_reason == FINISH_LENGTH
    assert response.output_tokens == 10


def test_metered_adapter_journals_compact_metadata_with_cas_refs(tmp_path: Path) -> None:
    adapter, meter, events, objects = _wrapped(tmp_path, BudgetSpec(model_calls=1))
    response = adapter.complete(ModelRequest(prompt="hello prompt"))
    assert isinstance(response, ModelResponse)
    assert meter.usage().model_calls == 1 and meter.usage().tokens > 0

    journaled = [e for e in events.read_all() if e.type == "model_call"]
    assert len(journaled) == 1
    payload = journaled[0].payload
    # compact metadata + CAS refs — no duplicated full contents in the event
    assert "request" not in payload and "response" not in payload
    assert payload["finish_reason"] == FINISH_STOP
    assert payload["adapter"] == "fake"
    assert isinstance(payload["latency_ms"], float)
    assert objects.get_text(str(payload["prompt_ref"])) == "hello prompt"
    assert objects.get_text(str(payload["completion_ref"])) == response.text


def test_metered_adapter_denies_beyond_call_budget(tmp_path: Path) -> None:
    adapter, meter, events, _ = _wrapped(tmp_path, BudgetSpec(model_calls=1))
    first = adapter.complete(ModelRequest(prompt="a"))
    assert isinstance(first, ModelResponse)
    second = adapter.complete(ModelRequest(prompt="b"))
    assert isinstance(second, FailureRecord)
    assert second.kind == FAILURE_BUDGET_EXHAUSTED
    types = [e.type for e in events.read_all()]
    assert types.count("model_call") == 1 and types.count("model_call_denied") == 1


def test_metered_adapter_caps_timeout_to_remaining_wall(tmp_path: Path) -> None:
    class TimeoutProbe:
        adapter_name = "probe"
        model_id = "probe-v1"
        reports_cost = True

        def __init__(self) -> None:
            self.seen_timeout: float | None = None

        def complete(self, request: ModelRequest) -> ModelResponse:
            self.seen_timeout = request.timeout_s
            return ModelResponse(
                text="ok", model_id=self.model_id, input_tokens=1, output_tokens=1
            )

    probe = TimeoutProbe()
    meter = BudgetMeter(BudgetSpec(model_calls=1, wall_time_s=5.0))
    adapter = MeteredJournalingAdapter(
        probe,
        meter,
        EventLog(tmp_path / "events.jsonl", "run-x"),
        ObjectStore(tmp_path / "objects"),
    )
    adapter.complete(ModelRequest(prompt="p", timeout_s=600.0))
    assert probe.seen_timeout is not None and probe.seen_timeout <= 5.0


def test_adapter_error_is_contained_and_journaled(tmp_path: Path) -> None:
    class ExplodingAdapter:
        adapter_name = "exploding"
        model_id = "exploding-v1"
        reports_cost = True

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise OSError("connection refused")

    meter = BudgetMeter(BudgetSpec(model_calls=1))
    events = EventLog(tmp_path / "events.jsonl", "run-x")
    adapter = MeteredJournalingAdapter(
        ExplodingAdapter(), meter, events, ObjectStore(tmp_path / "objects")
    )
    outcome = adapter.complete(ModelRequest(prompt="p"))
    assert isinstance(outcome, FailureRecord)
    assert outcome.kind == "model-error"
    assert any(e.type == "model_call_failed" for e in events.read_all())


# -- env-adapter configuration --------------------------------------------------


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "STRIVE_MODEL_PROVIDER",
        "STRIVE_MODEL_BASE_URL",
        "STRIVE_MODEL_API_KEY",
        "STRIVE_MODEL_ID",
    ):
        monkeypatch.delenv(name, raising=False)


def test_no_env_means_no_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    assert adapter_from_env() is None


def test_unknown_provider_is_a_clean_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("STRIVE_MODEL_PROVIDER", "mystery-cloud")
    with pytest.raises(ModelConfigError, match="unknown STRIVE_MODEL_PROVIDER"):
        adapter_from_env()


def test_missing_variables_are_a_clean_config_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("STRIVE_MODEL_PROVIDER", "openai-compatible")
    monkeypatch.setenv("STRIVE_MODEL_BASE_URL", "http://localhost:9")
    with pytest.raises(
        ModelConfigError, match="missing: STRIVE_MODEL_API_KEY, STRIVE_MODEL_ID"
    ):
        adapter_from_env()


def test_requested_output_tokens_are_capped_to_remaining_allowance(
    tmp_path: Path,
) -> None:
    class CapProbe:
        adapter_name = "probe"
        model_id = "probe-v1"
        reports_cost = True

        def __init__(self) -> None:
            self.seen_max_tokens: int | None = None

        def complete(self, request: ModelRequest) -> ModelResponse:
            self.seen_max_tokens = request.max_tokens
            return ModelResponse(
                text="ok", model_id=self.model_id, input_tokens=1, output_tokens=1
            )

    probe = CapProbe()
    meter = BudgetMeter(BudgetSpec(model_calls=2, tokens=50))
    adapter = MeteredJournalingAdapter(
        probe, meter, EventLog(tmp_path / "e.jsonl", "r"), ObjectStore(tmp_path / "o")
    )
    adapter.complete(ModelRequest(prompt="p", max_tokens=4096))
    assert probe.seen_max_tokens == 50  # capped to remaining token allowance


def test_token_overrun_rejects_the_completion_and_is_journaled(tmp_path: Path) -> None:
    """Input tokens can overshoot a token limit in a single call; the overrun
    is charged and journaled, and the completion never reaches a proposer."""

    class HugeInputAdapter:
        adapter_name = "huge"
        model_id = "huge-v1"
        reports_cost = True

        def complete(self, request: ModelRequest) -> ModelResponse:
            return ModelResponse(
                text='{"would": "be a proposal"}',
                model_id=self.model_id,
                input_tokens=10_000,
                output_tokens=1,
            )

    meter = BudgetMeter(BudgetSpec(model_calls=2, tokens=100))
    events = EventLog(tmp_path / "e.jsonl", "r")
    adapter = MeteredJournalingAdapter(
        HugeInputAdapter(), meter, events, ObjectStore(tmp_path / "o")
    )
    outcome = adapter.complete(ModelRequest(prompt="p"))
    assert isinstance(outcome, FailureRecord)
    assert outcome.kind == FAILURE_BUDGET_EXHAUSTED
    assert "overrunning call's completion is rejected" in outcome.detail
    types = [e.type for e in events.read_all()]
    assert "model_call" in types and "model_call_overrun" in types
    assert meter.usage().tokens == 10_001  # the overrun is still accounted


def test_cost_limit_fails_closed_when_adapter_cannot_report_cost(
    tmp_path: Path,
) -> None:
    class NoCostAdapter:
        adapter_name = "no-cost"
        model_id = "no-cost-v1"
        reports_cost = False

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise AssertionError("must never be called under a cost limit")

    meter = BudgetMeter(BudgetSpec(model_calls=2, cost=5.0))
    events = EventLog(tmp_path / "e.jsonl", "r")
    adapter = MeteredJournalingAdapter(
        NoCostAdapter(), meter, events, ObjectStore(tmp_path / "o")
    )
    outcome = adapter.complete(ModelRequest(prompt="p"))
    assert isinstance(outcome, FailureRecord)
    assert outcome.kind == "cost-limit-unavailable"
    assert any(e.type == "model_call_denied" for e in events.read_all())


def test_any_ordinary_adapter_exception_becomes_model_error(tmp_path: Path) -> None:
    class WeirdErrorAdapter:
        adapter_name = "weird"
        model_id = "weird-v1"
        reports_cost = True

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise RuntimeError("unexpected provider tantrum")

    meter = BudgetMeter(BudgetSpec(model_calls=1))
    events = EventLog(tmp_path / "e.jsonl", "r")
    adapter = MeteredJournalingAdapter(
        WeirdErrorAdapter(), meter, events, ObjectStore(tmp_path / "o")
    )
    outcome = adapter.complete(ModelRequest(prompt="p"))
    assert isinstance(outcome, FailureRecord) and outcome.kind == "model-error"
    assert any(e.type == "model_call_failed" for e in events.read_all())


def test_keyboard_interrupt_propagates_through_the_wrapper(tmp_path: Path) -> None:
    class InterruptedAdapter:
        adapter_name = "interrupted"
        model_id = "interrupted-v1"
        reports_cost = True

        def complete(self, request: ModelRequest) -> ModelResponse:
            raise KeyboardInterrupt

    meter = BudgetMeter(BudgetSpec(model_calls=1))
    adapter = MeteredJournalingAdapter(
        InterruptedAdapter(),
        meter,
        EventLog(tmp_path / "e.jsonl", "r"),
        ObjectStore(tmp_path / "o"),
    )
    with pytest.raises(KeyboardInterrupt):
        adapter.complete(ModelRequest(prompt="p"))


def test_budget_semantics_are_recorded_per_limit() -> None:
    from strive.budget import UNLIMITED

    semantics = BudgetMeter(
        BudgetSpec(tokens=100, cost=UNLIMITED, model_calls=2)
    ).semantics()
    assert semantics["tokens"] == "enforced-between-calls+output-cap"
    assert semantics["cost"] == "accounting-only"
    assert semantics["model_calls"] == "enforced"
