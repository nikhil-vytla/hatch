"""A trusted fake service persists independently of a restarted supervisor."""

from dataclasses import replace
from pathlib import Path

from strive.vnext.codec import encode
from strive.vnext.contracts.commands import ExecuteEffect
from strive.vnext.contracts.lifecycle import DispatchStage, RecoveryCapability, RecoveryContract
from strive.vnext.contracts.manifest import load_resolved_configuration
from strive.vnext.contracts.primitives import (
    AccessScope, ArtifactRef, EnvironmentId, LineageId, Reservation, Resource, ResourceQuantity, RunId,
)
from strive.vnext.contracts.records import CausalIdentity, DeclaredLineage, EffectAuthorization, ProducerKind, RunBinding
from strive.vnext.runtime import Capability, CapabilityBroker, DispatchContext, EffectRequest, PreparedEffect, Receipt, Supervisor
from strive.vnext.store import ArtifactStore

from .fixtures import AUTHORED_TOML


class FakeProvider:
    def __init__(self, identity: ArtifactRef) -> None:
        self.identity = identity
        self.calls = 0
        self.lookups = 0
        self.receipts: dict[str, Receipt] = {}
        self.arguments: dict[str, ArtifactRef] = {}
        self.measured: tuple[ResourceQuantity, ...] = (ResourceQuantity(Resource.INPUT_TOKENS, 40), ResourceQuantity(Resource.MODEL_CALLS, 1))
        self.bound: tuple[ResourceQuantity, ...] = (ResourceQuantity(Resource.INPUT_TOKENS, 100), ResourceQuantity(Resource.MODEL_CALLS, 1))
        self.recovery = RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP}), True, True)
        self.harness = False
        self.extra_request = False
        self.stale = False

    def prepare(self, command: ExecuteEffect, request: EffectRequest) -> PreparedEffect:
        return PreparedEffect(Reservation(self.bound, self.identity), self.recovery, EnvironmentId("env"),
                              DispatchStage.HARNESS_LAUNCH if self.harness else DispatchStage.OPERATION,
                              self.identity if self.harness else None, self.identity)

    def invoke(self, context: DispatchContext, request: EffectRequest) -> Receipt:
        if self.harness:
            result = context.forward(b"approved-wire-request", lambda data: self._perform(context.authorization, request))
            if self.extra_request:
                context.forward(b"approved-wire-request", lambda data: self._perform(context.authorization, request))
            return result
        return self._perform(context.authorization, request)

    def _perform(self, authorization: EffectAuthorization, request: EffectRequest) -> Receipt:
        effect_id = authorization.effect_id
        if effect_id in self.receipts:
            assert self.arguments[effect_id] == request.arguments
            return self.receipts[effect_id]
        self.calls += 1
        receipt = Receipt(effect_id, authorization.execution_epoch - int(self.stale), b"real outcome", b"provider receipt",
                          self.measured)
        self.receipts[effect_id] = receipt
        self.arguments[effect_id] = request.arguments
        return receipt

    def reconcile(self, authorization: EffectAuthorization, epoch: int) -> Receipt | None:
        self.lookups += 1
        receipt = self.receipts.get(authorization.effect_id)
        return replace(receipt, epoch=epoch) if receipt else None

    def validate_upstream(self, authorization: EffectAuthorization, request: bytes) -> None:
        if request != b"approved-wire-request":
            raise ValueError("unapproved wire arguments")


class RuntimeFixture:
    def __init__(self, root: Path, source: bytes = b"initial bundle") -> None:
        self.store = ArtifactStore(root)
        self.pin = self.store.objects.publish(b"trusted fixture closure")
        self.bundle = self.store.objects.publish(source)
        self.arguments = self.store.objects.publish(b"approved args")
        self.scope = AccessScope(RunId("runtime"), LineageId("development"), self.pin)
        self.provider = FakeProvider(self.pin)
        self.capability = Capability("actor", "model.generate", "fake://provider", self.scope, self.pin,
                                     frozenset({self.arguments}), frozenset({self.arguments}))
        self.broker = CapabilityBroker(self.store.objects, (self.capability,), {"actor": self.provider})
        self.reader = self.store.create_run(self.scope.run_id, self.scope, {k: self.pin for k in ProducerKind})
        self.writer = self.store.writer(self.scope.run_id)
        config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", self.pin.digest))
        self.binding = RunBinding(self.pin, self.pin, self.pin, self.pin, self.pin, self.pin, self.bundle,
                                  config.models, replace(config.budget, tokens=1000, model_calls=10),
                                  self.broker.policy_reference, config.run.editable, config.feedback, config.comparison,
                                  config.run.mode, DeclaredLineage(self.scope.lineage_id, None, None, self.scope.grant), (), self.pin)
        self.writer.port(ProducerKind.RUN_SETUP).append(self.binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
        self.supervisor = Supervisor(self.writer, self.broker, compatible_bundle=lambda ref: ref in {self.bundle, self.pin})

    def command(self, request: EffectRequest | None = None, *, operation: str = "model.generate", binding: str = "actor") -> ExecuteEffect:
        request = request or EffectRequest("fake://provider", self.arguments, self.scope)
        return ExecuteEffect(operation, binding, self.store.objects.publish(request.to_bytes()))

    def restart(self) -> Supervisor:
        self.writer.close()
        self.writer = self.store.writer(self.scope.run_id)
        self.supervisor = Supervisor(self.writer, self.broker, compatible_bundle=lambda ref: ref in {self.bundle, self.pin})
        return self.supervisor

    def close(self) -> None:
        self.writer.close()
