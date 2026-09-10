"""Host regressions for adapter logic; these never import or execute tau2."""
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError
import pytest

from strive_benchmark_tau2.native_worker import generation_request, reference_trajectory, tool_results_message


# Schema-only stand-ins verified against the pinned source, not tau2 imports:
# https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/data_model/message.py#L519-L565
# ToolRole is Literal["tool"] at line 20. Keep both roles required, without defaults.
class PinnedToolMessage(BaseModel):
    id: str
    role: Literal["tool"]
    content: str | None = None
    requestor: Literal["user", "assistant"] = "assistant"
    error: bool = False
    turn_idx: int | None = None
    timestamp: str | None = Field(default_factory=lambda: datetime.now().isoformat())


class PinnedMultiToolMessage(BaseModel):
    role: Literal["tool"]
    tool_messages: list[PinnedToolMessage]


@pytest.fixture
def recorded_tool_results(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    messages = ModuleType("tau2.data_model.message")
    setattr(messages, "MultiToolMessage", PinnedMultiToolMessage)
    monkeypatch.setitem(sys.modules, messages.__name__, messages)
    recording = json.loads(Path(__file__).with_name("fixtures").joinpath("tau2_recorded_generations.json").read_text())
    # The simulator flips the recorded assistant tool call to a user call.
    # Author a tool response in the same model_dump shape as env.get_response.
    return [{"id": recording["user_tool"]["tool_calls"][0]["id"], "role": "tool", "requestor": "user",
             "content": '{"timestamp":"device-event-time","status":"toggled"}',
             "error": False, "turn_idx": 3, "timestamp": "first-execution-time"}]


@pytest.mark.parametrize("batch_size", [1, 2])
def test_recorded_tool_batch_reconstructs_required_fields_without_timestamps(
    recorded_tool_results: list[dict[str, Any]], batch_size: int,
) -> None:
    results = recorded_tool_results
    if batch_size == 2:
        results.append({**results[0], "id": "second-call", "error": True, "content": "tool failed"})
    original = deepcopy(results)
    # This is the worker's producer after the final separately authorized tool
    # operation. JSON round-trip reproduces reopening its committed snapshot.
    incoming = json.loads(json.dumps(tool_results_message(results)))
    assert set(incoming) == {"role", "tool_messages"}
    assert incoming["role"] == "tool"
    assert incoming["tool_messages"] == [{k: v for k, v in result.items() if k != "timestamp"} for result in results]
    reconstructed = PinnedMultiToolMessage.model_validate(incoming)
    assert [m.id for m in reconstructed.tool_messages] == [r["id"] for r in results]
    assert all(m.role == "tool" and m.requestor == "user" for m in reconstructed.tool_messages)
    assert results == original

    # Reconstruction regenerates metadata. Both a batch and the flattened
    # tool history passed to generate must still produce the same capture.
    for index, messages in enumerate(([reconstructed], reconstructed.tool_messages)):
        kwargs: dict[str, Any] = {"model": "recorded", "messages": messages, "tools": []}
        planned = generation_request(kwargs)
        for message in reconstructed.tool_messages:
            message.timestamp = f"later-execution-time-{index}"
        assert generation_request(kwargs) == planned
    assert generation_request({"model": "recorded", "messages": [reconstructed], "tools": []})["messages"] == [incoming]

    # The exact former producer shape must fail, so the stand-in cannot hide
    # the Linux failure by supplying a default role.
    with pytest.raises(ValidationError) as missing:
        PinnedMultiToolMessage.model_validate({"tool_messages": incoming["tool_messages"]})
    assert missing.value.errors()[0]["loc"] == ("role",)
    assert missing.value.errors()[0]["type"] == "missing"


@pytest.mark.parametrize("field", ["id", "role"])
def test_tool_batch_producer_rejects_missing_result_fields(
    recorded_tool_results: list[dict[str, Any]], field: str,
) -> None:
    del recorded_tool_results[0][field]
    with pytest.raises(ValidationError) as missing:
        tool_results_message(recorded_tool_results)
    assert missing.value.errors()[0]["loc"] == ("tool_messages", 0, field)
    assert missing.value.errors()[0]["type"] == "missing"


@pytest.mark.parametrize("field,value", [("id", "other-call"), ("requestor", "assistant"),
                                        ("content", "different result"), ("error", True), ("turn_idx", 4)])
def test_tool_batch_capture_binds_result_fields(
    recorded_tool_results: list[dict[str, Any]], field: str, value: object,
) -> None:
    planned = tool_results_message(recorded_tool_results)
    recorded_tool_results[0][field] = value
    assert tool_results_message(recorded_tool_results) != planned


class CapturedMessage(BaseModel):
    role: str
    content: str | None = None
    timestamp: str = Field(default_factory=lambda: datetime.now().isoformat())
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)


def test_user_plan_survives_reconstructed_message_timestamps() -> None:
    call = {"id": "call", "name": "schedule", "arguments": {"timestamp": "appointment-time"}}
    kwargs: dict[str, Any] = {"model": "recorded", "messages": [CapturedMessage(role="assistant", tool_calls=[call])],
              "tools": [SimpleNamespace(openai_schema={"type": "function", "function": {"name": "schedule"}})],
              "temperature": 0, "call_name": "user_simulator_response"}
    planned = generation_request(kwargs)
    repeated = deepcopy(kwargs)
    repeated["messages"] = [CapturedMessage(role="assistant", tool_calls=[call], timestamp="later")]
    assert generation_request(repeated) == planned
    assert planned["messages"][0]["tool_calls"][0]["arguments"]["timestamp"] == "appointment-time"
    assert kwargs["messages"][0].timestamp


@pytest.mark.parametrize("field", ["model", "content", "arguments", "call_id", "role", "tools", "settings"])
def test_user_plan_still_binds_every_request_input(field: str) -> None:
    kwargs: dict[str, Any] = {"model": "recorded", "messages": [CapturedMessage(role="assistant", content="confirm",
        tool_calls=[{"id": "call", "name": "schedule", "arguments": {"timestamp": "appointment-time"}}])],
        "tools": [SimpleNamespace(openai_schema={"name": "schedule"})], "temperature": 0}
    planned = generation_request(kwargs)
    if field == "model":
        kwargs["model"] = "different-model"
    elif field in {"content", "role"}:
        setattr(kwargs["messages"][0], field, "different")
    elif field == "arguments":
        kwargs["messages"][0].tool_calls[0]["arguments"]["timestamp"] = "different-time"
    elif field == "call_id":
        kwargs["messages"][0].tool_calls[0]["id"] = "different-call"
    elif field == "tools":
        kwargs["tools"] = []
    else:
        kwargs["temperature"] = 1
    assert generation_request(kwargs) != planned


class ReferenceEnvironment:
    """A reference sequence whose second action needs synchronized credit."""
    def __init__(self) -> None:
        self.agent_credit = 0
        self.user_credit = 0
        self.calls: list[str] = []

    def get_response(self, call: Any) -> SimpleNamespace:
        self.calls.append(call.name)
        if call.name == "refuel":
            self.agent_credit += call.arguments["amount"]
        elif call.name != "use_data" or not self.user_credit:
            return SimpleNamespace(id=call.id, role="tool", error=True, content="no synchronized credit")
        self.user_credit = self.agent_credit
        return SimpleNamespace(id=call.id, role="tool", requestor=call.requestor, error=False, content="ok")


@pytest.fixture
def reference_task(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    # Only message containers are substituted. No upstream package is loaded.
    messages = ModuleType("tau2.data_model.message")
    for name in ("ToolCall", "AssistantMessage", "UserMessage"):
        setattr(messages, name, SimpleNamespace)
    monkeypatch.setitem(sys.modules, messages.__name__, messages)
    return SimpleNamespace(initial_state=SimpleNamespace(message_history=[SimpleNamespace(role="user", content="help")]),
        evaluation_criteria=SimpleNamespace(actions=[
            SimpleNamespace(action_id="credit", name="refuel", requestor="assistant", arguments={"amount": 2}),
            SimpleNamespace(action_id="data", name="use_data", requestor="user", arguments={})]))


def test_reference_records_synchronized_calls_and_initial_history(reference_task: SimpleNamespace) -> None:
    environment = ReferenceEnvironment()
    trajectory = reference_trajectory(reference_task, environment)
    assert environment.agent_credit == environment.user_credit == 2
    assert environment.calls == ["refuel", "use_data"]
    assert [message.role for message in trajectory] == ["user", "assistant", "tool", "user", "tool"]
    assert trajectory[1].tool_calls[0].id == trajectory[2].id == "credit"
    assert trajectory[3].tool_calls[0].id == trajectory[4].id == "data"
    assert len(reference_task.initial_state.message_history) == 1


def test_reference_action_error_cannot_qualify(reference_task: SimpleNamespace) -> None:
    reference_task.evaluation_criteria.actions.reverse()
    environment = ReferenceEnvironment()
    with pytest.raises(ValueError, match=r"reference action data \(use_data\) failed: no synchronized credit"):
        reference_trajectory(reference_task, environment)
    assert environment.calls == ["use_data"]
