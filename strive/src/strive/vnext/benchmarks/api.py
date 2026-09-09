"""strive.benchmark/1. Implementation types, never authority wire records."""
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

from strive.vnext.contracts.lifecycle import RecoveryContract
from strive.vnext.contracts.primitives import (
    ArtifactRef,
    EffectId,
    EnvironmentId,
    EpisodeId,
    ResultCursor,
)
from strive.vnext.contracts.records import EffectAuthorization


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    scenario_group: str
    definition: ArtifactRef
    reward_definition: ArtifactRef


@dataclass(frozen=True)
class SplitSpec:
    name: str
    task_ids: tuple[str, ...]
    grouping_definition: ArtifactRef


@dataclass(frozen=True)
class OperationSpec:
    name: str
    argument_schema: ArtifactRef
    result_schema: ArtifactRef
    recovery: RecoveryContract


@dataclass(frozen=True)
class BenchmarkDescriptor:
    protocol: Literal["strive.benchmark/1"]
    workload: ArtifactRef
    implementation: ArtifactRef
    upstream_revision: str
    closure: ArtifactRef
    scorer: ArtifactRef
    operations: tuple[OperationSpec, ...]
    has_user_simulator: bool
    supports_forks: bool


@dataclass(frozen=True)
class EpisodeSnapshot:
    episode: EpisodeId
    environment: EnvironmentId
    version: int
    state: ArtifactRef


@dataclass(frozen=True)
class OperationContext:
    authorization: EffectAuthorization
    episode: EpisodeId
    arguments: ArtifactRef
    expected_snapshot: EpisodeSnapshot | None


@dataclass(frozen=True)
class ToolInvocation:
    call_id: str
    name: str
    arguments: ArtifactRef


@dataclass(frozen=True)
class CapturedGeneration:
    result_cursor: ResultCursor
    request: ArtifactRef
    response: ArtifactRef


@dataclass(frozen=True)
class UserTurnPlan:
    snapshot: EpisodeSnapshot
    generation_input: ArtifactRef
    response_schema: ArtifactRef


@dataclass(frozen=True)
class OperationReceipt:
    effect_id: EffectId
    original_epoch: int
    exact_request: ArtifactRef
    arguments: ArtifactRef
    before: EpisodeSnapshot | None
    after: EpisodeSnapshot
    output: ArtifactRef
    evidence: ArtifactRef


@dataclass(frozen=True)
class FoundOperation:
    receipt: OperationReceipt


@dataclass(frozen=True)
class ProvenAbsent:
    proof: ArtifactRef


@dataclass(frozen=True)
class UnknownOperation:
    reason: ArtifactRef


type LookupResult = FoundOperation | ProvenAbsent | UnknownOperation


@dataclass(frozen=True)
class ScoringInput:
    task: TaskSpec
    final_snapshot: EpisodeSnapshot
    captured_interaction: ArtifactRef
    operation_receipts: tuple[ArtifactRef, ...]
    termination: ArtifactRef


@dataclass(frozen=True)
class Metric:
    identity: ArtifactRef
    value: Decimal


@dataclass(frozen=True)
class RewardResult:
    status: Literal["scored", "unresolved", "invalid"]
    metrics: tuple[Metric, ...]
    exact_reward_definition: ArtifactRef
    evidence: tuple[ArtifactRef, ...]


class TrustedScorer(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...

    def score(self, inputs: ScoringInput) -> RewardResult: ...


class BenchmarkAdapter(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...

    @property
    def scorer(self) -> TrustedScorer: ...

    def describe(self) -> BenchmarkDescriptor: ...

    def enumerate_tasks(self) -> tuple[TaskSpec, ...]: ...

    def declare_splits(self) -> tuple[SplitSpec, ...]: ...

    def initialize(
        self,
        context: OperationContext,
        task: TaskSpec,
        initialization: ArtifactRef,
    ) -> OperationReceipt: ...

    def agent_tool(
        self,
        context: OperationContext,
        call: ToolInvocation,
    ) -> OperationReceipt: ...

    def plan_user_turn(
        self,
        snapshot: EpisodeSnapshot,
        delivered_message: ArtifactRef,
    ) -> UserTurnPlan | None: ...

    def user_turn(
        self,
        context: OperationContext,
        plan: UserTurnPlan,
        generation: CapturedGeneration,
    ) -> OperationReceipt: ...

    def user_tool(
        self,
        context: OperationContext,
        call: ToolInvocation,
    ) -> OperationReceipt: ...

    def deliver_message(
        self,
        context: OperationContext,
        message: ArtifactRef,
    ) -> OperationReceipt: ...

    def terminate(
        self,
        context: OperationContext,
        termination: ArtifactRef,
    ) -> OperationReceipt: ...

    def snapshot(
        self,
        context: OperationContext,
    ) -> OperationReceipt: ...

    def lookup_operation(
        self,
        episode: EpisodeId,
        effect_id: EffectId,
        exact_request: ArtifactRef,
    ) -> LookupResult: ...

    def open_committed_snapshot(
        self,
        snapshot: EpisodeSnapshot,
    ) -> None: ...
