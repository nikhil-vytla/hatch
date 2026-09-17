"""Dependency-light RPC client. The implementation/scorer/store stay remote.

This is the only telecom module needed by the execution composition root.
Verifier startup never imports it. Transport accepts only closed benchmark
payloads and a fixed, separately installed adapter interpreter.
"""
from pathlib import Path
import subprocess
from typing import TypeVar

from strive.benchmarks.api import (BenchmarkDescriptor, CapturedGeneration, EpisodeSnapshot, FoundOperation,
    LookupResult, OperationContext, OperationReceipt, ProvenAbsent, RewardResult, ScoringInput, SplitSpec,
    TaskSpec, ToolInvocation, UnknownOperation, UserTurnPlan)
from strive.benchmarks.payloads import dumps, loads
from strive.contracts.primitives import ArtifactRef, EffectId, EpisodeId
from strive.errors import VerificationError

T = TypeVar("T")


class RemoteScorer:
    def __init__(self, client: "Tau2Client", identity: ArtifactRef) -> None:
        self.client, self.identity = client, identity

    def score(self, inputs: ScoringInput) -> RewardResult:
        return self.client.call("score", (inputs,), RewardResult)


class Tau2Client:
    def __init__(self, python: Path, data_root: Path, configuration: tuple[object, ...],
                 identity: ArtifactRef, *, bootstrap: bool = False) -> None:
        self.python, self.data_root, self.configuration = python.absolute(), data_root.resolve(), configuration
        self.identity = identity
        descriptor = self.call("bootstrap" if bootstrap else "describe", (), BenchmarkDescriptor)
        if descriptor.implementation != identity:
            raise VerificationError("remote adapter implementation identity mismatch")
        self._descriptor = descriptor
        self._scorer = RemoteScorer(self, descriptor.scorer)

    def call(self, operation: str, arguments: tuple[object, ...], expected: type[T]) -> T:
        result = subprocess.run([str(self.python), "-I", "-B", "-m", "strive_benchmark_tau2.server"],
            input=dumps((self.configuration, operation, arguments)), capture_output=True, timeout=90,
            cwd=self.data_root, env={"TAU2_DATA_DIR": str(self.data_root), "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"})
        if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
            raise VerificationError("remote benchmark operation failed: " + result.stderr[-4000:].decode(errors="replace"))
        return loads(result.stdout, expected)

    @property
    def scorer(self) -> RemoteScorer:
        return self._scorer

    def describe(self) -> BenchmarkDescriptor:
        return self._descriptor

    def enumerate_tasks(self) -> tuple[TaskSpec, ...]:
        value = self.call("enumerate_tasks", (), tuple)
        if not all(isinstance(task, TaskSpec) for task in value):
            raise VerificationError("invalid remote task inventory")
        return tuple(task for task in value if isinstance(task, TaskSpec))

    def declare_splits(self) -> tuple[SplitSpec, ...]:
        value = self.call("declare_splits", (), tuple)
        if not all(isinstance(split, SplitSpec) for split in value):
            raise VerificationError("invalid remote splits")
        return tuple(split for split in value if isinstance(split, SplitSpec))

    def initialize(self, context: OperationContext, task: TaskSpec, initialization: ArtifactRef) -> OperationReceipt:
        return self.call("initialize", (context, task, initialization), OperationReceipt)

    def agent_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        return self.call("agent_tool", (context, call), OperationReceipt)

    def plan_user_turn(self, snapshot: EpisodeSnapshot, delivered_message: ArtifactRef) -> UserTurnPlan | None:
        return self.call("plan_user_turn", (snapshot, delivered_message), UserTurnPlan)

    def user_turn(self, context: OperationContext, plan: UserTurnPlan, generation: CapturedGeneration) -> OperationReceipt:
        return self.call("user_turn", (context, plan, generation), OperationReceipt)

    def user_tool(self, context: OperationContext, call: ToolInvocation) -> OperationReceipt:
        return self.call("user_tool", (context, call), OperationReceipt)

    def deliver_message(self, context: OperationContext, message: ArtifactRef) -> OperationReceipt:
        return self.call("deliver_message", (context, message), OperationReceipt)

    def terminate(self, context: OperationContext, termination: ArtifactRef) -> OperationReceipt:
        return self.call("terminate", (context, termination), OperationReceipt)

    def snapshot(self, context: OperationContext) -> OperationReceipt:
        return self.call("snapshot", (context,), OperationReceipt)

    def lookup_operation(self, episode: EpisodeId, effect_id: EffectId, exact_request: ArtifactRef) -> LookupResult:
        value = self.call("lookup_operation", (episode, effect_id, exact_request), object)
        if not isinstance(value, (FoundOperation, ProvenAbsent, UnknownOperation)):
            raise VerificationError("invalid remote lookup result")
        return value

    def open_committed_snapshot(self, snapshot: EpisodeSnapshot) -> None:
        self.call("open_committed_snapshot", (snapshot,), type(None))
