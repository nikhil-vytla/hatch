"""Pinned capabilities and the trusted adapter boundary. No candidate ports."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
import threading
from typing import Protocol

from ..codec import decode, encode
from ..contracts.commands import ExecuteEffect
from ..contracts.lifecycle import DispatchStage, RecoveryContract
from ..contracts.primitives import AccessScope, ArtifactRef, EnvironmentId, Reservation, ResourceQuantity
from ..contracts.records import EffectAuthorization, OutcomeStatus, UsageProvenance
from ..errors import VerificationError
from ..store.cas import CAS
from ..verify.engine import VerifiedState
from .ledger import BudgetLedger


@dataclass(frozen=True)
class EffectRequest:
    destination: str
    arguments: ArtifactRef
    scope: AccessScope
    inputs: tuple[ArtifactRef, ...] = ()

    def to_bytes(self) -> bytes:
        return encode((self.destination, self.arguments, self.scope, self.inputs))

    @classmethod
    def read(cls, data: bytes) -> "EffectRequest":
        value = decode(data)
        if not isinstance(value, tuple) or len(value) != 4:
            raise VerificationError("invalid effect request")
        destination, arguments, scope, inputs = value
        if (not isinstance(destination, str) or not isinstance(arguments, ArtifactRef)
                or not isinstance(scope, AccessScope) or not isinstance(inputs, tuple)
                or not all(isinstance(item, ArtifactRef) for item in inputs)):
            raise VerificationError("invalid effect request fields")
        return cls(destination, arguments, scope, inputs)


@dataclass(frozen=True)
class Capability:
    binding: str
    operation: str
    destination: str
    scope: AccessScope
    adapter: ArtifactRef
    # Exact argument and input handles are a deliberately small M3 policy.
    arguments: frozenset[ArtifactRef]
    inputs: frozenset[ArtifactRef]

    def retained(self) -> tuple[object, ...]:
        return (self.binding, self.operation, self.destination, self.scope,
                self.adapter, self.arguments, self.inputs)


@dataclass(frozen=True)
class PreparedEffect:
    reservation: Reservation
    recovery: RecoveryContract
    environment: EnvironmentId
    stage: DispatchStage = DispatchStage.OPERATION
    harness_binding: ArtifactRef | None = None
    generation: ArtifactRef | None = None
    actual_request: ArtifactRef | None = None


@dataclass(frozen=True)
class Receipt:
    """Trusted cumulative usage, plus exact output/receipt bytes.

    A missing measurement retains its obligation. A receipt must identify the
    effect and current epoch; lookup reattests old evidence in the new epoch.
    """
    effect_id: str
    epoch: int
    output: bytes
    evidence: bytes
    measured: tuple[ResourceQuantity, ...] = ()
    remaining: tuple[ResourceQuantity, ...] = ()
    provenance: UsageProvenance = UsageProvenance.TRUSTED_ADAPTER
    outcome: OutcomeStatus = OutcomeStatus.RETURNED
    environment: ArtifactRef | None = None


class DispatchContext:
    """One-use upstream gate; M4 supplies its validated gateway send function.

    invoke() is trusted code, never a candidate callback. Forward authorization
    durably captures exact bytes before calling send. This object has no store,
    credentials, producer port, or general-purpose privileged shell interface.
    """

    def __init__(self, authorization: EffectAuthorization,
                 authorize_upstream: Callable[[bytes], None]) -> None:
        self.authorization = authorization
        self._authorize_upstream = authorize_upstream
        self._used = authorization.dispatch_stage is DispatchStage.UPSTREAM_FORWARD
        self._gate = threading.Lock()

    def forward(self, request: bytes, send: Callable[[bytes], Receipt]) -> Receipt:
        with self._gate:
            if self._used:
                raise VerificationError("single upstream request already used")
            self._used = True  # Denied attempts cannot be replaced by another request.
            self._authorize_upstream(request)
        return send(request)


class EffectAdapter(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...
    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        """Pure preparation: establish a defensible bound, no paid effects."""
        ...
    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt: ...
    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        """Lookup/recompute/dedup only as declared; None means indeterminate."""
        ...
    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        """Reject models, tools, arguments or sizes outside the prepared bound."""
        ...


class CapabilityBroker:
    def __init__(self, objects: CAS, capabilities: tuple[Capability, ...],
                 adapters: Mapping[str, EffectAdapter]) -> None:
        self.objects = objects
        self.capabilities = capabilities
        self.adapters = MappingProxyType(dict(adapters))
        self.policy_reference = objects.publish(encode(tuple(c.retained() for c in capabilities)))

    def prepare(self, state: VerifiedState, command: ExecuteEffect) -> tuple[EffectAdapter, EffectRequest, PreparedEffect]:
        if state.binding is None or state.binding.capabilities != self.policy_reference:
            raise VerificationError("capability policy differs from run binding")
        request = EffectRequest.read(self.objects.read(command.request))
        grants = [c for c in self.capabilities if c.binding == command.binding and c.operation == command.operation
                  and c.destination == request.destination and c.scope == request.scope
                  and request.arguments in c.arguments and set(request.inputs) <= c.inputs]
        adapter = self.adapters.get(command.binding)
        if len(grants) != 1 or adapter is None or adapter.identity != grants[0].adapter:
            raise VerificationError("destination, scope, operation, arguments or adapter not permitted")
        for ref in (request.arguments, *request.inputs):
            self.objects.read(ref)
        plan = adapter.prepare(command, request)
        BudgetLedger.admit(state, plan.reservation)
        if command.operation == "model.generate" and plan.generation is None:
            raise VerificationError("model generation requires retained generation inputs")
        return adapter, request, plan

    def adapter_for(self, authorization: EffectAuthorization, binding: str) -> EffectAdapter:
        adapter = self.adapters.get(binding)
        if adapter is None or adapter.identity != authorization.adapter:
            raise VerificationError("pinned adapter unavailable for recovery")
        return adapter
