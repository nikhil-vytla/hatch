"""Trusted mapping of one benchmark operation onto one existing broker effect."""
from dataclasses import dataclass
from pathlib import Path

from ..codec import decode, encode, references
from ..contracts.commands import ExecuteEffect
from ..contracts.primitives import ArtifactRef, EnvironmentId, EpisodeId, Reservation, ResourceQuantity
from ..contracts.records import EffectAuthorization, OutcomeStatus
from ..errors import VerificationError
from ..runtime.admission import ValidatedArguments
from ..runtime.broker import DispatchContext, EffectRequest, PreparedEffect, Receipt
from ..store.cas import CAS
from .api import (BenchmarkAdapter, CapturedGeneration, EpisodeSnapshot, FoundOperation, OperationContext,
                  OperationReceipt, ProvenAbsent, TaskSpec, ToolInvocation, UserTurnPlan)
from .payloads import dumps, loads


@dataclass(frozen=True)
class OperationRequest:
    episode: EpisodeId
    environment: EnvironmentId
    current: ArtifactRef
    before: EpisodeSnapshot | None
    operation: str
    values: tuple[object, ...]

    def to_bytes(self) -> bytes:
        return dumps(("operation/1", self.episode, self.environment, self.current, self.before, self.operation, self.values))

    @classmethod
    def read(cls, raw: bytes) -> "OperationRequest":
        value = loads(raw, tuple)
        if (len(value) != 7 or value[0] != "operation/1" or not isinstance(value[1], str) or not value[1]
                or not isinstance(value[2], str) or not value[2] or not isinstance(value[3], ArtifactRef)
                or value[4] is not None and not isinstance(value[4], EpisodeSnapshot)
                or not isinstance(value[5], str) or not isinstance(value[6], tuple)):
            raise VerificationError("malformed operation request")
        result = cls(EpisodeId(value[1]), EnvironmentId(value[2]), value[3], value[4], value[5], value[6])
        if result.before is not None and (result.before.episode != result.episode or result.before.environment != result.environment):
            raise VerificationError("operation expected snapshot identity mismatch")
        result.check_values()
        return result

    def check_values(self) -> None:
        types: dict[str, tuple[type[object], ...]] = {
            "initialize": (TaskSpec, ArtifactRef), "agent_tool": (ToolInvocation,), "user_tool": (ToolInvocation,),
            "user_turn": (UserTurnPlan, CapturedGeneration), "deliver_message": (ArtifactRef,),
            "terminate": (ArtifactRef,), "snapshot": (),
        }
        expected = types.get(self.operation)
        if expected is None or len(expected) != len(self.values) or any(
                not isinstance(v, t) for v, t in zip(self.values, expected, strict=True)):
            raise VerificationError("unsupported operation or malformed typed arguments")
        if (self.operation == "initialize") != (self.before is None):
            raise VerificationError("initialization/expected snapshot mismatch")


class OperationValidator:
    def __init__(self, objects: CAS) -> None:
        self.identity = objects.publish(encode(("benchmark-operation-schema/1", objects.publish(Path(__file__).read_bytes()))))

    def validate(self, data: bytes) -> ValidatedArguments:
        request = OperationRequest.read(data)
        # Snapshot/current state references are checked against the trusted head;
        # method value references require their own artifact read grants.
        return ValidatedArguments(request.current, tuple(sorted(references(request.values), key=lambda r: r.digest)))


class BenchmarkEffectAdapter:
    def __init__(self, adapter: BenchmarkAdapter, objects: CAS, destination: str,
                 *, allowed_operations: frozenset[str], cost: tuple[ResourceQuantity, ...] = ()) -> None:
        self.adapter, self.objects, self.destination = adapter, objects, destination
        self.allowed_operations, self.cost = allowed_operations, cost
        self.identity = adapter.identity
        self.bound = objects.publish(encode(("benchmark-local-bound/1", adapter.identity, allowed_operations, cost)))

    def _request(self, request: EffectRequest) -> OperationRequest:
        operation = OperationRequest.read(self.objects.read(request.arguments))
        if request.destination != self.destination or operation.operation not in self.allowed_operations:
            raise VerificationError("benchmark operation/requestor not authorized")
        if operation.operation.startswith("user_") and not self.adapter.describe().has_user_simulator:
            raise VerificationError("benchmark has no user simulator")
        return operation

    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        operation = self._request(request)
        if command.operation != "benchmark." + operation.operation:
            raise VerificationError("command operation differs from retained arguments")
        specs = [spec for spec in self.adapter.describe().operations if spec.name == operation.operation]
        if len(specs) != 1:
            raise VerificationError("operation lacks a declared recovery contract")
        return PreparedEffect(Reservation(self.cost, self.bound), specs[0].recovery, operation.environment)

    def _context(self, auth: EffectAuthorization, request: EffectRequest) -> tuple[OperationContext, OperationRequest]:
        operation = self._request(request)
        if (auth.adapter != self.identity or auth.permitted_scope != request.scope
                or auth.operation != "benchmark." + operation.operation or auth.target_environment != operation.environment
                or self.objects.read(auth.exact_request_reference) != request.to_bytes()
                or auth.input_references != request.inputs):
            raise VerificationError("benchmark arguments differ from authorization")
        return OperationContext(auth, operation.episode, request.arguments, operation.before), operation

    def _receipt(self, context: OperationContext, result: OperationReceipt, epoch: int) -> Receipt:
        auth = context.authorization
        if (result.effect_id != auth.effect_id or result.original_epoch != auth.execution_epoch
                or result.exact_request != auth.exact_request_reference or result.arguments != context.arguments
                or result.before != context.expected_snapshot or result.after.episode != context.episode
                or result.after.environment != auth.target_environment
                or result.after.version != (context.expected_snapshot.version + 1 if context.expected_snapshot else 0)):
            raise VerificationError("benchmark receipt does not match authorized transition")
        evidence = decode(self.objects.read(result.evidence))
        if (not isinstance(evidence, tuple) or len(evidence) != 6 or evidence != (
                "operation-commit/1", auth.permitted_scope.run_id, self.identity, auth, context.episode, context.arguments)):
            raise VerificationError("benchmark receipt lacks original authorization evidence")
        for ref in references(result):
            self.objects.read(ref)
        return Receipt(auth.effect_id, epoch, self.objects.read(result.output), dumps(result), self.cost,
                       environment=self.objects.publish(dumps(result.after)))

    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt:
        operation_context, operation = self._context(context.authorization, request)
        values = operation.values
        match operation.operation, values:
            case "initialize", (TaskSpec() as task, ArtifactRef() as initialization):
                result = self.adapter.initialize(operation_context, task, initialization)
            case "agent_tool", (ToolInvocation() as call,):
                result = self.adapter.agent_tool(operation_context, call)
            case "user_tool", (ToolInvocation() as call,):
                result = self.adapter.user_tool(operation_context, call)
            case "user_turn", (UserTurnPlan() as plan, CapturedGeneration() as generation):
                result = self.adapter.user_turn(operation_context, plan, generation)
            case "deliver_message", (ArtifactRef() as message,):
                result = self.adapter.deliver_message(operation_context, message)
            case "terminate", (ArtifactRef() as termination,):
                result = self.adapter.terminate(operation_context, termination)
            case "snapshot", ():
                result = self.adapter.snapshot(operation_context)
            case _:
                raise VerificationError("unsupported operation")
        return self._receipt(operation_context, result, context.authorization.execution_epoch)

    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        request = EffectRequest.read(self.objects.read(authorization.exact_request_reference))
        context, _ = self._context(authorization, request)
        result = self.adapter.lookup_operation(context.episode, authorization.effect_id, authorization.exact_request_reference)
        if isinstance(result, FoundOperation):
            return self._receipt(context, result.receipt, epoch)
        if isinstance(result, ProvenAbsent):
            proof = decode(self.objects.read(result.proof))
            expected = ("fenced-absence/1", authorization.permitted_scope.run_id, self.identity, epoch,
                        context.episode, authorization.effect_id, authorization.exact_request_reference)
            if proof != expected:
                raise VerificationError("unverified absence proof")
            # End the fenced attempt with no mutation. Never retry implicitly.
            return Receipt(authorization.effect_id, epoch, encode(("not-executed", result.proof)), encode((result.proof,)),
                           tuple(ResourceQuantity(q.resource, 0) for q in self.cost), outcome=OutcomeStatus.FAILED)
        return None

    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        raise VerificationError("local benchmark operations cannot forward network requests")
