from __future__ import annotations

import json

import pytest

from parallax.canonical import canonical_bytes
from parallax.checkpoint_agent import (
    AgentReplyError,
    ProviderCheckpointAgent,
    parse_file_map,
    render_stage_messages,
)
from parallax.checkpoint_runner import CheckpointDelivery, MeteredWorkspace
from parallax.outcome import BudgetError
from parallax.provider import (
    HUD_GATEWAY_ENDPOINT,
    HudGatewayProvider,
)
from parallax.provider import PRICING as _PRICING

HAIKU_PRICING = _PRICING["claude-haiku-4-5"]

MODEL = "adapter-test-model"
ENVIRONMENT = {"HUD_API_KEY": "offline-test-credential"}


def _delivery(seed_fixture, index: int = 2) -> CheckpointDelivery:
    checkpoint = seed_fixture.family.checkpoints[index - 1]
    return CheckpointDelivery(
        index=checkpoint.index,
        public_spec=checkpoint.public_spec,
        workspace=seed_fixture.references.stages[index - 2],
        max_output_bytes=checkpoint.max_output_bytes,
    )


def _reply_body(
    content: str | None,
    *,
    finish_reason: str = "stop",
    model: str = MODEL,
    usage: dict | None = None,
    tool_calls: object = None,
) -> bytes:
    message: dict[str, object] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    body: dict[str, object] = {
        "id": "adapter-test-reply",
        "model": model,
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
    }
    if usage is not None:
        body["usage"] = usage
    return json.dumps(body).encode()


class ScriptedTransport:
    def __init__(self, replies: list[bytes]) -> None:
        self.replies = replies
        self.bodies: list[bytes] = []

    def __call__(self, endpoint, body, headers, timeout_seconds) -> bytes:
        assert endpoint == HUD_GATEWAY_ENDPOINT
        self.bodies.append(body)
        return self.replies[len(self.bodies) - 1]


def _agent(
    seed_fixture,
    transport,
    *,
    expected_response_model: str = MODEL,
) -> ProviderCheckpointAgent:
    provider = HudGatewayProvider(MODEL, transport=transport, environment=ENVIRONMENT)
    return ProviderCheckpointAgent(
        provider,
        contract=seed_fixture.family.contract,
        expected_response_model=expected_response_model,
        max_output_tokens=512,
        pricing=HAIKU_PRICING,
    )


def _file_map_reply(workspace) -> str:
    return json.dumps({"files": {file.path: file.content for file in workspace.files}})


USAGE = {"prompt_tokens": 1200, "completion_tokens": 400, "total_tokens": 1600}


def test_rendered_messages_carry_public_material_only(seed_fixture) -> None:
    delivery = _delivery(seed_fixture)
    messages = render_stage_messages(seed_fixture.family.contract, delivery)
    assert [message.role for message in messages] == ["system", "user"]
    user = messages[1].content
    assert delivery.public_spec in user
    assert seed_fixture.family.contract.entry_file in user
    assert str(delivery.max_output_bytes) in user
    for file in delivery.workspace.files:
        assert file.path in user
    rendered = "".join(message.content for message in messages)
    for checkpoint in seed_fixture.family.checkpoints:
        for case in checkpoint.cases:
            assert case.case_id not in rendered
            assert canonical_bytes(case).decode() not in rendered


def test_rendering_is_a_pure_function_of_the_delivery(seed_fixture) -> None:
    delivery = _delivery(seed_fixture)
    contract = seed_fixture.family.contract
    assert render_stage_messages(contract, delivery) == render_stage_messages(
        contract, delivery
    )


def test_parse_accepts_raw_and_exact_fenced_json(seed_fixture) -> None:
    reference = seed_fixture.references.stages[-1]
    raw = _file_map_reply(reference)
    assert parse_file_map(raw) == reference
    assert parse_file_map(f"```json\n{raw}\n```") == reference


@pytest.mark.parametrize(
    "reply",
    [
        "not json at all",
        json.dumps(["files"]),
        json.dumps({"files": {"tally.py": 7}}),
        json.dumps({"files": {}, "notes": "extra key"}),
        json.dumps({"files": {"../escape.py": "print()"}}),
        json.dumps({"files": {"/absolute.py": "print()"}}),
    ],
)
def test_parse_rejects_malformed_or_unsafe_file_maps(reply: str) -> None:
    with pytest.raises(AgentReplyError):
        parse_file_map(reply)


def test_adapter_returns_metered_workspace_with_conservative_cost(
    seed_fixture,
) -> None:
    reference = seed_fixture.references.stages[1]
    transport = ScriptedTransport(
        [_reply_body(_file_map_reply(reference), usage=USAGE)]
    )
    produced = _agent(seed_fixture, transport)(_delivery(seed_fixture))
    assert isinstance(produced, MeteredWorkspace)
    assert produced.workspace == reference
    assert produced.usage.prompt_tokens == 1200
    assert produced.usage.completion_tokens == 400
    assert produced.usage.estimated_cost_usd == (1200 * 1.0 + 400 * 5.0) / 1_000_000


def test_adapter_request_is_deterministic_and_scoped(seed_fixture) -> None:
    reference = seed_fixture.references.stages[1]
    reply = _reply_body(_file_map_reply(reference), usage=USAGE)
    transport = ScriptedTransport([reply, reply])
    agent = _agent(seed_fixture, transport)
    delivery = _delivery(seed_fixture)
    agent(delivery)
    agent(delivery)
    assert transport.bodies[0] == transport.bodies[1]
    payload = json.loads(transport.bodies[0])
    assert payload["model"] == MODEL
    assert payload["max_tokens"] == 512
    assert "tools" not in payload


def test_truncated_reply_is_a_budget_fault_with_retained_usage(
    seed_fixture,
) -> None:
    transport = ScriptedTransport(
        [_reply_body('{"files"', finish_reason="length", usage=USAGE)]
    )
    with pytest.raises(BudgetError) as caught:
        _agent(seed_fixture, transport)(_delivery(seed_fixture))
    assert caught.value.stage_usage.completion_tokens == 400


def test_model_mismatch_is_rejected_with_retained_usage(seed_fixture) -> None:
    reference = seed_fixture.references.stages[1]
    transport = ScriptedTransport(
        [_reply_body(_file_map_reply(reference), usage=USAGE)]
    )
    agent = _agent(seed_fixture, transport, expected_response_model="another-model")
    with pytest.raises(AgentReplyError, match="provider reported") as caught:
        agent(_delivery(seed_fixture))
    assert caught.value.stage_usage.prompt_tokens == 1200


def test_reply_without_usage_is_unmeterable(seed_fixture) -> None:
    reference = seed_fixture.references.stages[1]
    transport = ScriptedTransport([_reply_body(_file_map_reply(reference))])
    with pytest.raises(AgentReplyError, match="unmeterable"):
        _agent(seed_fixture, transport)(_delivery(seed_fixture))


def test_null_tool_calls_wire_shape_is_tolerated(seed_fixture) -> None:
    reference = seed_fixture.references.stages[1]
    transport = ScriptedTransport(
        [_reply_body(_file_map_reply(reference), usage=USAGE, tool_calls=None)]
    )
    produced = _agent(seed_fixture, transport)(_delivery(seed_fixture))
    assert produced.workspace == reference


def test_tool_call_or_empty_replies_are_agent_faults(seed_fixture) -> None:
    tool_reply = _reply_body(
        None,
        usage=USAGE,
        tool_calls=[
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": "noop", "arguments": "{}"},
            }
        ],
    )
    for reply in (tool_reply, _reply_body("", usage=USAGE)):
        transport = ScriptedTransport([reply])
        with pytest.raises(AgentReplyError, match="non-empty text") as caught:
            _agent(seed_fixture, transport)(_delivery(seed_fixture))
        assert caught.value.stage_usage.prompt_tokens == 1200


def test_unparseable_file_map_fault_retains_usage(seed_fixture) -> None:
    transport = ScriptedTransport(
        [_reply_body("I cannot produce JSON right now.", usage=USAGE)]
    )
    with pytest.raises(AgentReplyError, match="file map") as caught:
        _agent(seed_fixture, transport)(_delivery(seed_fixture))
    assert caught.value.stage_usage.completion_tokens == 400
