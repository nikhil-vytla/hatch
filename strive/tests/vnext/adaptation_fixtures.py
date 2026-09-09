"""Offline counter campaign using the actual gateway, broker and Deno sandbox."""
from collections.abc import Callable
from dataclasses import replace
import json
from pathlib import Path

from strive.vnext.benchmarks.api import EpisodeSnapshot
from strive.vnext.benchmarks.bridge import BenchmarkEffectAdapter, OperationRequest, OperationValidator
from strive.vnext.benchmarks.episodes import EpisodeAssignment, EpisodeDriver
from strive.vnext.benchmarks.json_data import canonical
from strive.vnext.benchmarks.store import OperationStore
from strive.vnext.codec import encode
from strive.vnext.contracts.bindings import ModelBinding
from strive.vnext.contracts.feedback import FeedbackContract
from strive.vnext.contracts.manifest import load_resolved_configuration
from strive.vnext.contracts.primitives import AccessScope, ArtifactRef, EnvironmentId, EpisodeId, LineageId, RevisionId, RunId
from strive.vnext.contracts.records import CausalIdentity, DeclaredLineage, ProducerKind, RunBinding
from strive.vnext.harness.gateway import ModelGateway
from strive.vnext.harness.provider import ProviderContract, json_object
from strive.vnext.policy import BundleManager, BundleSandbox, ContinualRefine, Edit, EvidenceSelector, GatewayRefiner, GenerationValidator, Proposal, RefinerRoute
from strive.vnext.policy.data import dumps
from strive.vnext.runtime.admission import AdmissionRule, ArtifactProvenance, ScopedAdmission
from strive.vnext.runtime.broker import CapabilityBroker
from strive.vnext.runtime.sandbox import DenoSandbox, SandboxLimits
from strive.vnext.runtime.supervisor import Supervisor
from strive.vnext.store import ArtifactStore
from strive_benchmark_counter import CounterAdapter

from .fixtures import AUTHORED_TOML

CONTROLLER = b"function step(view, state, result, handles, actor) { return actor(view, state, result, handles); }"
ACTOR = b'''function step(view, state, result, handles, files) {
    const prompt = Number(atob(files["prompts/delta.txt"]));
    const memory = Number(atob(files["memory/delta.txt"]));
    return {type:"StepOutput", fields: {command:{type:"Continue",fields:{}},
      proposed_private_state:{bytes:btoa(JSON.stringify({delta:prompt+memory}))},annotations:{tuple:[]}}};
}'''


class ScriptedUpstream:
    def __init__(self) -> None:
        self.calls = 0
        self.contexts: list[dict[str, object]] = []
        self.decide: Callable[[dict[str, object]], Proposal] = lambda context: Proposal(RevisionId(str(context["revision"])), "keep")

    def generate(self, request: bytes, operation_key: str) -> bytes:
        self.calls += 1
        raw = json_object(request)
        text = raw["input"]
        assert isinstance(text, str)
        context, _ = json.JSONDecoder().raw_decode(text)
        assert isinstance(context, dict)
        self.contexts.append(context)
        proposal = self.decide(context)
        return canonical({"model": "offline-refiner", "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": dumps(proposal).decode()}]}],
            "usage": {"input_tokens": 1, "output_tokens": 1}})

    def lookup(self, operation_key: str) -> None:
        return None


class CounterProgram:
    def __init__(self, fixture: "AdaptationFixture") -> None:
        self.fixture = fixture

    def initialization(self, assignment: EpisodeAssignment) -> ArtifactRef:
        return self.fixture.objects.publish(b"{}")

    def operation(self, snapshot: EpisodeSnapshot, current: ArtifactRef, action: bytes) -> OperationRequest:
        from strive.vnext.benchmarks.api import ToolInvocation
        objects = self.fixture.objects
        if snapshot.version == 0:
            delta = json_object(action)["delta"]
            return OperationRequest(snapshot.episode, snapshot.environment, current, snapshot, "agent_tool",
                (ToolInvocation("move", "add", objects.publish(canonical({"delta": delta}))),))
        return OperationRequest(snapshot.episode, snapshot.environment, current, snapshot, "terminate", (objects.publish(canonical("done")),))


class AdaptationFixture:
    def __init__(self, root: Path, *, controller_editable: bool = False, contract: FeedbackContract = FeedbackContract.A) -> None:
        self.root = root
        self.store = ArtifactStore(root / "artifacts")
        self.objects = self.store.objects
        self.pin = self.objects.publish(b"M6 deterministic trusted setup")
        self.scope = AccessScope(RunId("run-1"), LineageId("development"), self.pin)
        self.editable = ("actor.code", "actor.prompts", "actor.memory") + (("controller.code",) if controller_editable else ())
        self.bundles = BundleManager(root / "bundles", self.objects, self.scope, self.editable)
        self.initial = self.bundles.initial({"actor/step.js": ACTOR, "controller/step.js": CONTROLLER,
            "prompts/delta.txt": b"1", "memory/delta.txt": b"0"}, self.pin)
        self.operations = OperationStore(root / "operations", self.objects, self.scope.run_id, self.pin, 1, create=True)
        self.adapter = CounterAdapter(self.operations, self.objects)
        self.upstream = ScriptedUpstream()
        self.contract = ProviderContract("fixture", "offline-refiner", "https://offline.invalid/generate", "responses-text/1",
            "no-credentials", self.pin, 100, 100, 1000000, 1000000, 0, 0, wall_milliseconds=3000)
        self.gateway = ModelGateway(root / "gateway", self.objects, self.contract, self.upstream)
        self.refiner = GatewayRefiner(self.gateway)
        self.provenance = ArtifactProvenance(root / "grants", self.objects, self.pin)
        operation_validator = OperationValidator(self.objects)
        generation_validator = GenerationValidator(self.objects)
        self.names = frozenset(spec.name for spec in self.adapter.describe().operations)
        bridge = BenchmarkEffectAdapter(self.adapter, self.objects, "local://counter", allowed_operations=self.names)
        rules = tuple(AdmissionRule("counter", "benchmark." + name, "local://counter", self.scope, self.pin,
            operation_validator.identity, 1000000, 128, (), True) for name in self.names) + (
            AdmissionRule("refiner", "model.generate", self.contract.endpoint, self.scope, self.refiner.identity,
                generation_validator.identity, 1000000, 128, self.contract.reservation(self.gateway.bound).components, True),)
        admission = ScopedAdmission(self.objects, self.provenance, rules, (operation_validator, generation_validator))
        self.broker = CapabilityBroker(self.objects, (), {"counter": bridge, "refiner": self.refiner}, admission)
        self.reader = self.store.create_run(self.scope.run_id, self.scope,
            {kind: self.adapter.scorer.identity if kind is ProducerKind.TRUSTED_SCORER else self.pin for kind in ProducerKind})
        self.writer = self.store.writer(self.scope.run_id)
        config = load_resolved_configuration(AUTHORED_TOML.replace("./artifact", self.pin.digest))
        self.model = ModelBinding("fixture", "offline-refiner", self.objects.publish(b"{}"), 100, 100, "forbid")
        binding = RunBinding(self.pin, self.pin, self.pin, self.pin, self.adapter.scorer.identity, self.pin,
            self.initial, tuple(replace(m, binding=self.model) if m.name == "refiner" else m for m in config.models), replace(config.budget, model_calls=100, tokens=100000, wall_seconds=600),
            self.broker.policy_reference, self.editable, replace(config.feedback, contract=contract), config.comparison,
            config.run.mode, DeclaredLineage(self.scope.lineage_id, None, None, self.pin), (), self.pin)
        self.writer.port(ProducerKind.RUN_SETUP).append(binding, causal=CausalIdentity(None, None, None, None), epoch=self.writer.epoch)
        self.backend = DenoSandbox(root / "scratch", SandboxLimits(wall_seconds=1, cpu_seconds=1))
        self._compose()

    def _compose(self) -> None:
        self.bundles.state = self.reader.verify
        self.sandbox = BundleSandbox(self.bundles, self.backend)
        self.supervisor = Supervisor(self.writer, self.broker, compatible_bundle=self.bundles.compatible, sandbox=self.sandbox)
        self.selector = EvidenceSelector(self.broker)
        self.policy = ContinualRefine(self.supervisor, self.bundles, self.sandbox, self.selector, self.provenance,
            RefinerRoute("refiner", self.contract.endpoint, self.model, self.contract.reservation(self.gateway.bound).components))

    def restart(self) -> None:
        self.writer.close()
        self.operations.close()
        self.bundles.close()
        self.writer = self.store.writer(self.scope.run_id)
        self.operations = OperationStore(self.root / "operations", self.objects, self.scope.run_id, self.pin, self.writer.epoch)
        self.adapter.store = self.operations
        self.adapter.scorer.store = self.operations
        self.bundles = BundleManager(self.root / "bundles", self.objects, self.scope, self.editable)
        self._compose()
        self.supervisor.recover()

    def proposal(self, *edits: Edit, **kwargs: object) -> Proposal:
        revision = self.supervisor.state.active_revision
        assert revision is not None
        # Callers that need nondefault fields use dataclasses.replace.
        assert not kwargs
        return Proposal(revision, "revise", edits)

    def step(self) -> dict[str, object]:
        self.supervisor.step(self.sandbox)
        return json_object(self.supervisor.state.private_state)

    @property
    def routes(self) -> dict[str, tuple[str, str]]:
        return {name: ("counter", "local://counter") for name in self.names}

    def assignments(self, count: int = 2) -> tuple[EpisodeAssignment, ...]:
        task = self.adapter.enumerate_tasks()[0]
        return tuple(EpisodeAssignment(EpisodeId("episode-" + str(i)), task, self.adapter.grouping, (task.task_id,)) for i in range(count))

    def initialize(self) -> EpisodeDriver:
        assignment = self.assignments(1)[0]
        driver = EpisodeDriver(self.supervisor, self.adapter, assignment, self.routes, self.provenance)
        current = self.supervisor.state.environment
        assert current is not None
        driver.perform(OperationRequest(assignment.episode, EnvironmentId(assignment.episode), current, None,
            "initialize", (assignment.task, self.objects.publish(b"{}"))))
        driver.consume()
        return driver

    def close(self) -> None:
        self.writer.close()
        self.operations.close()
        self.bundles.close()
        self.provenance.close()
        self.gateway.close()
