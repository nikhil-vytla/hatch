"""Model & provider integration (ADR-0007).

The contract is deliberately tiny: a provider is anything implementing
`ModelClient.complete()` — one async method from (system, messages, tools)
to (text, tool_calls). Anthropic, OpenAI-compatible endpoints, local
runtimes, or a deterministic playbook for tests are all ~40-line adapters.

`ModelPolicy` turns any such model into an Orrery actor. One model call per
activation; the model's tool calls become intents; the event-driven kernel
delivers tool results as the *next* observation. Because the engine records
every Decision, replaying a model-driven run never contacts a provider —
determinism holds regardless of how nondeterministic the model is.
"""

from __future__ import annotations

import json
import os
from typing import Any, Protocol

from pydantic import BaseModel, Field

from orrery.actors import Decision, DecisionContext
from orrery.content import flatten_text
from orrery.events import Intent
from orrery.surfaces import Observation


class ToolCall(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ModelResponse(BaseModel):
    text: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)


class ModelClient(Protocol):
    async def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]],
    ) -> ModelResponse: ...


# Provider-neutral action set exposed to the model (Anthropic-style
# input_schema; OpenAI-compatible adapters convert in their client).
ACTION_TOOLS: list[dict[str, Any]] = [
    {
        "name": "send_message",
        "description": "Send a message to another actor in the world.",
        "input_schema": {
            "type": "object",
            "properties": {"to": {"type": "string"}, "text": {"type": "string"}},
            "required": ["to", "text"],
        },
    },
    {
        "name": "call_tool",
        "description": "Invoke a world tool by name with JSON arguments.",
        "input_schema": {
            "type": "object",
            "properties": {"tool": {"type": "string"}, "args": {"type": "object"}},
            "required": ["tool"],
        },
    },
    {
        "name": "set_fact",
        "description": "Set an attribute on an entity you are allowed to modify.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string"},
                "attr": {"type": "string"},
                "value": {},
            },
            "required": ["entity_id", "attr", "value"],
        },
    },
]


def action_to_intent(call: ToolCall) -> Intent | None:
    """Map a model action tool call onto a kernel intent."""
    args = call.arguments
    match call.name:
        case "send_message":
            return Intent(
                kind="send_message",
                payload={
                    "to": args["to"],
                    "content": [{"kind": "text", "text": str(args.get("text", ""))}],
                },
            )
        case "call_tool":
            return Intent(
                kind="call_tool", payload={"tool": args["tool"], "args": args.get("args", {})}
            )
        case "set_fact":
            return Intent(
                kind="set_fact",
                payload={
                    "entity_id": args["entity_id"],
                    "attr": args["attr"],
                    "value": args.get("value"),
                },
            )
    return None


class ModelPolicy:
    """An actor policy driven by any chat+tool-calling model.

    Conversation history is kept as plain text turns (assistant tool calls
    are serialized inline) — a v0 simplification that keeps the history
    provider-portable; see ADR-0007 for the fidelity tradeoff.
    """

    def __init__(
        self,
        client: ModelClient,
        system_prompt: str = "",
        default_recipient: str | None = None,
    ) -> None:
        self._client = client
        self._system = system_prompt
        self._default_recipient = default_recipient

    async def decide(self, obs: Observation, ctx: DecisionContext) -> Decision:
        history: list[dict[str, str]] = ctx.memory.setdefault("history", [])
        if not obs.view.events and history:
            return Decision()  # duplicate wake-up with nothing new: don't burn a call

        history.append({"role": "user", "content": flatten_text(obs.parts)})
        response = await self._client.complete(self._system, list(history), ACTION_TOOLS)

        recorded = response.text
        if response.tool_calls:
            calls = "; ".join(f"{c.name}({json.dumps(c.arguments)})" for c in response.tool_calls)
            recorded = f"{recorded}\n[actions: {calls}]".strip()
        history.append({"role": "assistant", "content": recorded or "(no action)"})

        intents = [
            intent for call in response.tool_calls if (intent := action_to_intent(call)) is not None
        ]
        if not intents and response.text and self._default_recipient:
            intents.append(
                Intent(
                    kind="send_message",
                    payload={
                        "to": self._default_recipient,
                        "content": [{"kind": "text", "text": response.text}],
                    },
                )
            )
        return Decision(intents=intents)


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------


class PlaybookClient:
    """Deterministic scripted 'model': returns canned responses in order.

    The test double for ModelPolicy, and the reference for how little a
    provider adapter must implement.
    """

    def __init__(self, script: list[dict[str, Any]]) -> None:
        self._script = [ModelResponse.model_validate(item) for item in script]
        self._index = 0

    async def complete(
        self, system: str, messages: list[dict[str, str]], tools: list[dict[str, Any]]
    ) -> ModelResponse:
        if self._index >= len(self._script):
            return ModelResponse()
        response = self._script[self._index]
        self._index += 1
        return response


class AnthropicClient:
    """Claude adapter. Requires the `anthropic` package and an API key.

    Imported lazily so the core install stays dependency-light; never
    exercised by the test suite (tests use PlaybookClient — and replay of a
    live trace doesn't need this class at all).
    """

    def __init__(self, model: str = "claude-sonnet-5", max_tokens: int = 1024) -> None:
        self._model = model
        self._max_tokens = max_tokens
        self._client: Any = None

    async def complete(
        self, system: str, messages: list[dict[str, str]], tools: list[dict[str, Any]]
    ) -> ModelResponse:
        if self._client is None:
            try:
                import anthropic  # pyright: ignore[reportMissingImports]
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError(
                    "AnthropicClient requires `uv add anthropic` and ANTHROPIC_API_KEY"
                ) from exc
            self._client = anthropic.AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        result = await self._client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=system or "You are an agent acting in a simulated world.",
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
            tools=tools,
        )
        text_chunks: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in result.content:
            if block.type == "text":
                text_chunks.append(block.text)
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(name=block.name, arguments=dict(block.input)))
        return ModelResponse(text="\n".join(text_chunks), tool_calls=tool_calls)


def register(registry: Any) -> None:
    registry.model_clients["playbook"] = lambda params: PlaybookClient(params["script"])
    registry.model_clients["anthropic"] = lambda params: AnthropicClient(
        model=params.get("model", "claude-sonnet-5"),
        max_tokens=int(params.get("max_tokens", 1024)),
    )

    def model_policy(params: dict[str, Any]) -> ModelPolicy:
        client_spec = params["client"]
        client_factory = registry.model_clients.get(client_spec["type"])
        if client_factory is None:
            known = ", ".join(sorted(registry.model_clients))
            raise KeyError(f"no model client {client_spec['type']!r}; known: {known}")
        return ModelPolicy(
            client=client_factory(client_spec.get("params", {})),
            system_prompt=params.get("system_prompt", ""),
            default_recipient=params.get("default_recipient"),
        )

    registry.policies["model"] = model_policy
