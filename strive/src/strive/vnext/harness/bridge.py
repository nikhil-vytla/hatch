"""Translate strive.harness/1 to M3's existing injectable EffectAdapter seam.

No supervisor, broker, ledger, command schema or verifier modification. Missing
identity suspends locally just like a mismatch; no alias is called immutable.
"""
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

from ..codec import decode, encode
from ..contracts.commands import ExecuteEffect
from ..contracts.harness import (CompletionClassification, DurableEvidence, ExecutionContext, GenerationInput,
                                HarnessReturn, PreparedGeneration, ProcessObservations, RecordedReturn, Unsupported)
from ..contracts.lifecycle import DispatchStage, RecoveryCapability, RecoveryContract
from ..contracts.primitives import ArtifactRef, EffectId, EnvironmentId, InvocationId, Resource, ResourceQuantity
from ..contracts.records import EffectAuthorization, OutcomeStatus, UsageProvenance
from ..errors import VerificationError
from ..runtime.broker import DispatchContext, EffectRequest, PreparedEffect, Receipt
from .adapters.base import TextHarnessAdapter
from .gateway import ModelGateway
from .process import ProcessServices
from .provider import json_object
from .process_identity import terminate_recorded


class HarnessEffectAdapter:
    def __init__(self, adapter: TextHarnessAdapter, gateway: ModelGateway, scratch_root: Path, *, mode: str = "normal") -> None:
        self.adapter, self.gateway, self.scratch_root, self.mode = adapter, gateway, scratch_root, mode
        self.identity = adapter.identity

    def _generation(self, request: EffectRequest) -> GenerationInput:
        generation = decode(self.gateway.objects.read(request.arguments))
        if not isinstance(generation, GenerationInput):
            raise VerificationError("generation envelope required")
        if (any(item.access_scope != request.scope for item in generation.authorized_context)
                or {item.reference for item in generation.authorized_context} != set(request.inputs)):
            raise VerificationError("generation context differs from broker-permitted inputs")
        return generation

    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        if self.gateway.stop_reason(request.scope.run_id) is not None:
            raise VerificationError("gateway run is suspended")
        generation = self._generation(request)
        provider = self.gateway.contract
        binding = generation.requested_model_binding
        if (command.operation != "model.generate" or request.destination != provider.endpoint
                or binding.model != provider.model or binding.provider != provider.provider
                or binding.max_input_tokens < provider.input_ceiling or binding.max_output_tokens != provider.output_ceiling):
            raise VerificationError("provider route/model/whole-generation bound differs from binding")
        preflight = self.adapter.prepare(binding, generation, ExecutionContext(request.scope.run_id,
            InvocationId("preflight"), EffectId("preflight"), request.arguments, 0, request.scope))
        if isinstance(preflight, Unsupported):
            raise VerificationError(preflight.reason)
        envelope = self.gateway.objects.publish(encode((generation, self.adapter.describe(), self.adapter.profile.retained(self.gateway.objects))))
        # OPERATION_LOOKUP here describes the trusted gateway spool. It does not
        # grant provider lookup; that is separately gated by verified_lookup.
        return PreparedEffect(provider.reservation(self.gateway.bound),
            RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP, RecoveryCapability.SUSPEND}), False, False),
            EnvironmentId("model-gateway"), DispatchStage.HARNESS_LAUNCH, self.identity, envelope)

    def _context(self, authorization: EffectAuthorization) -> ExecutionContext:
        return ExecutionContext(authorization.permitted_scope.run_id, InvocationId(str(authorization.command_id) + ":harness"),
            authorization.effect_id, authorization.executing_bundle, authorization.execution_epoch, authorization.permitted_scope)

    def _prepared(self, authorization: EffectAuthorization, request: EffectRequest) -> PreparedGeneration:
        generation = self._generation(request)
        prepared = self.adapter.prepare(generation.requested_model_binding, generation, self._context(authorization))
        if isinstance(prepared, Unsupported):
            raise VerificationError(prepared.reason)
        if prepared.reservation_requirements != authorization.reservation:
            raise VerificationError("launch bound differs from reservation")
        return prepared

    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        if authorization.adapter != self.identity:
            raise VerificationError("adapter identity changed")
        self.gateway.contract.validate(request)

    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt:
        prepared = self._prepared(context.authorization, request)

        def forward(raw: bytes, send: Callable[[bytes], bytes]) -> bytes:
            def perform(data: bytes) -> Receipt:
                output = send(data)
                if not isinstance(output, bytes):
                    raise VerificationError("provider bytes required")
                return Receipt(context.authorization.effect_id, context.authorization.execution_epoch, output, b"")
            return context.forward(raw, perform).output

        services = self.services(forward)
        try:
            result = self.adapter.invoke(prepared, services)
            response = self.gateway.recover_response(prepared.execution_context)
            if response is None:
                raise VerificationError("process completion has no upstream outcome")
            result = replace(result, gateway_receipt_references=(response,))
            self.gateway.record_return(prepared.execution_context, self.gateway.objects.publish(encode(result)))
            return self._receipt(prepared, result, context.authorization.execution_epoch)
        finally:
            services.close()

    def services(self, forward: Callable[[bytes, Callable[[bytes], bytes]], bytes]) -> ProcessServices:
        return ProcessServices(self.gateway, self.adapter.profile, self.scratch_root, forward, mode=self.mode)

    def _receipt(self, prepared: PreparedGeneration, result: HarnessReturn, epoch: int) -> Receipt:
        context = prepared.execution_context
        state = self.gateway.read(context)
        if state is None or state.response is None:
            raise VerificationError("no retained response")
        raw = self.gateway.objects.read(state.response)
        native_model = self.adapter.native_identifier()
        identity = self.gateway.identity_evidence(context, native_model)
        self.gateway.event(context, "identity", self.gateway.objects.publish(identity))
        observed = json_object(raw).get("model")
        stop_reason = None
        if observed != self.gateway.contract.model or state.denied:
            stop_reason = "observed model unknown/mismatched or forbidden auxiliary request; suspend"
            self.gateway.stop(context, stop_reason)
        # Successful process output is validated against independently retained
        # provider text. Harness model/usage echoes have no accounting authority.
        if stop_reason is not None:
            output, outcome = encode(("qualification-failed", stop_reason, result)), OutcomeStatus.FAILED
        elif result.completion_classification is CompletionClassification.COMPLETE:
            expected = self.adapter.decode_text(self.gateway.contract.text(raw))
            if result.decoded_text_or_proposal_reference is None or self.gateway.objects.read(result.decoded_text_or_proposal_reference) != expected:
                raise VerificationError("harness output differs from provider output")
            output, outcome = expected, OutcomeStatus.RETURNED
        else:
            # Known provider usage can settle even when native decoding failed.
            output, outcome = encode(result), OutcomeStatus.FAILED
        return Receipt(context.effect_id, epoch, output, encode(("gateway-receipt/1", state.response,
            state.wire, state.prepared, self.gateway.objects.publish(identity), result,
            self.gateway.events(context, "launch"), self.gateway.events(context, "pid"))), self.gateway.contract.usage(raw) + (
                (ResourceQuantity(Resource.WALL_MILLISECONDS, result.process_observations.active_milliseconds),)
                if result.process_observations.exit_code is not None else ()),
            provenance=UsageProvenance.GATEWAY, outcome=outcome)

    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        request = EffectRequest.read(self.gateway.objects.read(authorization.exact_request_reference))
        prepared = self._prepared(authorization, request)
        context = prepared.execution_context
        try:
            terminate_recorded(self.gateway, context)
        except OSError:
            return None
        proof = self.gateway.prove_no_dispatch(context, prepared
            if authorization.dispatch_stage is DispatchStage.HARNESS_LAUNCH else None)
        if proof is not None:
            # Frozen M2 forbids changing the epoch of a launch->forward edge.
            # Close this no-dispatch attempt; caller may accept a fresh command
            # with a fresh reservation after consuming this failed result.
            return Receipt(authorization.effect_id, epoch, encode(("definitely-not-dispatched", proof)), encode((proof,)),
                           tuple(ResourceQuantity(q.resource, 0) for q in authorization.reservation.components
                                 if q.resource is not Resource.WALL_MILLISECONDS),
                           provenance=UsageProvenance.GATEWAY, outcome=OutcomeStatus.FAILED)
        response = self.gateway.recover_response(context)
        state = self.gateway.read(context)
        if state is None or response is None:
            return None
        evidence = DurableEvidence(context, (), (), (response,), (state.returned,) if state.returned else ())
        result = self.adapter.reconcile(prepared, evidence)
        if not isinstance(result, RecordedReturn):
            # The provider outcome is known. Keep the native generation
            # incomplete, settle known provider usage, and retain unknown wall
            # usage. Do not invent a proposal when the decoder is not pinned
            # deterministic. FAILED is delivered as data to the policy.
            incomplete = HarnessReturn(CompletionClassification.INCOMPLETE, (), None,
                ProcessObservations(None, None, False, False, False, 0), (response,))
            self.gateway.record_return(context, self.gateway.objects.publish(encode(incomplete)))
            return self._receipt(prepared, incomplete, epoch)
        self.gateway.record_return(context, result.return_reference)
        return self._receipt(prepared, result.result, epoch)
