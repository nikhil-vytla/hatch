from __future__ import annotations

import json
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .checkpoint_evolution import CheckpointError, EntrypointContract, Workspace
from .checkpoint_runner import CheckpointDelivery, MeteredWorkspace, StageUsage
from .evolving_intent import Message
from .outcome import BudgetError
from .provider import (
    OpenAICompatibleProvider,
    ProviderMessage,
    ProviderRequest,
    ProviderResponse,
)
from .types import NonEmptyText, StrictModel

JSON_FENCE_PREFIX = "```json\n"
JSON_FENCE_SUFFIX = "\n```"

STAGE_PROTOCOL = (
    "You are completing one checkpoint of an evolving command-line "
    "programming task. Reply with the complete workspace as one JSON "
    'object: {"files": {"<relative path>": "<full file content>"}}. '
    "Include every file the program needs; any file you omit is deleted. "
    "Do not use Markdown fences and do not add commentary. The program "
    "must behave exactly as specified when run through the declared "
    "entry file."
)


class AgentReplyError(ValueError):
    pass


class StagePricing(StrictModel):
    input_usd_per_million: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    output_usd_per_million: Annotated[float, Field(ge=0, allow_inf_nan=False)]


HAIKU_STAGE_PRICING = StagePricing(
    input_usd_per_million=1.0,
    output_usd_per_million=5.0,
)


class _FileMapReply(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid")
    files: dict[str, str]


def render_stage_messages(
    contract: EntrypointContract,
    delivery: CheckpointDelivery,
) -> tuple[Message, ...]:
    current = json.dumps(
        {"files": {file.path: file.content for file in delivery.workspace.files}},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    user = (
        f"Specification:\n{delivery.public_spec}\n\n"
        f"Entry file: {contract.entry_file} "
        f"(run as: {contract.interpreter} {contract.entry_file} [args])\n"
        f"Per-case timeout: {contract.timeout_seconds} seconds\n"
        f"Total workspace byte budget: {delivery.max_output_bytes}\n\n"
        f"Current workspace, in the same JSON shape you must reply with:\n"
        f"{current}"
    )
    return (
        Message(role="system", content=STAGE_PROTOCOL),
        Message(role="user", content=user),
    )


def parse_file_map(text: str) -> Workspace:
    payload = text
    if payload.startswith(JSON_FENCE_PREFIX) and payload.endswith(JSON_FENCE_SUFFIX):
        payload = payload[len(JSON_FENCE_PREFIX) : -len(JSON_FENCE_SUFFIX)]
    try:
        reply = _FileMapReply.model_validate_json(payload)
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise AgentReplyError(
            f"stage reply is not a valid file map: {detail}"
        ) from error
    try:
        return Workspace.from_files(reply.files)
    except (CheckpointError, ValidationError) as error:
        raise AgentReplyError(f"stage reply file map is invalid: {error}") from error


def _stage_usage(response: ProviderResponse, pricing: StagePricing) -> StageUsage:
    usage = response.usage
    if usage is None:
        raise AgentReplyError("provider response omitted usage; stage is unmeterable")
    cost = (
        usage.prompt_tokens * pricing.input_usd_per_million
        + usage.completion_tokens * pricing.output_usd_per_million
    ) / 1_000_000
    return StageUsage(
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        estimated_cost_usd=cost,
    )


def _metered(error: Exception, usage: StageUsage | None) -> Exception:
    if usage is not None:
        error.stage_usage = usage  # ty: ignore[unresolved-attribute]
    return error


class ProviderCheckpointAgent:
    """Maps the chat provider boundary onto `CheckpointAgent`.

    A pure function of the delivered stage: the rendered request depends
    only on (public spec, carried workspace, declared budgets) and the
    frozen construction arguments. Token usage and conservative cost ride
    back on the returned `MeteredWorkspace`, or on the raised error's
    `stage_usage` when the reply is rejected after spend.
    """

    def __init__(
        self,
        provider: OpenAICompatibleProvider,
        *,
        contract: EntrypointContract,
        expected_response_model: NonEmptyText,
        max_output_tokens: int,
        pricing: StagePricing,
    ) -> None:
        self._provider = provider
        self._contract = contract
        self._expected_response_model = expected_response_model
        self._max_output_tokens = max_output_tokens
        self._pricing = pricing

    def __call__(self, delivery: CheckpointDelivery) -> MeteredWorkspace:
        response = self._provider.complete(
            ProviderRequest(
                model=self._provider.config.model,
                messages=tuple(
                    ProviderMessage(role=message.role, content=message.content)
                    for message in render_stage_messages(self._contract, delivery)
                ),
                max_output_tokens=self._max_output_tokens,
            )
        )
        usage = _stage_usage(response, self._pricing)
        if len(response.choices) != 1:
            raise _metered(
                AgentReplyError("stage reply must contain exactly one choice"),
                usage,
            )
        choice = response.choices[0]
        if response.model != self._expected_response_model:
            raise _metered(
                AgentReplyError(
                    f"expected {self._expected_response_model}, "
                    f"provider reported {response.model}"
                ),
                usage,
            )
        if choice.finish_reason == "length":
            raise _metered(
                BudgetError("stage reply reached its output-token limit"),
                usage,
            )
        if choice.message.tool_calls or not choice.message.content:
            raise _metered(
                AgentReplyError("stage reply must be one non-empty text message"),
                usage,
            )
        try:
            workspace = parse_file_map(choice.message.content)
        except AgentReplyError as error:
            raise _metered(error, usage) from error
        return MeteredWorkspace(workspace=workspace, usage=usage)
