"""Bounded direct user generation. Function calls are returned as inert data.

Native actor/refiner profiles remain text-only. This adapter has no tool runner.
"""
from collections.abc import Callable
from dataclasses import dataclass
import json
from pathlib import Path
import time

from ..codec import decode, encode
from ..contracts.commands import ExecuteEffect
from ..contracts.harness import ExecutionContext, GenerationInput, PreparedGeneration
from ..contracts.lifecycle import DispatchStage, RecoveryCapability, RecoveryContract
from ..contracts.primitives import ArtifactRef, EnvironmentId, InvocationId, ModelRole, Resource, ResourceQuantity
from ..contracts.records import EffectAuthorization, OutcomeStatus, UsageProvenance
from ..errors import VerificationError
from ..runtime.broker import DispatchContext, EffectRequest, PreparedEffect, Receipt
from .gateway import ModelGateway
from .provider import ProviderContract, json_object


@dataclass(frozen=True)
class UserProviderContract(ProviderContract):
    tool_schemas: bytes = b"[]"
    max_tool_calls: int = 8
    max_tool_argument_bytes: int = 16384

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.protocol != "responses-text/1" or min(self.max_tool_calls, self.max_tool_argument_bytes) <= 0:
            raise ValueError("bounded Responses user proposal contract required")
        tools: object = json.loads(self.tool_schemas)
        if not isinstance(tools, list) or any(not isinstance(t, dict) or t.get("type") != "function"
                                              or not isinstance(t.get("name"), str) for t in tools):
            raise ValueError("literal function schemas required")

    def validate(self, raw: bytes) -> None:
        if len(raw) > self.max_request_bytes:
            raise VerificationError("oversized user request")
        request = json_object(raw)
        if set(request) - {"model", "input", "max_output_tokens", "tools", "stream", "parallel_tool_calls"}:
            raise VerificationError("unsupported user provider option")
        maximum = request.get("max_output_tokens")
        if (request.get("model") != self.model or type(maximum) is not int or not 0 < maximum <= self.output_ceiling
                or request.get("tools") != json.loads(self.tool_schemas) or request.get("stream", False) is not False
                or request.get("parallel_tool_calls", False) is not False):
            raise VerificationError("user model/schema/output bound mismatch")
        messages = request.get("input")
        if not isinstance(messages, list) or not messages:
            raise VerificationError("user protocol requires structured messages")
        for message in messages:
            if not isinstance(message, dict):
                raise VerificationError("malformed user message")
            if set(message) == {"role", "content"}:
                valid = message["role"] in {"system", "user", "assistant", "developer"} and isinstance(message["content"], str)
            elif set(message) == {"type", "call_id", "output"}:
                valid = message["type"] == "function_call_output" and all(isinstance(message[k], str) for k in ("call_id", "output"))
            elif set(message) == {"type", "call_id", "name", "arguments"}:
                valid = message["type"] == "function_call" and all(isinstance(message[k], str) for k in ("call_id", "name", "arguments"))
            else:
                valid = False
            if not valid:
                raise VerificationError("user message contains unsupported provider behavior")

    def proposals(self, raw: bytes) -> bytes:
        response = json_object(raw)
        if response.get("status") != "completed" or response.get("model") != self.model:
            raise VerificationError("user provider completion/model ambiguous")
        output = response.get("output")
        if not isinstance(output, list) or not output:
            raise VerificationError("missing structured user response")
        text: list[str] = []
        calls: list[dict[str, object]] = []
        schemas: object = json.loads(self.tool_schemas)
        assert isinstance(schemas, list)
        names = {t["name"] for t in schemas}
        seen: set[str] = set()
        for item in output:
            if not isinstance(item, dict):
                raise VerificationError("malformed user response")
            if item.get("type") == "message":
                parts = item.get("content")
                if not isinstance(parts, list):
                    raise VerificationError("missing user text parts")
                for part in parts:
                    if not isinstance(part, dict) or part.get("type") != "output_text" or not isinstance(part.get("text"), str):
                        raise VerificationError("unsupported user content")
                    text.append(part["text"])
            elif item.get("type") == "function_call":
                call_id, name, arguments = item.get("call_id"), item.get("name"), item.get("arguments")
                if (not isinstance(call_id, str) or not call_id or call_id in seen or name not in names
                        or not isinstance(arguments, str) or len(arguments.encode()) > self.max_tool_argument_bytes):
                    raise VerificationError("invalid/unbounded user tool proposal")
                seen.add(call_id)
                calls.append({"id": call_id, "name": name, "arguments": json_object(arguments.encode()), "requestor": "assistant"})
            else:
                raise VerificationError("unsupported hosted tool or output item")
        if len(calls) > self.max_tool_calls:
            raise VerificationError("user tool batch exceeds bound")
        return json.dumps({"role": "assistant", "content": "".join(text) or None, "tool_calls": calls or None},
                          sort_keys=True, separators=(",", ":")).encode()


class DirectUserModelAdapter:
    def __init__(self, gateway: ModelGateway, contract: UserProviderContract) -> None:
        if gateway.contract != contract:
            raise ValueError("gateway user contract mismatch")
        self.gateway, self.contract = gateway, contract
        source = gateway.objects.publish(Path(__file__).read_bytes())
        self.identity = gateway.objects.publish(encode(("direct-user-model/1", source, gateway.identity, gateway.bound)))

    def _generation(self, request: EffectRequest) -> GenerationInput:
        value = decode(self.gateway.objects.read(request.arguments))
        if not isinstance(value, GenerationInput) or value.role is not ModelRole.USER:
            raise VerificationError("direct structured adapter is user-only")
        if (any(item.access_scope != request.scope for item in value.authorized_context)
                or {item.reference for item in value.authorized_context} != set(request.inputs)):
            raise VerificationError("user context differs from broker grants")
        binding = value.requested_model_binding
        if (binding.provider != self.contract.provider or binding.model != self.contract.model
                or binding.max_input_tokens < self.contract.input_ceiling or binding.max_output_tokens != self.contract.output_ceiling):
            raise VerificationError("user generation model/bound mismatch")
        self.contract.validate(self.gateway.objects.read(value.generation_settings))
        return value

    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        if (command.operation != "model.generate" or request.destination != self.contract.endpoint
                or self.gateway.stop_reason(request.scope.run_id) is not None):
            raise VerificationError("user generation route/run not admitted")
        generation = self._generation(request)
        envelope = self.gateway.objects.publish(encode(("direct-user-generation/1", generation, self.identity)))
        return PreparedEffect(self.contract.reservation(self.gateway.bound),
            RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP, RecoveryCapability.SUSPEND}), False, False),
            EnvironmentId("model-gateway"), DispatchStage.HARNESS_LAUNCH, self.identity, envelope)

    def _prepared(self, auth: EffectAuthorization) -> PreparedGeneration:
        request = EffectRequest.read(self.gateway.objects.read(auth.exact_request_reference))
        generation = self._generation(request)
        context = ExecutionContext(auth.permitted_scope.run_id, InvocationId(str(auth.command_id) + ":user"),
                                   auth.effect_id, auth.executing_bundle, auth.execution_epoch, auth.permitted_scope)
        if auth.adapter != self.identity or auth.reservation != self.contract.reservation(self.gateway.bound):
            raise VerificationError("user generation authorization mismatch")
        return PreparedGeneration(context, (), self.gateway.objects.read(generation.generation_settings), self.identity,
            (self.gateway.bound,), self.identity, self.identity, generation.output_schema,
            max(1, self.contract.wall_milliseconds // 1000), auth.reservation)

    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        prepared = self._prepared(authorization)
        if request != prepared.input_bytes:
            raise VerificationError("user wire request differs from authorization")
        self.contract.validate(request)

    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt:
        prepared = self._prepared(context.authorization)
        if self.gateway.objects.read(context.authorization.exact_request_reference) != request.to_bytes():
            raise VerificationError("user invoke request mismatch")
        token = self.gateway.issue(prepared)
        def forward(raw: bytes, send: Callable[[bytes], bytes]) -> bytes:
            return context.forward(raw, lambda data: Receipt(context.authorization.effect_id,
                context.authorization.execution_epoch, send(data), b"")).output
        start = time.monotonic()
        self.gateway.dispatch(prepared.execution_context, token, prepared.input_bytes, forward)
        wall = int((time.monotonic() - start) * 1000)
        return self._receipt(prepared, context.authorization.execution_epoch, wall)

    def _receipt(self, prepared: PreparedGeneration, epoch: int, wall: int | None = None) -> Receipt:
        context = prepared.execution_context
        state = self.gateway.read(context)
        if state is None or state.response is None:
            raise VerificationError("no captured user response")
        raw = self.gateway.objects.read(state.response)
        try:
            output, outcome = self.contract.proposals(raw), OutcomeStatus.RETURNED
        except VerificationError as error:
            output, outcome = encode(("invalid-user-generation", str(error))), OutcomeStatus.FAILED
            self.gateway.stop(context, str(error))
        result = self.gateway.objects.publish(output)
        self.gateway.record_return(context, result)
        usage = self.contract.usage(raw)
        if wall is not None:
            usage += (ResourceQuantity(Resource.WALL_MILLISECONDS, wall),)
        evidence = encode(("direct-user-receipt/1", state.prepared, state.wire, state.response, result,
                           self.gateway.objects.publish(self.gateway.identity_evidence(context))))
        return Receipt(context.effect_id, epoch, output, evidence, usage, provenance=UsageProvenance.GATEWAY, outcome=outcome)

    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        prepared = self._prepared(authorization)
        response = self.gateway.recover_response(prepared.execution_context)
        if response is None:
            return None  # Business deduplication never implies billing deduplication.
        return self._receipt(prepared, epoch)


def request_from_user_plan(plan_bytes: bytes, contract: UserProviderContract) -> bytes:
    """Encode upstream's captured role-flipped messages as a Responses request.

    Tool/result messages retain call IDs. Unsupported settings fail explicitly.
    No prose parsing or hidden generation is involved.
    """
    plan = json_object(plan_bytes)
    if plan.get("model") != contract.model:
        raise VerificationError("upstream user model differs from pinned provider")
    if plan.get("settings", {}) not in ({}, None):
        raise VerificationError("this pinned user provider does not support additional generation settings")
    source = plan.get("messages")
    if not isinstance(source, list):
        raise VerificationError("upstream structured messages required")
    messages: list[dict[str, object]] = []
    for value in source:
        if not isinstance(value, dict):
            raise VerificationError("invalid upstream message")
        role, content = value.get("role"), value.get("content")
        if role == "tool":
            messages.append({"type": "function_call_output", "call_id": value.get("id"), "output": content})
            continue
        if content is not None:
            messages.append({"role": role, "content": content})
        calls = value.get("tool_calls") or []
        if not isinstance(calls, list):
            raise VerificationError("invalid upstream call batch")
        for call in calls:
            if not isinstance(call, dict):
                raise VerificationError("invalid upstream call")
            messages.append({"type": "function_call", "call_id": call.get("id"), "name": call.get("name"),
                             "arguments": json.dumps(call.get("arguments"), sort_keys=True, separators=(",", ":"))})
    tools = plan.get("tools")
    if not isinstance(tools, list):
        raise VerificationError("upstream tool schemas required")
    schemas: list[dict[str, object]] = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
            raise VerificationError("unsupported upstream tool schema")
        schemas.append({"type": "function", **tool["function"]})
    if schemas != json.loads(contract.tool_schemas):
        raise VerificationError("upstream user tools differ from pinned provider schema")
    raw = json.dumps({**contract.request_controls(), "model": contract.model, "input": messages, "tools": schemas,
        "max_output_tokens": contract.output_ceiling, "parallel_tool_calls": False}, sort_keys=True, separators=(",", ":")).encode()
    contract.validate(raw)
    return raw
