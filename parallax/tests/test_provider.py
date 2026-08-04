from __future__ import annotations

import json
from collections.abc import Mapping

import pytest
from pydantic import ValidationError

from parallax.outcome import BudgetError
from parallax.provider import (
    HUD_GATEWAY_ENDPOINT,
    HudGatewayProvider,
    Message,
    OpenAICompatibleProvider,
    ProviderConfig,
    ProviderError,
    ProviderRequest,
    ProviderTool,
    ProviderToolFunction,
)


def config() -> ProviderConfig:
    return ProviderConfig(
        endpoint="https://provider.example/v1/chat/completions",
        api_key_env="PARALLAX_PROVIDER_KEY",
        model="boundary-model",
    )


def response(
    endpoint: str,
    body: bytes,
    headers: Mapping[str, str],
    timeout_seconds: float,
) -> bytes:
    payload = json.loads(body)
    assert endpoint == config().endpoint
    assert payload["max_completion_tokens"] == 64
    assert payload["model"] == "boundary-model"
    assert headers["Authorization"] == "Bearer secret"
    assert "secret" not in body.decode()
    assert timeout_seconds == 300
    return json.dumps(
        {
            "id": "response-1",
            "model": "boundary-model",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": '{"function":"inspect repository","arguments":[]}',
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            },
        }
    ).encode()


def test_openai_compatible_chat_uses_strict_wire_models() -> None:
    provider = OpenAICompatibleProvider(
        config(),
        transport=response,
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
    )

    output = provider.chat()(
        (Message(role="user", content="Extract intent."),),
        64,
    )

    assert output.startswith('{"function"')


def test_provider_accepts_explicit_null_tool_calls() -> None:
    def null_tool_calls(
        endpoint: str,
        body: bytes,
        headers: Mapping[str, str],
        timeout_seconds: float,
    ) -> bytes:
        payload = json.loads(response(endpoint, body, headers, timeout_seconds))
        payload["choices"][0]["message"]["tool_calls"] = None
        return json.dumps(payload).encode()

    provider = OpenAICompatibleProvider(
        config(),
        transport=null_tool_calls,
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
    )

    output = provider.chat()((Message(role="user", content="Extract intent."),), 64)

    assert output.startswith('{"function"')


def test_provider_request_supports_agent_tools() -> None:
    request = ProviderRequest(
        model="boundary-model",
        messages=(
            {
                "role": "user",
                "content": "Inspect the repository.",
            },
        ),
        max_output_tokens=128,
        tools=(
            ProviderTool(
                function=ProviderToolFunction(
                    name="shell",
                    description="Run a command.",
                    parameters={
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                    },
                )
            ),
        ),
    )

    assert request.tools[0].function.name == "shell"


def test_provider_boundary_rejects_coercion_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        ProviderConfig(
            endpoint="http://provider.example/v1/chat/completions",
            api_key_env="KEY",
            model="model",
        )
    with pytest.raises(ValidationError):
        ProviderConfig.model_validate(
            {
                "endpoint": "https://provider.example/v1/chat/completions",
                "api_key_env": "KEY",
                "model": "model",
                "timeout_seconds": "30",
            }
        )
    with pytest.raises(ValidationError):
        ProviderRequest.model_validate(
            {
                "model": "model",
                "messages": [{"role": "user", "content": "hello"}],
                "max_output_tokens": 10,
                "unknown": True,
            }
        )


def test_provider_rejects_missing_key_and_malformed_response() -> None:
    provider = OpenAICompatibleProvider(config(), environment={})
    with pytest.raises(ProviderError, match="missing provider credential"):
        provider.chat()((Message(role="user", content="hello"),), 32)

    provider = OpenAICompatibleProvider(
        config(),
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
        transport=lambda endpoint, body, headers, timeout: b'{"id":"bad"}',
    )
    with pytest.raises(ProviderError, match="provider response is invalid"):
        provider.chat()((Message(role="user", content="hello"),), 32)


def test_provider_response_tolerates_unconsumed_wire_fields() -> None:
    real_shaped = json.dumps(
        {
            "id": "response-1",
            "object": "chat.completion",
            "created": 1777777777,
            "model": "boundary-model-2026-08-01",
            "system_fingerprint": "fp_123",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "logprobs": None,
                    "message": {
                        "role": "assistant",
                        "content": "ready",
                        "refusal": None,
                        "annotations": [],
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
        }
    ).encode()
    provider = OpenAICompatibleProvider(
        config(),
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
        transport=lambda endpoint, body, headers, timeout: real_shaped,
    )

    assert provider.chat()((Message(role="user", content="hello"),), 32) == "ready"


def test_text_chat_classifies_output_truncation_as_budget_failure() -> None:
    truncated = json.dumps(
        {
            "id": "response-1",
            "model": "boundary-model",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "length",
                    "message": {
                        "role": "assistant",
                        "content": "partial",
                    },
                }
            ],
        }
    ).encode()
    provider = OpenAICompatibleProvider(
        config(),
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
        transport=lambda endpoint, body, headers, timeout: truncated,
    )

    with pytest.raises(BudgetError, match="output-token limit"):
        provider.chat()((Message(role="user", content="hello"),), 32)


def test_text_chat_rejects_agent_tool_calls() -> None:
    tool_response = json.dumps(
        {
            "id": "response-1",
            "model": "boundary-model",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "shell",
                                    "arguments": '{"command":"ls"}',
                                },
                            }
                        ],
                    },
                }
            ],
        }
    ).encode()
    provider = OpenAICompatibleProvider(
        config(),
        environment={"PARALLAX_PROVIDER_KEY": "secret"},
        transport=lambda endpoint, body, headers, timeout: tool_response,
    )

    with pytest.raises(ProviderError, match="non-empty text response"):
        provider.chat()((Message(role="user", content="hello"),), 32)


def test_hud_gateway_adapter_uses_existing_wire_boundary() -> None:
    def hud_response(endpoint, body, headers, timeout):
        payload = json.loads(body)
        assert endpoint == HUD_GATEWAY_ENDPOINT
        assert payload["max_tokens"] == 64
        assert "max_completion_tokens" not in payload
        assert headers["Authorization"] == "Bearer hud-secret"
        return json.dumps(
            {
                "id": "hud-response-1",
                "model": "claude-opus-4-8",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "ready",
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 1,
                    "total_tokens": 4,
                },
            }
        ).encode()

    provider = HudGatewayProvider(
        "claude-opus-4-8",
        environment={"HUD_API_KEY": "hud-secret"},
        transport=hud_response,
    )

    assert provider.chat()((Message(role="user", content="hello"),), 64) == "ready"


def test_hud_gateway_adapter_fails_before_transport_without_key() -> None:
    with pytest.raises(ProviderError, match="missing provider credential HUD_API_KEY"):
        HudGatewayProvider("claude-opus-4-8", environment={})
