"""A second benchmark: reach an integer target with bounded arithmetic moves."""
from decimal import Decimal
from pathlib import Path

from strive.benchmarks.api import (BenchmarkDescriptor, CapturedGeneration, EpisodeSnapshot, LookupResult,
    Metric, OperationContext, OperationReceipt, OperationSpec, RewardResult, ScoringInput, SplitSpec, TaskSpec,
    ToolInvocation, UserTurnPlan)
from strive.benchmarks.json_data import canonical, obj, parse
from strive.benchmarks.payloads import dumps, loads
from strive.benchmarks.store import OperationStore
from strive.codec import encode
from strive.contracts.lifecycle import RecoveryCapability, RecoveryContract
from strive.contracts.primitives import ArtifactRef, EffectId, EpisodeId
from strive.errors import VerificationError
from strive.store.cas import CAS


class TargetScorer:
    def __init__(self, store: OperationStore, identity: ArtifactRef) -> None:
        self.store, self.identity = store, identity

    def score(self, inputs: ScoringInput) -> RewardResult:
        objects = self.store.objects
        data = obj(parse(self.store.open(inputs.final_snapshot)))
        task = obj(parse(objects.read(inputs.task.definition)))
        receipts = tuple(loads(objects.read(ref), OperationReceipt) for ref in inputs.operation_receipts)
        if loads(objects.read(inputs.captured_interaction), tuple) != receipts or not receipts:
            raise VerificationError("counter scoring requires authenticated interaction")
        previous: EpisodeSnapshot | None = None
        for receipt in receipts:
            self.store._verify(receipt, inputs.final_snapshot.episode, receipt.effect_id, receipt.exact_request)
            if previous != receipt.before:
                raise VerificationError("counter scoring chain is incomplete")
            previous = receipt.after
        if previous != inputs.final_snapshot or task != data["task"] or parse(objects.read(inputs.termination)) != data["termination"]:
            raise VerificationError("counter scoring context differs from committed state")
        metric = objects.publish(encode(("integer-target-success/1", inputs.task.reward_definition)))
        return RewardResult("scored", (Metric(metric, Decimal(int(data["value"] == task["target"] and data["termination"] == "done"))),),
                            inputs.task.reward_definition, (inputs.final_snapshot.state,))


class CounterAdapter:
    def __init__(self, store: OperationStore, objects: CAS) -> None:
        self.store, self.objects, self.identity = store, objects, store.adapter
        source = objects.publish(Path(__file__).read_bytes())
        self._scorer = TargetScorer(store, objects.publish(encode(("integer-target-scorer/1", source))))
        reward = objects.publish(b"value equals target at explicit done termination")
        self.tasks = tuple(TaskSpec(name, name, objects.publish(canonical({"id": name, "target": target})), reward)
                           for name, target in (("reach-seven", 7), ("reach-minus-two", -2)))
        self.workload = objects.publish(dumps(self.tasks))
        self.grouping = objects.publish(b"two independent integer-target scenarios; retained order 7,-2")
        self.closure = objects.publish(encode(("integer-target-closure/1", source, self.workload)))

    @property
    def scorer(self) -> TargetScorer:
        return self._scorer

    def describe(self) -> BenchmarkDescriptor:
        recovery = RecoveryContract(frozenset({RecoveryCapability.OPERATION_LOOKUP}), True, False)
        operations = tuple(OperationSpec(name, self.objects.publish(encode(("integer-target-args/1", name))),
            self.objects.publish(encode(("integer-target-result/1", name))), recovery)
            for name in ("initialize", "agent_tool", "deliver_message", "terminate", "snapshot"))
        return BenchmarkDescriptor("strive.benchmark/1", self.workload, self.identity, "integer-target-fixture/1",
                                   self.closure, self.scorer.identity, operations, False, False)

    def enumerate_tasks(self) -> tuple[TaskSpec, ...]:
        return self.tasks

    def declare_splits(self) -> tuple[SplitSpec, ...]:
        return (SplitSpec("development", ("reach-seven",), self.grouping), SplitSpec("validation", ("reach-minus-two",), self.grouping))

    def initialize(self, context: OperationContext, task: TaskSpec, initialization: ArtifactRef) -> OperationReceipt:
        if task not in self.tasks or parse(self.objects.read(initialization)) != {}:
            raise VerificationError("invalid integer-target initialization")
        data = {"task": parse(self.objects.read(task.definition)), "value": 0, "moves": [], "termination": None}
        return self.store.commit(context, lambda state: (canonical(data), canonical({"target": obj(data["task"])["target"], "value": 0})))

    def agent_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        arguments = obj(parse(self.objects.read(call.arguments)))
        delta = arguments.get("delta")
        if call.name != "add" or set(arguments) != {"delta"} or type(delta) is not int or abs(delta) > 10:
            raise VerificationError("integer-target add requires bounded integer delta")
        def mutate(state: bytes | None) -> tuple[bytes, bytes]:
            assert state is not None and isinstance(delta, int)
            data = obj(parse(state))
            if data["termination"] is not None:
                raise VerificationError("integer-target episode terminated")
            value = data["value"]
            assert isinstance(value, int)
            data["value"] = value + delta
            return canonical(data), canonical({"value": value + delta})
        return self.store.commit(context, mutate)

    def plan_user_turn(self, snapshot: EpisodeSnapshot, delivered_message: ArtifactRef) -> None:
        return None

    def user_turn(self, context: OperationContext, plan: UserTurnPlan, generation: CapturedGeneration) -> OperationReceipt:
        raise VerificationError("integer-target has no user simulator")

    def user_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        raise VerificationError("integer-target has no user tools")

    def deliver_message(self, context: OperationContext, message: ArtifactRef) -> OperationReceipt:
        return self.snapshot(context)

    def terminate(self, context: OperationContext, termination: ArtifactRef) -> OperationReceipt:
        reason = parse(self.objects.read(termination))
        if reason not in ("done", "budget_exhausted"):
            raise VerificationError("unknown integer-target termination")
        def mutate(state: bytes | None) -> tuple[bytes, bytes]:
            assert state is not None
            data = obj(parse(state)); data["termination"] = reason
            return canonical(data), canonical({"termination": reason})
        return self.store.commit(context, mutate)

    def snapshot(self, context: OperationContext) -> OperationReceipt:
        def copy(state: bytes | None) -> tuple[bytes, bytes]:
            assert state is not None
            return state, canonical({"value": obj(parse(state))["value"]})
        return self.store.commit(context, copy)

    def lookup_operation(self, episode: EpisodeId, effect_id: EffectId, exact_request: ArtifactRef) -> LookupResult:
        return self.store.lookup(episode, effect_id, exact_request)

    def open_committed_snapshot(self, snapshot: EpisodeSnapshot) -> None:
        self.store.open(snapshot)
