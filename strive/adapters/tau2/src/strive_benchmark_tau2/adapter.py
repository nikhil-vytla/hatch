"""Telecom implementation of strive.benchmark/1, with a separate upstream worker."""
from decimal import Decimal
from pathlib import Path
from typing import Protocol

from strive.vnext.benchmarks.api import (BenchmarkDescriptor, CapturedGeneration, EpisodeSnapshot, LookupResult,
    Metric, OperationContext, OperationReceipt, OperationSpec, RewardResult, ScoringInput, SplitSpec, TaskSpec,
    ToolInvocation, UserTurnPlan)
from strive.vnext.benchmarks.json_data import canonical, obj, parse, items, string
from strive.vnext.benchmarks.payloads import dumps, loads
from strive.vnext.benchmarks.store import OperationStore
from strive.vnext.codec import encode
from strive.vnext.contracts.lifecycle import RecoveryCapability, RecoveryContract
from strive.vnext.contracts.primitives import ArtifactRef, EffectId, EpisodeId
from strive.vnext.errors import VerificationError
from strive.vnext.store.cas import CAS
from . import UPSTREAM_REVISION
from .qualification import Qualification
from .splits import scenario_group


class TelecomBackend(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...
    def call(self, operation: str, state: bytes | None, payload: bytes) -> tuple[bytes, bytes]: ...


class TelecomScorer:
    def __init__(self, store: OperationStore, backend: TelecomBackend, identity: ArtifactRef) -> None:
        self.store, self.backend, self.identity = store, backend, identity

    def score(self, inputs: ScoringInput) -> RewardResult:
        objects = self.store.objects
        state = self.store.open(inputs.final_snapshot)
        receipts = tuple(loads(objects.read(ref), OperationReceipt) for ref in inputs.operation_receipts)
        if loads(objects.read(inputs.captured_interaction), tuple) != receipts:
            raise VerificationError("forged captured interaction")
        previous: EpisodeSnapshot | None = None
        for receipt in receipts:
            self.store._verify(receipt, inputs.final_snapshot.episode, receipt.effect_id, receipt.exact_request)
            if receipt.before != previous:
                raise VerificationError("scoring receipts omit/reorder operations")
            previous = receipt.after
        if previous != inputs.final_snapshot:
            raise VerificationError("scoring receipt chain is incomplete")
        payload = canonical({"task": parse(objects.read(inputs.task.definition)),
                             "termination": parse(objects.read(inputs.termination))})
        _, output = self.backend.call("score", state, payload)
        result = obj(parse(output))
        evidence = objects.publish(output)
        metric = objects.publish(encode(("tau2-deterministic-success/1", inputs.task.reward_definition)))
        if result.get("status") != "scored":
            return RewardResult("invalid", (), inputs.task.reward_definition, (evidence,))
        value = result.get("value")
        if value not in (0, 1):
            raise VerificationError("unexpected telecom success value")
        return RewardResult("scored", (Metric(metric, Decimal(str(value))),), inputs.task.reward_definition, (evidence,))


def implementation_identity(objects: CAS, backend: TelecomBackend, qualification: Qualification, closure: ArtifactRef) -> ArtifactRef:
    sources = tuple(objects.publish(path.read_bytes()) for path in sorted(Path(__file__).parent.glob("*.py")))
    return objects.publish(encode(("strive-tau2-adapter/1", UPSTREAM_REVISION, sources, backend.identity, qualification.report, closure)))


class Tau2Adapter:
    def __init__(self, objects: CAS, backend: TelecomBackend, tasks: tuple[TaskSpec, ...],
                 qualification: Qualification, closure: ArtifactRef, store: OperationStore) -> None:
        self.objects, self.backend, self.tasks, self.qualification, self.store = objects, backend, tasks, qualification, store
        self.identity = implementation_identity(objects, backend, qualification, closure)
        if store.adapter != self.identity:
            raise VerificationError("operation store differs from pinned adapter implementation")
        for ref in (closure, qualification.inventory, qualification.source_splits, qualification.implementation, qualification.report):
            objects.read(ref)
        self.closure = closure
        self._scorer = TelecomScorer(store, backend, objects.publish(encode(("telecom-scorer/1", backend.identity,
            objects.publish(Path(__file__).read_bytes())))))
        admitted = set(qualification.development + qualification.validation + qualification.audit)
        if {task.task_id for task in tasks} != admitted:
            raise VerificationError("adapter task set differs from qualified base inventory")
        inventory = parse(objects.read(qualification.inventory))
        if isinstance(inventory, dict):
            inventory = inventory.get("tasks")
        index = {string(obj(task)["id"]): obj(task) for task in items(inventory)}
        for task in tasks:
            original = index[task.task_id]
            if (task.scenario_group != scenario_group(original)
                    or objects.read(task.definition) != canonical(original)
                    or objects.read(task.reward_definition) != canonical(original["evaluation_criteria"])):
                raise VerificationError("task/reward definition differs from qualified source inventory")
        self._operations = tuple(OperationSpec(name, objects.publish(encode(("telecom-arguments/1", name))),
            objects.publish(encode(("telecom-result/1", name))), RecoveryContract(
                frozenset({RecoveryCapability.OPERATION_LOOKUP, RecoveryCapability.SUSPEND}), True, False))
            for name in ("initialize", "agent_tool", "user_tool", "user_turn", "deliver_message", "terminate", "snapshot"))

    @property
    def scorer(self) -> TelecomScorer:
        return self._scorer

    def describe(self) -> BenchmarkDescriptor:
        return BenchmarkDescriptor("strive.benchmark/1", self.qualification.inventory, self.identity,
            UPSTREAM_REVISION, self.closure, self.scorer.identity, self._operations, True, False)

    def enumerate_tasks(self) -> tuple[TaskSpec, ...]:
        return self.tasks

    def declare_splits(self) -> tuple[SplitSpec, ...]:
        if self.qualification.mode == "fixed-stock":
            return (SplitSpec("test", self.qualification.audit, self.qualification.report),)
        return tuple(SplitSpec(name, ids, self.qualification.report) for name, ids in (
            ("development", self.qualification.development), ("validation", self.qualification.validation),
            ("audit", self.qualification.audit)))

    def _commit(self, context: OperationContext, operation: str, payload: bytes) -> OperationReceipt:
        if context.authorization.operation != "benchmark." + operation:
            raise VerificationError("telecom operation/requestor mismatch")
        return self.store.commit(context, lambda state: self.backend.call(operation, state, payload))

    def initialize(self, context: OperationContext, task: TaskSpec, initialization: ArtifactRef) -> OperationReceipt:
        if task not in self.tasks:
            raise VerificationError("unqualified task")
        settings = obj(parse(self.objects.read(initialization)))
        if set(settings) - {"seed", "model", "model_settings", "persona"}:
            raise VerificationError("unsupported initialization or fork origin")
        return self._commit(context, "initialize", canonical({"task": parse(self.objects.read(task.definition)),
            "initialization": settings, "identities": {
                "task": task.definition.digest, "policy_schemas_dependencies": self.closure.digest,
                "qualification": self.qualification.report.digest, "adapter": self.identity.digest}}))

    def agent_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        return self._tool(context, call, "agent_tool")

    def user_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        return self._tool(context, call, "user_tool")

    def _tool(self, context: OperationContext, call: ToolInvocation, operation: str) -> OperationReceipt:
        return self._commit(context, operation, canonical({"id": call.call_id, "name": call.name,
            "arguments": parse(self.objects.read(call.arguments)), "requestor": "user" if operation == "user_tool" else "assistant"}))

    def plan_user_turn(self, snapshot: EpisodeSnapshot, delivered_message: ArtifactRef) -> UserTurnPlan | None:
        state = self.store.open(snapshot)
        _, plan = self.backend.call("plan_user_turn", state, self.objects.read(delivered_message))
        return UserTurnPlan(snapshot, self.objects.publish(plan), self.objects.publish(encode(("structured-user-response/1", self.backend.identity))))

    def user_turn(self, context: OperationContext, plan: UserTurnPlan, generation: CapturedGeneration) -> OperationReceipt:
        if context.expected_snapshot != plan.snapshot or generation.request != plan.generation_input:
            raise VerificationError("user generation does not match pending plan")
        payload = canonical({"plan": parse(self.objects.read(plan.generation_input)),
            "response": parse(self.objects.read(generation.response)), "capture": {
                "effect": generation.result_cursor.effect_id, "record": generation.result_cursor.return_record_id,
                "request": generation.request.digest, "response": generation.response.digest}})
        def mutate(state: bytes | None) -> tuple[bytes, bytes]:
            updated, output = self.backend.call("user_turn", state, payload)
            response = obj(parse(output))
            calls = tuple(ToolInvocation(string(obj(call)["id"]), string(obj(call)["name"]),
                self.objects.publish(canonical(obj(call)["arguments"]))) for call in items(response.get("tool_calls") or []))
            return updated, dumps(("user-turn/1", self.objects.publish(output), calls))
        return self.store.commit(context, mutate)

    def deliver_message(self, context: OperationContext, message: ArtifactRef) -> OperationReceipt:
        return self._commit(context, "deliver_message", self.objects.read(message))

    def terminate(self, context: OperationContext, termination: ArtifactRef) -> OperationReceipt:
        return self._commit(context, "terminate", self.objects.read(termination))

    def snapshot(self, context: OperationContext) -> OperationReceipt:
        return self._commit(context, "snapshot", b"{}")

    def lookup_operation(self, episode: EpisodeId, effect_id: EffectId, exact_request: ArtifactRef) -> LookupResult:
        return self.store.lookup(episode, effect_id, exact_request)

    def open_committed_snapshot(self, snapshot: EpisodeSnapshot) -> None:
        self.store.open(snapshot)
