"""Model interface: deterministic fake, journaled I/O, budget enforcement."""

from pathlib import Path

from strive.budget import BudgetMeter
from strive.contracts import (
    FAILURE_BUDGET_EXHAUSTED,
    BudgetSpec,
    FailureRecord,
    ModelRequest,
    ModelResponse,
)
from strive.events import EventLog
from strive.model import FakeModelAdapter, MeteredJournalingAdapter


def test_fake_adapter_is_deterministic() -> None:
    adapter = FakeModelAdapter()
    request = ModelRequest(prompt="improve this strategy", seed=7)
    first = adapter.complete(request)
    second = adapter.complete(request)
    assert first == second
    assert first.text.startswith("fake-completion:")
    different_seed = adapter.complete(ModelRequest(prompt="improve this strategy", seed=8))
    assert different_seed.text != first.text


def test_fake_adapter_scripted_responses() -> None:
    adapter = FakeModelAdapter(script={"fix the regex": "use -?\\d+"})
    response = adapter.complete(ModelRequest(prompt="fix the regex"))
    assert response.text == "use -?\\d+"


def test_metered_adapter_journals_and_charges(tmp_path: Path) -> None:
    meter = BudgetMeter(BudgetSpec(model_calls=1, tokens=10_000))
    events = EventLog(tmp_path / "events.jsonl", "run-x")
    adapter = MeteredJournalingAdapter(FakeModelAdapter(), meter, events)

    first = adapter.complete(ModelRequest(prompt="hello"))
    assert isinstance(first, ModelResponse)
    usage = meter.usage()
    assert usage.model_calls == 1 and usage.tokens > 0

    # second call exceeds the ceiling: failure-as-data, journaled, not raised
    second = adapter.complete(ModelRequest(prompt="hello again"))
    assert isinstance(second, FailureRecord)
    assert second.kind == FAILURE_BUDGET_EXHAUSTED

    types = [event.type for event in events.read_all()]
    assert types.count("model_call") == 1
    assert types.count("model_call_denied") == 1
    # the journal carries the full request/response for replay
    journaled = [e for e in events.read_all() if e.type == "model_call"][0]
    assert "request" in journaled.payload and "response" in journaled.payload
