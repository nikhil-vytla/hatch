"""ModelPolicy: any provider behind one client method; replay needs no provider."""

from typing import Any

import pytest

from orrery import engine
from orrery.models import ModelResponse, PlaybookClient
from orrery.plugins import build_registry
from orrery.spec import PolicySpec, WorldSpec


class RaisingClient:
    """A 'provider' that must never be contacted (used to prove replay isolation)."""

    async def complete(self, system: str, messages: Any, tools: Any) -> ModelResponse:
        raise AssertionError("model client was called during replay")


MODEL_AGENT_SCRIPT = [
    {
        "tool_calls": [
            {
                "name": "call_tool",
                "arguments": {"tool": "billing.lookup", "args": {"account": "account-1001"}},
            }
        ]
    },
    {
        "tool_calls": [
            {
                "name": "call_tool",
                "arguments": {"tool": "billing.update", "args": {"account": "account-1001"}},
            }
        ]
    },
    {
        "text": "Fixed.",
        "tool_calls": [
            {
                "name": "set_fact",
                "arguments": {"entity_id": "account-1001", "attr": "billing_ok", "value": True},
            },
            {
                "name": "set_fact",
                "arguments": {"entity_id": "ticket-1", "attr": "status", "value": "resolved"},
            },
            {
                "name": "send_message",
                "arguments": {"to": "customer-1", "text": "Your billing issue is resolved."},
            },
        ],
    },
]


def model_driven_support_spec() -> WorldSpec:
    """The generated support world, with the rule-based agent swapped for a
    model-driven one — the SUT policy is data, so this is a two-line change."""
    registry = build_registry(uses=["orrery.domains.support"])
    spec = registry.generators["support_desk"]({"chaos": False}, 5)
    agent = next(a for a in spec.actors if a.id == "agent-1")
    agent.policy = PolicySpec(
        type="model",
        params={
            "client": {"type": "playbook", "params": {"script": MODEL_AGENT_SCRIPT}},
            "system_prompt": "You are a support agent.",
            "default_recipient": "customer-1",
        },
    )
    return spec


async def test_model_agent_passes_support_contract() -> None:
    spec = model_driven_support_spec()
    result = await engine.run(spec, seed=5)
    assert result.passed, [(v.name, v.status, v.details) for v in result.verdicts]
    # The model's conversation history was actor-private memory, not world state.
    assert "history" not in result.trace.final_state


async def test_replay_of_model_run_never_calls_provider() -> None:
    spec = model_driven_support_spec()
    live = await engine.run(spec, seed=5)

    replay_registry = build_registry(uses=spec.uses)
    replay_registry.model_clients["playbook"] = lambda params: RaisingClient()
    replayed = await engine.replay(spec, live.trace, registry=replay_registry)
    assert replayed.trace.event_fingerprint == live.trace.event_fingerprint


async def test_playbook_exhaustion_is_quiescence() -> None:
    client = PlaybookClient(script=[])
    response = await client.complete("", [], [])
    assert response == ModelResponse()


def test_unknown_model_client_is_a_clear_error() -> None:
    registry = build_registry()
    with pytest.raises(KeyError, match="no model client"):
        registry.policies["model"]({"client": {"type": "gpt-nonexistent"}})
