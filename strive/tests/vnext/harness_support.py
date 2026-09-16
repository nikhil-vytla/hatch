"""Free local fixture upstream plus unchanged M3 supervisor integration."""
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import shutil
import threading
from typing import Literal

from strive.vnext.codec import encode
from strive.vnext.contracts.bindings import HarnessBinding, ModelBinding
from strive.vnext.contracts.commands import Continue, ExecuteEffect, StepOutput
from strive.vnext.contracts.harness import GenerationInput
from strive.vnext.contracts.manifest import NamedHarness, load_resolved_configuration
from strive.vnext.contracts.primitives import (AccessScope, ArtifactRef, IntegrationLevel, LineageId, ModelRole, RunId, ScopedArtifact)
from strive.vnext.contracts.records import BoundHarness, CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from strive.vnext.harness.adapters import REGISTRY, resolve
from strive.vnext.harness.bridge import HarnessEffectAdapter
from strive.vnext.harness.gateway import ModelGateway
from strive.vnext.harness.execution import HarnessExecution
from strive.vnext.harness.profiles import fixture_profile
from strive.vnext.harness.provider import HTTPProvider, ProviderContract
from strive.vnext.runtime import Capability, CapabilityBroker, EffectRequest, Supervisor
from strive.vnext.store import ArtifactStore
from strive.vnext.store.cas import atomic_file

from .fixtures import AUTHORED_TOML


class FixtureUpstream:
    def __init__(self, root: Path, response: bytes) -> None:
        root.mkdir(parents=True)
        self.root, self.response = root, response
        self.requests: list[bytes] = []
        self.lookups = 0
        self.url = "http://127.0.0.1:1/recorded-provider-not-a-listener"

    def generate(self, request: bytes, operation_key: str) -> bytes:
        self.requests.append(request)
        atomic_file(self.root / operation_key, self.response, replace=True)
        return self.response

    def lookup(self, key: str) -> bytes | None:
        self.lookups += 1
        path = self.root / key
        return path.read_bytes() if path.exists() else None

    def close(self) -> None:
        pass


class HarnessFixture:
    def __init__(self, root: Path, backend: str = "opencode", *, mode: str = "normal",
                 usage: Literal["complete", "partial", "missing", "overrun"] = "complete",
                 observed: str | None = "recorded-model", lookup: bool = True, deterministic: bool = True) -> None:
        self.root = root
        self.store = ArtifactStore(root)
        self.pin = self.store.objects.publish(b"fixture contract: provider context ceiling 256; inclusive reasoning output 64; fixed uncached nanodollar prices 2/3; durable operation lookup")
        self.bundle = self.store.objects.publish(b"bundle")
        self.scope = AccessScope(RunId("runtime"), LineageId("development"), self.pin)
        self.proposal = ExecuteEffect("benchmark.tool", "workload", self.pin)
        self.proposal_bytes = encode(self.proposal)
        protocol = "anthropic-text/1" if backend == "claude-code" else "responses-text/1"
        response: dict[str, object] = {"id": "fixture-response", "status": "completed"}
        if observed is not None:
            response["model"] = observed
        if protocol == "anthropic-text/1":
            response["content"] = [{"type": "text", "text": self.proposal_bytes.decode()}]
        else:
            response["output"] = [{"type": "message", "content": [{"type": "output_text", "text": self.proposal_bytes.decode()}]}]
        if usage != "missing":
            response["usage"] = ({"input_tokens": 20} if usage == "partial" else
                                 {"input_tokens": 300 if usage == "overrun" else 20, "output_tokens": 8})
        self.upstream = FixtureUpstream(root / "upstream", json.dumps(response).encode())
        self.contract = ProviderContract("fixture", "recorded-model", self.upstream.url, protocol, "fixture-account", self.pin,
            256, 64, 32768, 262144, 2, 3, verified_lookup=lookup,
            deterministic_decoder=deterministic, recovery_key_header="X-Fixture-Operation" if lookup else None)
        self.gateway = ModelGateway(root / "gateway", self.store.objects, self.contract,
            self.upstream)
        executable = shutil.which("deno")
        if executable is None:
            raise RuntimeError("Deno required for deterministic real-process qualification")
        self.profile = fixture_profile(backend, Path(executable), Path(__file__).with_name("harness_fixtures") / "client.js")
        self.options = self.store.objects.publish(b"{}")
        self.schema = self.store.objects.publish(b"typed-proposal/1")
        self.model = ModelBinding("fixture", "recorded-model", self.options, 256, 64, "forbid", "launcher")
        initial = REGISTRY[backend](self.store.objects, self.profile, self.contract)
        executable_ref, _, sandbox_ref = self.profile.references(self.store.objects)
        profile_ref = self.profile.retained(self.store.objects)
        self.harness_binding = HarnessBinding("strive.harness/1", backend, initial.identity, executable_ref, "fixture/1",
            IntegrationLevel.MODEL, profile_ref, sandbox_ref, "broker_gateway", "none", "fresh", 1, self.profile.deadline_seconds)
        self.adapter = resolve(self.model, (NamedHarness("launcher", self.harness_binding),), self.store.objects,
                               {profile_ref: self.profile}, self.contract)
        self.input_ref = self.store.objects.publish(b"authorized user context")
        self.generation = GenerationInput(ModelRole.ACTOR, (ScopedArtifact(self.input_ref, self.scope),), self.model,
                                          self.options, self.schema, ())
        self.arguments = self.store.objects.publish(encode(self.generation))
        self.bridge = HarnessEffectAdapter(self.adapter, self.gateway, root / "scratch", mode=mode)
        capability = Capability("actor", "model.generate", self.upstream.url, self.scope, self.bridge.identity,
                                frozenset({self.arguments}), frozenset({self.input_ref}))
        self.broker = CapabilityBroker(self.store.objects, (capability,), {"actor": self.bridge})
        self.reader = self.store.create_run(self.scope.run_id, self.scope,
            {kind: self.gateway.identity if kind is ProducerKind.BROKER else
             self.adapter.identity if kind is ProducerKind.TRUSTED_ADAPTER else self.pin for kind in ProducerKind})
        self.writer = self.store.writer(self.scope.run_id)
        config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", self.pin.digest))
        binding = RunBinding(self.pin, self.pin, self.pin, self.adapter.identity, self.pin, self.pin, self.bundle, tuple(replace(model, binding=self.model) for model in config.models),
            replace(config.budget, tokens=1000, model_calls=10), self.broker.policy_reference, config.run.editable,
            config.feedback, config.comparison, config.run.mode, DeclaredLineage(self.scope.lineage_id, None, None, self.scope.grant),
            (BoundHarness("launcher", self.harness_binding, self.store.objects.publish(encode(self.adapter.describe())),
                executable_ref, profile_ref, sandbox_ref, IntegrationLevel.MODEL),), self.gateway.identity)
        self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
        self.supervisor = Supervisor(self.writer, self.broker)
        self.execution = HarnessExecution(self.supervisor, (self.bridge,))

    def command(self) -> ExecuteEffect:
        request = EffectRequest(self.upstream.url, self.arguments, self.scope, (self.input_ref,))
        return ExecuteEffect("model.generate", "actor", self.store.objects.publish(request.to_bytes()))

    def run(self) -> None:
        self.supervisor.accept(StepOutput(self.command(), b"pending"), expected_head=self.supervisor.state.head)
        self.execution.drive()

    def consume(self) -> None:
        self.supervisor.accept(StepOutput(Continue(), b"consumed"), expected_head=self.supervisor.state.head)

    def restart(self) -> None:
        self.writer.close()
        self.gateway.close()
        self.gateway = ModelGateway(self.root / "gateway", self.store.objects, self.contract,
            self.upstream)
        self.bridge.gateway = self.gateway
        self.writer = self.store.writer(self.scope.run_id)
        self.supervisor = Supervisor(self.writer, self.broker)
        self.execution = HarnessExecution(self.supervisor, (self.bridge,))

    def close(self) -> None:
        self.writer.close()
        self.gateway.close()
        self.upstream.close()


class ProcessCrash(BaseException):
    pass
