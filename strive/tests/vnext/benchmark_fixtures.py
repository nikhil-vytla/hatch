"""Synthetic telecom contract fixtures, NOT recorded execution of live tau2."""
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

from strive.vnext.benchmarks.api import EpisodeSnapshot, TaskSpec, ToolInvocation
from strive.vnext.benchmarks.bridge import BenchmarkEffectAdapter, OperationRequest, OperationValidator
from strive.vnext.benchmarks.episodes import EpisodeAssignment, EpisodeDriver
from strive.vnext.benchmarks.json_data import canonical, items, obj, parse, string
from strive.vnext.benchmarks.payloads import loads
from strive.vnext.benchmarks.store import OperationStore
from strive.vnext.codec import encode
from strive.vnext.contracts.commands import ExecuteEffect, StepOutput
from strive.vnext.contracts.manifest import load_resolved_configuration
from strive.vnext.contracts.primitives import AccessScope, ArtifactRef, EnvironmentId, EpisodeId, LineageId, RunId
from strive.vnext.contracts.records import CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from strive.vnext.errors import VerificationError
from strive.vnext.runtime.admission import AdmissionRule, ArtifactProvenance, ScopedAdmission
from strive.vnext.runtime.broker import Capability, CapabilityBroker, EffectRequest
from strive.vnext.runtime.supervisor import Supervisor
from strive.vnext.store import ArtifactStore
from strive_benchmark_tau2.adapter import Tau2Adapter, implementation_identity
from strive_benchmark_tau2.qualification import qualify
from strive_benchmark_tau2.splits import scenario_group

from .fixtures import AUTHORED_TOML
from .runtime_fixtures import FakeProvider


def inventory() -> tuple[list[dict[str, object]], dict[str, list[str]]]:
    tasks: list[dict[str, object]] = [{"id": str(i), "user_scenario": {"persona": "calm", "instructions": f"scenario {i}"},
        "initial_state": {"marker": i}, "evaluation_criteria": {"reward_basis": ["ENV_ASSERTION"],
        "env_assertions": [{"env_type": "user", "func_name": "connected", "arguments": {"scenario": i}}]}}
        for i in range(114)]
    return tasks, {"base": [str(i) for i in range(114)], "train": [str(i) for i in range(74)], "test": [str(i) for i in range(74, 114)]}


def action_matches(action: dict[str, object], call: dict[str, object]) -> bool:
    """Synthetic boundary oracle preserving the pinned comparator's quirks."""
    if action["name"] != call["name"]:
        return False
    actual, expected = obj(call["arguments"]), obj(action["arguments"])
    keys = set(actual) if action.get("compare_args") is None else set(string(v) for v in items(action["compare_args"]))
    return {k: v for k, v in actual.items() if k in keys} == {k: v for k, v in expected.items() if k in keys}


class SyntheticTelecom:
    def __init__(self, identity: ArtifactRef) -> None:
        self.identity = identity
        self.calls: dict[str, int] = {}

    def call(self, operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]:
        self.calls[operation] = self.calls.get(operation, 0) + 1
        value = parse(payload)
        data = obj(parse(state)) if state else {}
        output: object = {}
        if operation == "initialize":
            data = {"agent_db": {"active": False}, "user_db": {"enabled": False},
                    "agent_history": [], "user_history": [], "user_state": {"system_messages": ["fixture"], "persona": "calm", "messages": []},
                    "speaker": "assistant", "pending_message": None, "pending_batch": [], "delivery_cursor": 0,
                    "steps": 0, "termination": None, "random_state": [0], "identities": obj(value).get("identities"),
                    "task": obj(value)["task"], "trajectory": []}
            output = {"observation": "service and device disconnected"}
        elif operation in {"agent_tool", "user_tool"}:
            call = obj(value)
            requestor = "user" if operation == "user_tool" else "assistant"
            if call["requestor"] != requestor:
                raise VerificationError("requestor mismatch")
            target = "user_db" if requestor == "user" else "agent_db"
            field = "enabled" if requestor == "user" else "active"
            obj_state = obj(data[target])
            obj_state[field] = True
            data[target] = obj_state
            output = {"error": call["name"] == "mutate_then_error", "requestor": requestor, "content": "changed"}
            data["trajectory"] = [*items(data["trajectory"]), {"call": call, "output": output}]
        elif operation == "deliver_message":
            data["agent_history"] = [*items(data["agent_history"]), value]
            data["pending_message"] = value
            output = {"delivered": True}
        elif operation == "plan_user_turn":
            output = {"messages": [*items(data["agent_history"]), value], "tools": [{"name": "enable"}]}
        elif operation == "user_turn":
            proposal = obj(value)["response"]
            data["user_history"] = [*items(data["user_history"]), proposal]
            data["pending_batch"] = obj(proposal).get("tool_calls") or []
            output = proposal
        elif operation == "terminate":
            data["termination"] = value
            output = {"termination": value}
        elif operation == "snapshot":
            output = {"steps": data["steps"]}
        elif operation == "score":
            value = obj(value)
            if value["task"] != data["task"] or value["termination"] != data["termination"]:
                raise VerificationError("forged task or termination")
            criteria = obj(obj(value["task"])["evaluation_criteria"])
            calls = [obj(obj(event)["call"]) for event in items(data["trajectory"])]
            # Independently derive both database values from captured operations.
            replayed = {"assistant": False, "user": False}
            for call in calls:
                replayed[string(call["requestor"])] = True
            if replayed != {"assistant": obj(data["agent_db"])["active"], "user": obj(data["user_db"])["enabled"]}:
                output = {"status": "invalid", "reason": "committed/replayed state divergence"}
            else:
                components = {"ENV_ASSERTION": all(replayed.values()), "DB": all(replayed.values()),
                    "ACTION": all(any(action_matches(obj(action), call) for call in calls) for action in items(criteria.get("actions") or [])),
                    "COMMUNICATE": all(any(string(required).lower() in string(obj(message).get("content", "")).lower().replace(",", "")
                        for message in items(data["agent_history"])) for required in items(criteria.get("communicate_info") or []))}
                score = all(components[string(b)] for b in items(criteria["reward_basis"])) and value["termination"] in {"agent_stop", "user_stop"}
                output = {"status": "scored", "value": int(score), "fixture_oracle": True}
        else:
            raise VerificationError("unsupported fixture operation")
        if operation not in {"plan_user_turn", "score"}:
            data["steps"] = int(str(data["steps"])) + 1
        return canonical(data), canonical(output)


class BenchmarkFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.store = ArtifactStore(root / "artifacts")
        objects = self.store.objects
        self.pin = objects.publish(b"synthetic telecom fixture closure; not live tau2")
        self.bundle = objects.publish(b"initial candidate bundle")
        self.scope = AccessScope(RunId("run-1"), LineageId("development"), self.pin)
        self.backend = SyntheticTelecom(self.pin)
        tasks, splits = inventory()
        qualification = qualify(objects, canonical(tasks), canonical(splits), assertion_allowlist=frozenset({("user", "connected")}), execute_checks=lambda task: None)
        specs = tuple(TaskSpec(string(t["id"]), scenario_group(t), objects.publish(canonical(t)),
                               objects.publish(canonical(t["evaluation_criteria"]))) for t in tasks)
        self.adapter_pin = implementation_identity(objects, self.backend, qualification, self.pin)
        self.operations = OperationStore(root / "operations", objects, self.scope.run_id, self.adapter_pin, 1, create=True)
        self.adapter = Tau2Adapter(objects, self.backend, specs, qualification, self.pin, self.operations)
        self.reader = self.store.create_run(self.scope.run_id, self.scope, {k: self.adapter.scorer.identity if k is ProducerKind.TRUSTED_SCORER else self.pin for k in ProducerKind})
        self.writer = self.store.writer(self.scope.run_id)
        self.task = specs[0]
        self.provenance = ArtifactProvenance(root / "grants", objects, self.pin)
        self.validator = OperationValidator(objects)
        self.routes = {s.name: ("benchmark", "local://telecom") for s in self.adapter.describe().operations}
        self.bridge = BenchmarkEffectAdapter(self.adapter, objects, "local://telecom", allowed_operations=frozenset(self.routes))
        rules = tuple(AdmissionRule("benchmark", "benchmark." + name, "local://telecom", self.scope, self.adapter.identity,
                                   self.validator.identity, 1000000, 32, ()) for name in self.routes)
        admission = ScopedAdmission(objects, self.provenance, rules, (self.validator,))
        self.provider = FakeProvider(objects.publish(b"fixture-model"))
        self.model_args = objects.publish(b"model arguments")
        self.model_plan = objects.publish(canonical({"messages": [{"content": "hello"}, {"content": "hello"}], "tools": [{"name": "enable"}]}))
        capability = Capability("model", "model.generate", "fake://model", self.scope, self.provider.identity,
                                 frozenset({self.model_args}), frozenset({self.model_plan}))
        self.broker = CapabilityBroker(objects, (capability,), {"benchmark": self.bridge, "model": self.provider}, admission)
        config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", self.pin.digest))
        binding = RunBinding(self.pin, self.pin, self.pin, self.pin, self.adapter.scorer.identity, self.pin, self.bundle,
            config.models, replace(config.budget, tokens=1000, model_calls=10), self.broker.policy_reference, config.run.editable,
            config.feedback, config.comparison, config.run.mode, DeclaredLineage(self.scope.lineage_id, None, None, self.pin), (), self.pin)
        self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
        self._supervisor()
        self.assignment = EpisodeAssignment(EpisodeId("episode"), self.task, qualification.report, ("0",))
        self.driver = EpisodeDriver(self.supervisor, self.adapter, self.assignment, self.routes, self.provenance)

    def _supervisor(self) -> None:
        self.supervisor = Supervisor(self.writer, self.broker, compatible_bundle=lambda ref: ref in {self.bundle, self.pin})

    def restart(self) -> None:
        self.writer.close()
        self.operations.close()
        self.writer = self.store.writer(self.scope.run_id)
        self.operations = OperationStore(self.root / "operations", self.store.objects, self.scope.run_id, self.adapter_pin, self.writer.epoch)
        self.adapter.store = self.operations
        self.adapter.scorer.store = self.operations
        self._supervisor()
        self.driver = EpisodeDriver(self.supervisor, self.adapter, self.assignment, self.routes, self.provenance)

    def operation(self, name: str, values: tuple[object, ...] = ()) -> OperationRequest:
        current = self.supervisor.state.environment
        assert current is not None
        before = None if name == "initialize" else loads(self.store.objects.read(current), EpisodeSnapshot)
        return OperationRequest(EpisodeId("episode"), EnvironmentId("telecom-env"), current, before, name, values)

    def initialize(self) -> None:
        self.driver.perform(self.operation("initialize", (self.task, self.store.objects.publish(b"{}"))))
        self.driver.consume()

    def tool(self, requestor: str, name: str = "enable") -> None:
        arguments = self.store.objects.publish(b"{}")
        self.driver.perform(self.operation(requestor + "_tool", (ToolInvocation(requestor + str(len(self.supervisor.state.effects)), name, arguments),)))

    def terminate(self, reason: str = "agent_stop") -> None:
        self.driver.perform(self.operation("terminate", (self.store.objects.publish(canonical(reason)),)))
        self.driver.consume()

    def model(self, *, user: bool = False) -> None:
        ref = self.store.objects.publish(EffectRequest("fake://model", self.model_args, self.scope, (self.model_plan,) if user else ()).to_bytes())
        self.supervisor.accept(StepOutput(ExecuteEffect("model.generate", "model", ref), b"pending model"), expected_head=self.supervisor.state.head)
        self.supervisor.drive()

    def close(self) -> None:
        self.writer.close()
        self.operations.close()
        self.provenance.close()
