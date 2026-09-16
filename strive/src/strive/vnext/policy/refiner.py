"""Brokered refiner generation using the existing durable model gateway."""
from collections.abc import Callable
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
from ..harness.gateway import ModelGateway
from ..harness.provider import json_object
from ..runtime.admission import ValidatedArguments
from ..runtime.broker import DispatchContext, EffectRequest, PreparedEffect, Receipt
from ..store.cas import CAS
from .data import Proposal, loads

SCHEMA = b"strive.policy.proposal/1"


class GenerationValidator:
    """The first context artifact retains the environment used for admission."""
    def __init__(self, objects: CAS) -> None:
        self.objects = objects
        self.identity = objects.publish(Path(__file__).read_bytes())

    def validate(self, data: bytes) -> ValidatedArguments:
        generation = decode(data)
        if not isinstance(generation, GenerationInput) or generation.role is not ModelRole.REFINER or not generation.authorized_context:
            raise VerificationError("refiner generation required")
        context = json_object(self.objects.read(generation.authorized_context[0].reference))
        environment = context.get("environment")
        if not isinstance(environment, str):
            raise VerificationError("refiner environment required")
        return ValidatedArguments(ArtifactRef(environment), tuple(i.reference for i in generation.authorized_context))


class GatewayRefiner:
    """Inject Upstream at ModelGateway for zero-network deterministic tests.

    Paid generations always reserve and forward through Supervisor + gateway.
    Policy payloads have their own decoder; no frozen harness decoder is changed.
    """
    def __init__(self, gateway: ModelGateway) -> None:
        self.gateway, self.objects, self.contract = gateway, gateway.objects, gateway.contract
        self.identity = self.objects.publish(encode(("gateway-refiner/1", gateway.identity,
            self.objects.publish(Path(__file__).read_bytes()))))

    def _generation(self, request: EffectRequest) -> GenerationInput:
        value = decode(self.objects.read(request.arguments))
        if (not isinstance(value, GenerationInput) or value.role is not ModelRole.REFINER
                or any(i.access_scope != request.scope for i in value.authorized_context)
                or tuple(i.reference for i in value.authorized_context) != request.inputs):
            raise VerificationError("refiner context differs from broker inputs")
        binding = value.requested_model_binding
        if (binding.provider != self.contract.provider or binding.model != self.contract.model
                or binding.max_input_tokens < self.contract.input_ceiling
                or binding.max_output_tokens != self.contract.output_ceiling
                or value.generation_settings != binding.request_options
                or self.objects.read(binding.request_options) != b"{}"
                or self.objects.read(value.output_schema) != SCHEMA):
            raise VerificationError("refiner model/settings/schema mismatch")
        requested = {q.resource: q.quantity for q in value.resource_limits}
        if any(requested.get(q.resource, -1) < q.quantity for q in self.contract.reservation(self.gateway.bound).components):
            raise VerificationError("refiner resource limits below provider bound")
        return value

    def _wire(self, generation: GenerationInput) -> bytes:
        text = "\n".join(self.objects.read(i.reference).decode("utf-8") for i in generation.authorized_context)
        body: dict[str, object] = {"model": self.contract.model}
        if self.contract.protocol == "responses-text/1":
            body.update(input=text, max_output_tokens=self.contract.output_ceiling)
        else:
            body.update(messages=[{"role": "user", "content": text}], max_tokens=self.contract.output_ceiling)
        raw = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        self.contract.validate(raw)
        return raw

    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        if (command.operation != "model.generate" or request.destination != self.contract.endpoint
                or self.gateway.stop_reason(request.scope.run_id) is not None):
            raise VerificationError("refiner route stopped or not admitted")
        generation = self._generation(request)
        self._wire(generation)
        envelope = self.objects.publish(encode(("refiner-generation/1", generation, self.identity)))
        return PreparedEffect(self.contract.reservation(self.gateway.bound),
            RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP, RecoveryCapability.SUSPEND}), False, False),
            EnvironmentId("model-gateway"), DispatchStage.HARNESS_LAUNCH, self.identity, envelope)

    def _prepared(self, auth: EffectAuthorization) -> PreparedGeneration:
        request = EffectRequest.read(self.objects.read(auth.exact_request_reference))
        generation = self._generation(request)
        if auth.adapter != self.identity or auth.reservation != self.contract.reservation(self.gateway.bound):
            raise VerificationError("refiner authorization mismatch")
        context = ExecutionContext(auth.permitted_scope.run_id, InvocationId(str(auth.command_id) + ":refiner"),
            auth.effect_id, auth.executing_bundle, auth.execution_epoch, auth.permitted_scope)
        return PreparedGeneration(context, (), self._wire(generation), self.identity, (self.gateway.bound,), self.identity,
            self.identity, generation.output_schema, max(1, self.contract.wall_milliseconds // 1000), auth.reservation)

    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        if request != self._prepared(authorization).input_bytes:
            raise VerificationError("refiner wire differs from retained context")
        self.contract.validate(request)

    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt:
        prepared = self._prepared(context.authorization)
        if self.objects.read(context.authorization.exact_request_reference) != request.to_bytes():
            raise VerificationError("refiner invoke request mismatch")
        token = self.gateway.issue(prepared)
        def forward(raw: bytes, send: Callable[[bytes], bytes]) -> bytes:
            return context.forward(raw, lambda data: Receipt(context.authorization.effect_id,
                context.authorization.execution_epoch, send(data), b"")).output
        start = time.monotonic()
        self.gateway.dispatch(prepared.execution_context, token, prepared.input_bytes, forward)
        return self._receipt(prepared, context.authorization.execution_epoch, int((time.monotonic() - start) * 1000))

    def _receipt(self, prepared: PreparedGeneration, epoch: int, wall: int | None = None) -> Receipt:
        context = prepared.execution_context
        state = self.gateway.read(context)
        if state is None or state.response is None:
            raise VerificationError("no captured refiner response")
        raw = self.objects.read(state.response)
        outcome = OutcomeStatus.RETURNED
        try:
            if json_object(raw).get("model") != self.contract.model or state.denied:
                raise VerificationError("refiner model identity mismatch or forbidden request")
            output = self.contract.text(raw).encode()
            loads(output, Proposal)
        except (VerificationError, ValueError) as error:
            output, outcome = encode(("invalid-refiner-generation", str(error))), OutcomeStatus.FAILED
            self.gateway.stop(context, str(error))
        result = self.objects.publish(output)
        self.gateway.record_return(context, result)
        evidence = encode(("refiner-receipt/1", state.prepared, state.wire, state.response, result,
                           self.objects.publish(self.gateway.identity_evidence(context))))
        usage = self.contract.usage(raw)
        if wall is not None:
            usage += (ResourceQuantity(Resource.WALL_MILLISECONDS, wall),)
        return Receipt(context.effect_id, epoch, output, evidence, usage, provenance=UsageProvenance.GATEWAY, outcome=outcome)

    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        prepared = self._prepared(authorization)
        if self.gateway.recover_response(prepared.execution_context) is None:
            return None
        return self._receipt(prepared, epoch)
