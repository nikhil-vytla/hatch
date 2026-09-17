from dataclasses import replace
from pathlib import Path

import pytest

from strive.benchmarks.json_data import canonical, obj, parse
from strive.codec import encode
from strive.contracts.bindings import ModelBinding
from strive.contracts.commands import ExecuteEffect, StepOutput
from strive.contracts.harness import GenerationInput
from strive.contracts.manifest import load_resolved_configuration
from strive.contracts.primitives import AccessScope, LineageId, ModelRole, RunId
from strive.contracts.records import CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from strive.errors import VerificationError
from strive.harness.gateway import ModelGateway
from strive.harness.provider import ProviderContract
from strive.harness.user_model import DirectUserModelAdapter, UserProviderContract
from strive.runtime import Capability, CapabilityBroker, EffectRequest, Supervisor
from strive.store import ArtifactStore
from .fixtures import AUTHORED_TOML
from .harness_support import FixtureUpstream, ProcessCrash


class UserFixture:
    def __init__(self, root: Path, lookup: bool = False) -> None:
        self.store = ArtifactStore(root / "store")
        objects = self.store.objects
        pin = objects.publish(b"structured-user-fixture")
        self.scope = AccessScope(RunId("user-model"), LineageId("user"), pin)
        self.response = canonical({"model": "fixture", "status": "completed", "id": "one", "usage": {"input_tokens": 10, "output_tokens": 8},
            "output": [{"type": "function_call", "call_id": "one", "name": "enable", "arguments": "{}"}]})
        self.upstream = FixtureUpstream(root / "provider", self.response)
        self.contract = UserProviderContract("fixture", "fixture", "https://example.invalid/v1/responses", "responses-text/1", "fixture", pin,
            256, 64, 65536, 65536, 1, 1, verified_lookup=lookup, recovery_key_header="Operation-Key" if lookup else None,
            tool_schemas=canonical([{"type": "function", "name": "enable", "parameters": {"type": "object", "properties": {}}}]))
        self.gateway = ModelGateway(root / "gateway", objects, self.contract, self.upstream)
        self.adapter = DirectUserModelAdapter(self.gateway, self.contract)
        self.raw = canonical({"model": "fixture", "max_output_tokens": 64, "tools": parse(self.contract.tool_schemas),
                              "input": [{"role": "user", "content": "enable the device"}], "parallel_tool_calls": False})
        model = ModelBinding("fixture", "fixture", pin, 256, 64, "forbid", "user")
        self.generation = GenerationInput(ModelRole.USER, (), model, objects.publish(self.raw), pin, ())
        arguments = objects.publish(encode(self.generation))
        self.request = EffectRequest(self.contract.endpoint, arguments, self.scope)
        self.command = ExecuteEffect("model.generate", "user", objects.publish(self.request.to_bytes()))
        capability = Capability("user", "model.generate", self.contract.endpoint, self.scope, self.adapter.identity, frozenset({arguments}), frozenset())
        broker = CapabilityBroker(objects, (capability,), {"user": self.adapter})
        self.reader = self.store.create_run(self.scope.run_id, self.scope, {kind: pin for kind in ProducerKind})
        self.writer = self.store.writer(self.scope.run_id)
        config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", pin.digest))
        binding = RunBinding(pin, pin, pin, pin, pin, pin, pin, config.models, replace(config.budget, tokens=1000, model_calls=10),
            broker.policy_reference, config.run.editable, config.feedback, config.comparison, config.run.mode,
            DeclaredLineage(self.scope.lineage_id, None, None, pin), (), pin)
        self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
        self.broker = broker
        self.supervisor = Supervisor(self.writer, broker)

    def run(self) -> None:
        self.supervisor.accept(StepOutput(self.command, b"user turn"), expected_head=self.supervisor.state.head)
        self.supervisor.drive()

    def close(self) -> None:
        self.writer.close()
        self.gateway.close()


def test_structured_calls_are_data_and_text_profiles_remain_closed(tmp_path: Path) -> None:
    fixture = UserFixture(tmp_path)
    try:
        fixture.run()
        effect = fixture.supervisor.state.effects[0]
        assert effect.response is not None
        assert obj(parse(fixture.store.objects.read(effect.response)))["tool_calls"] == [{"id": "one", "name": "enable", "arguments": {}, "requestor": "assistant"}]
        assert len(fixture.upstream.requests) == 1
        assert fixture.upstream.requests[0] == fixture.raw
        assert not fixture.supervisor.state.obligations
        assert effect.authorization.actual_provider_request_reference == fixture.store.objects.publish(fixture.raw)
        text_contract = ProviderContract(**{name: getattr(fixture.contract, name) for name in ProviderContract.__dataclass_fields__})
        with pytest.raises(VerificationError):
            text_contract.validate(fixture.raw)
        for role in (ModelRole.ACTOR, ModelRole.REFINER):
            arguments = fixture.store.objects.publish(encode(replace(fixture.generation, role=role)))
            with pytest.raises(VerificationError, match="user-only"):
                fixture.adapter.prepare(fixture.command, replace(fixture.request, arguments=arguments))
    finally:
        fixture.close()


@pytest.mark.parametrize("point,lookup,settled", [("response-spooled", False, True), ("upstream-return-before-spool", False, False), ("upstream-return-before-spool", True, True)])
def test_direct_user_gateway_recovery_no_repeat(tmp_path: Path, point: str, lookup: bool, settled: bool) -> None:
    fixture = UserFixture(tmp_path, lookup)
    try:
        def crash(actual: str) -> None:
            if actual == point:
                raise ProcessCrash()
        fixture.gateway.fault = crash
        with pytest.raises(ProcessCrash):
            fixture.run()
        fixture.gateway.fault = lambda point: None
        fixture.writer.close()
        fixture.writer = fixture.store.writer(fixture.scope.run_id)
        fixture.supervisor = Supervisor(fixture.writer, fixture.broker)
        fixture.supervisor.recover()
        assert len(fixture.upstream.requests) == 1
        assert (fixture.supervisor.state.effects[0].response is not None) is settled
        assert fixture.supervisor.state.obligations  # Wall usage cannot be invented after restart.
        fixture.supervisor.recover()
        assert len(fixture.upstream.requests) == 1
    finally:
        fixture.close()


def test_user_proposal_bounds_and_hosted_tool_rejection(tmp_path: Path) -> None:
    fixture = UserFixture(tmp_path)
    try:
        for output in ([{"type": "web_search_call"}], [{"type": "function_call", "call_id": "x", "name": "unauthorized", "arguments": "{}"}],
                       [{"type": "function_call", "call_id": "same", "name": "enable", "arguments": "{}"}] * 2):
            with pytest.raises(VerificationError):
                fixture.contract.proposals(canonical({"model": "fixture", "status": "completed", "output": output}))
    finally:
        fixture.close()
