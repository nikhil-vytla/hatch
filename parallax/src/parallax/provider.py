from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Annotated, Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    ValidationError,
    field_validator,
)

from .evolving_intent import Chat, Message
from .outcome import BudgetError
from .types import NonEmptyText, PositiveInt, StrictModel

HttpUrl = Annotated[str, StringConstraints(pattern=r"^https://")]
HUD_GATEWAY_ENDPOINT = "https://inference.beta.hud.ai/v1/chat/completions"


class ProviderError(RuntimeError):
    pass


class ProviderConfig(StrictModel):
    endpoint: HttpUrl
    api_key_env: NonEmptyText
    model: NonEmptyText
    timeout_seconds: Annotated[float, Field(gt=0, allow_inf_nan=False)] = 300.0
    token_field: Literal["max_tokens", "max_completion_tokens"] = (
        "max_completion_tokens"
    )


class ProviderMessage(StrictModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None
    tool_call_id: str | None = None


class ProviderToolFunction(StrictModel):
    name: NonEmptyText
    description: str
    parameters: dict[str, JsonValue]


class ProviderTool(StrictModel):
    type: Literal["function"] = "function"
    function: ProviderToolFunction


class ProviderResponseModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="ignore")


class ProviderRequest(StrictModel):
    model: NonEmptyText
    messages: Annotated[tuple[ProviderMessage, ...], Field(min_length=1)]
    max_output_tokens: PositiveInt
    temperature: Annotated[float, Field(ge=0, le=2, allow_inf_nan=False)] = 0.0
    tools: tuple[ProviderTool, ...] = ()


class ProviderFunctionCall(ProviderResponseModel):
    name: NonEmptyText
    arguments: str


class ProviderToolCall(ProviderResponseModel):
    id: NonEmptyText
    type: Literal["function"] = "function"
    function: ProviderFunctionCall


class ProviderResponseMessage(ProviderResponseModel):
    role: Literal["assistant"]
    content: str | None
    tool_calls: tuple[ProviderToolCall, ...] = ()

    @field_validator("tool_calls", mode="before")
    @classmethod
    def null_tool_calls_are_empty(cls, value: object) -> object:
        if value is None:
            return ()
        if isinstance(value, list):
            return tuple(value)
        return value


class ProviderChoice(ProviderResponseModel):
    index: Annotated[int, Field(ge=0)]
    finish_reason: str | None
    message: ProviderResponseMessage


class ProviderUsage(ProviderResponseModel):
    prompt_tokens: Annotated[int, Field(ge=0)]
    completion_tokens: Annotated[int, Field(ge=0)]
    total_tokens: Annotated[int, Field(ge=0)]


class ProviderResponse(ProviderResponseModel):
    id: NonEmptyText
    model: NonEmptyText
    choices: Annotated[tuple[ProviderChoice, ...], Field(min_length=1)]
    usage: ProviderUsage | None = None


Transport: TypeAlias = Callable[
    [str, bytes, Mapping[str, str], float],
    bytes,
]


def _http_post(
    endpoint: str,
    body: bytes,
    headers: Mapping[str, str],
    timeout_seconds: float,
) -> bytes:
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers=dict(headers),
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return response.read()


class OpenAICompatibleProvider:
    def __init__(
        self,
        config: ProviderConfig,
        *,
        transport: Transport = _http_post,
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.config = config
        self._transport = transport
        self._environment = environment if environment is not None else os.environ

    def complete(self, request: ProviderRequest) -> ProviderResponse:
        api_key = self._environment.get(self.config.api_key_env)
        if not api_key:
            raise ProviderError(
                f"missing provider credential {self.config.api_key_env}"
            )
        payload: dict[str, object] = {
            "model": request.model,
            "messages": [
                message.model_dump(mode="json", exclude_none=True)
                for message in request.messages
            ],
            "temperature": request.temperature,
            self.config.token_field: request.max_output_tokens,
        }
        if request.tools:
            payload["tools"] = [tool.model_dump(mode="json") for tool in request.tools]
        body = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
        try:
            response = self._transport(
                self.config.endpoint,
                body,
                {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                self.config.timeout_seconds,
            )
            return ProviderResponse.model_validate_json(response)
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as error:
            raise ProviderError(f"provider request failed: {error}") from error
        except ValidationError as error:
            detail = error.errors(include_url=False)[0]["msg"]
            raise ProviderError(f"provider response is invalid: {detail}") from error

    def text_completion(
        self,
        messages: tuple[Message, ...],
        max_output_tokens: int,
    ) -> tuple[str, ProviderResponse]:
        response = self.complete(
            ProviderRequest(
                model=self.config.model,
                messages=tuple(
                    ProviderMessage(role=message.role, content=message.content)
                    for message in messages
                ),
                max_output_tokens=max_output_tokens,
            )
        )
        if len(response.choices) != 1:
            raise ProviderError("text chat requires exactly one provider choice")
        choice = response.choices[0]
        if choice.finish_reason == "length":
            raise BudgetError("provider response reached its output-token limit")
        if choice.message.tool_calls or not choice.message.content:
            raise ProviderError("text chat requires one non-empty text response")
        return choice.message.content, response

    def chat(self) -> Chat:
        return lambda messages, max_output_tokens: self.text_completion(
            messages, max_output_tokens
        )[0]


class HudGatewayProvider(OpenAICompatibleProvider):
    def __init__(
        self,
        model: str,
        *,
        transport: Transport = _http_post,
        environment: Mapping[str, str] | None = None,
        timeout_seconds: float = 300.0,
    ) -> None:
        selected_environment = environment if environment is not None else os.environ
        if not selected_environment.get("HUD_API_KEY"):
            raise ProviderError("missing provider credential HUD_API_KEY")
        super().__init__(
            ProviderConfig(
                endpoint=HUD_GATEWAY_ENDPOINT,
                api_key_env="HUD_API_KEY",
                model=model,
                timeout_seconds=timeout_seconds,
                token_field="max_tokens",
            ),
            transport=transport,
            environment=selected_environment,
        )
