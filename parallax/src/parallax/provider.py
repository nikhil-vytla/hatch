from __future__ import annotations

import json
import os
import re
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

from .outcome import BudgetError
from .types import NonEmptyText, PositiveInt, StrictModel

HttpUrl = Annotated[str, StringConstraints(pattern=r"^https://")]
HUD_GATEWAY_ENDPOINT = "https://inference.beta.hud.ai/v1/chat/completions"
Role: TypeAlias = Literal["system", "user", "assistant"]


class Message(StrictModel):
    role: Role
    content: str


Chat: TypeAlias = Callable[[tuple[Message, ...], int], str]


class ProviderError(RuntimeError):
    pass


_FENCE = re.compile(r"\A```(?:[a-z]+)?\n(?P<body>.*)\n```\Z", re.DOTALL)


def unfence(text: str) -> str:
    """Strip one Markdown code fence, if the whole reply is one.

    Models wrap structured replies in fences whatever the prompt says. This
    lived in `swebench.py` only, so the GSM8K path had no tolerance for it and
    a full round's construction stage was one fenced reply away from failing.
    One implementation, used by every parser that reads model output.
    """

    match = _FENCE.match(text.strip())
    return match.group("body") if match else text


def json_schema_instructions(model: type[BaseModel], purpose: str) -> str:
    """Prompt text that states the exact schema a reply must satisfy.

    Derived from the model rather than written by hand, so a prompt cannot drift
    from the parser that validates its reply, and a stage cannot ship without
    telling the model what shape to return — which is how a construction round
    went out asking only for "one strict JSON object".
    """

    schema = json.dumps(
        model.model_json_schema(),
        sort_keys=True,
        separators=(",", ":"),
    )
    return (
        f"{purpose}\n"
        "Reply with one JSON object and nothing else. No Markdown fences, no "
        "prose. It must validate against this JSON Schema:\n"
        f"{schema}"
    )


class TokenPricing(StrictModel):
    input_usd_per_million: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    output_usd_per_million: Annotated[float, Field(ge=0, allow_inf_nan=False)]

    def cost_usd(self, prompt_tokens: int, completion_tokens: int) -> float:
        return (
            prompt_tokens * self.input_usd_per_million
            + completion_tokens * self.output_usd_per_million
        ) / 1_000_000


FREE = TokenPricing(input_usd_per_million=0.0, output_usd_per_million=0.0)

# The single pricing table. It previously existed in four places — two package
# constants, a research driver's dict, and literals inlined into a
# preregistration body — and one copy went stale and mispriced a whole round.
PRICING: Mapping[str, TokenPricing] = {
    "claude-haiku-4-5": TokenPricing(
        input_usd_per_million=1.0,
        output_usd_per_million=5.0,
    ),
    "claude-sonnet-4-6": TokenPricing(
        input_usd_per_million=2.0,
        output_usd_per_million=10.0,
    ),
    "claude-opus-4-8": TokenPricing(
        input_usd_per_million=5.0,
        output_usd_per_million=25.0,
    ),
}


_DATED_MODEL = re.compile(r"^(?P<family>.+)-\d{8}$")


def pricing_for(model: str) -> TokenPricing:
    """Look up a model's rates, refusing to guess.

    Providers report a dated snapshot (`claude-haiku-4-5-20251001`) for a model
    requested by family (`claude-haiku-4-5`), so the snapshot suffix is
    stripped before lookup. An unrecognized model raises: silently defaulting
    to zero is how a paid run comes to report that it cost nothing.
    """

    dated = _DATED_MODEL.match(model)
    for candidate in (model, dated.group("family") if dated else model):
        if candidate in PRICING:
            return PRICING[candidate]
    raise ProviderError(f"no token pricing is recorded for model {model!r}")


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
