"""The only candidate command union and the bounded step signature (§3.1)."""

from dataclasses import dataclass
from typing import Protocol

from .annotations import Annotation
from .primitives import (
    ArtifactRef, EnvironmentId, ExecutionStatus, ResultCursor, RevisionId,
    RunId, ScopedArtifact,
)


@dataclass(frozen=True, slots=True)
class ExecuteEffect:
    operation: str
    binding: str
    request: ArtifactRef


@dataclass(frozen=True, slots=True)
class ApplyChange:
    next_bundle: ArtifactRef
    expected_active_revision: RevisionId
    controller_state: ArtifactRef | None = None


@dataclass(frozen=True, slots=True)
class RestoreBundle:
    prior_bundle: ArtifactRef
    expected_active_revision: RevisionId
    controller_state: ArtifactRef | None = None


@dataclass(frozen=True, slots=True)
class EvaluateFork:
    parent_run: RunId
    committed_cursor: int
    active_bundle: ArtifactRef
    continuation: ArtifactRef
    snapshot: ArtifactRef
    import_scope: ArtifactRef
    comparison_plan: ArtifactRef
    requested_allocation: ArtifactRef


@dataclass(frozen=True, slots=True)
class Continue:
    pass


@dataclass(frozen=True, slots=True)
class Suspend:
    reason: str


@dataclass(frozen=True, slots=True)
class Finish:
    reason: str


type Command = ExecuteEffect | ApplyChange | RestoreBundle | EvaluateFork | Continue | Suspend | Finish


@dataclass(frozen=True, slots=True)
class AuthorizedView:
    artifacts: tuple[ScopedArtifact, ...]
    active_revision: RevisionId
    environment: EnvironmentId
    execution_status: ExecutionStatus


@dataclass(frozen=True, slots=True)
class RecordedResult:
    cursor: ResultCursor
    output: ScopedArtifact


@dataclass(frozen=True, slots=True)
class StepOutput:
    command: Command
    proposed_private_state: bytes
    annotations: tuple[Annotation, ...] = ()


class Step(Protocol):
    def __call__(
        self,
        authorized_view: AuthorizedView,
        private_state: bytes,
        recorded_result: RecordedResult | None,
    ) -> StepOutput: ...
