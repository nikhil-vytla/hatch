"""EXPERIMENTAL — Stage-3 provisional contracts (see docs/adrs/ freeze table).

The frozen core wire types moved to their permanent home in
``strive.revisions`` when Stage 3B landed; they are re-exported here so the
Stage-3A spike tests keep validating them unchanged. The evidence and
selection envelopes (DatasetRevision / EvaluationManifest / ValidatorResult /
ValidationBundle / DecisionEvidence / SelectionDecision / ObjectiveSpec /
TaskSpecVersion) were FROZEN by the Stage-3C.2A slice and moved to their
permanent home in ``strive.evidence`` (re-exported here). Still PROVISIONAL
until their own slices: the Environment session protocols, AlgorithmRun /
AlgorithmStep, and detailed storage-backend schemas. Known unresolved needs
are recorded in docs/adrs/README.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage

from strive.evidence import (  # noqa: F401 — re-exported frozen envelopes
    DISPOSITIONS,
    DatasetRevision,
    DecisionEvidence,
    EvaluationManifest,
    ObjectiveSpec,
    SelectionDecision,
    TaskSpecVersion,
    VALIDATOR_FAILED,
    VALIDATOR_INCONCLUSIVE,
    VALIDATOR_PASSED,
    ValidationBundle,
    ValidatorResult,
    validate_selection,
)

__all__ = [  # re-exported frozen core + the provisional contracts below
    "ABSENT",
    "ACTIVATION_DURABLE",
    "ACTIVATION_PROVISIONAL",
    "ACTIVATION_REASONS",
    "ALGORITHM_COMPLETED",
    "ALGORITHM_HALTED",
    "ALGORITHM_RUNNING",
    "ALLOWED_PARAM_FAMILIES",
    "AlgorithmRun",
    "AlgorithmStep",
    "BINDING_ABSENT",
    "BINDING_CONTENT",
    "BINDING_MASKED",
    "BINDING_STATES",
    "BindingState",
    "CURRENT_DESCRIPTOR",
    "Checkpointable",
    "ContractViolation",
    "DESCRIPTOR_REGISTRY",
    "DISPOSITIONS",
    "DatasetRevision",
    "DecisionEvidence",
    "EnvironmentSession",
    "EvaluationManifest",
    "FORBIDDEN_PARAM_FAMILIES",
    "Forkable",
    "GLOBAL_SCOPE",
    "HarnessRevision",
    "JournalHeadRef",
    "LEVEL_GLOBAL",
    "LEVEL_PROJECT",
    "LEVEL_RUN",
    "LEVEL_TASK",
    "MASKED",
    "ManifestBinding",
    "MigrationProvenance",
    "ObjectiveSpec",
    "RISK_HIGH",
    "RISK_LOW",
    "RISK_MEDIUM",
    "RISK_POLICIES",
    "Resettable",
    "ResolutionContext",
    "ResolvedHarnessManifest",
    "RevisionActivation",
    "RevisionRef",
    "SCOPE_LEVELS",
    "SURFACE_KINDS",
    "SURFACE_POLICY_PARAMS",
    "SURFACE_PROMPT",
    "SURFACE_STRATEGY_CODE",
    "ScopeContribution",
    "ScopeManifest",
    "ScopeRef",
    "SelectionDecision",
    "SurfaceDelta",
    "SurfaceDescriptor",
    "TaskSpecVersion",
    "VALIDATOR_FAILED",
    "VALIDATOR_INCONCLUSIVE",
    "VALIDATOR_PASSED",
    "ValidationBundle",
    "ValidatorResult",
    "check_delta_applies",
    "content_binding",
    "current_descriptor",
    "delta_label",
    "descriptor_for",
    "effective_risk",
    "invert_delta",
    "resolve_bindings",
    "revision_activation_from_activation",
    "revision_from_generation",
    "validate_binding",
    "validate_delta",
    "validate_param_name",
    "validate_resolved_manifest",
    "validate_revision",
    "validate_revision_activation",
    "validate_scope",
    "validate_scope_manifest",
    "validate_selection",
]

from strive.revisions import (  # noqa: F401 — re-exported frozen core
    ABSENT,
    ACTIVATION_DURABLE,
    ACTIVATION_PROVISIONAL,
    ACTIVATION_REASONS,
    ALLOWED_PARAM_FAMILIES,
    BINDING_ABSENT,
    BINDING_CONTENT,
    BINDING_MASKED,
    BINDING_STATES,
    BindingState,
    CURRENT_DESCRIPTOR,
    ContractViolation,
    DESCRIPTOR_REGISTRY,
    FORBIDDEN_PARAM_FAMILIES,
    GLOBAL_SCOPE,
    HarnessRevision,
    JournalHeadRef,
    LEVEL_GLOBAL,
    LEVEL_PROJECT,
    LEVEL_RUN,
    LEVEL_TASK,
    MASKED,
    ManifestBinding,
    MigrationProvenance,
    RISK_HIGH,
    RISK_LOW,
    RISK_MEDIUM,
    RISK_POLICIES,
    ResolutionContext,
    ResolvedHarnessManifest,
    RevisionActivation,
    RevisionRef,
    SCOPE_LEVELS,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    SURFACE_KINDS,
    SURFACE_POLICY_PARAMS,
    SURFACE_PROMPT,
    SURFACE_STRATEGY_CODE,
    SurfaceDelta,
    SurfaceDescriptor,
    check_delta_applies,
    content_binding,
    current_descriptor,
    delta_label,
    descriptor_for,
    effective_risk,
    invert_delta,
    resolve_bindings,
    revision_activation_from_activation,
    revision_from_generation,
    validate_binding,
    validate_delta,
    validate_param_name,
    validate_resolved_manifest,
    validate_revision,
    validate_revision_activation,
    validate_scope,
    validate_scope_manifest,
)

# ======================================================================================
# PROVISIONAL CONTRACTS — the shapes below are NOT yet frozen; each is
# finalized by its own implementation slice. (Typed evidence roles and
# policy-neutral decisions were settled by Stage 3C.2A in strive.evidence.)
# Remaining unresolved needs, per ADR README: typed object refs instead of
# bare strings; frontier removal/snapshot records; objective + RNG +
# algorithm-state refs for bit-reproducible resumable search.
# ======================================================================================


class EnvironmentSession(Protocol):
    """PROVISIONAL. Base episodic session; reset is a capability, not a
    requirement."""

    def observation(self) -> object: ...
    def act(self, action: object) -> object: ...
    def done(self) -> bool: ...
    def close(self) -> None: ...


class Resettable(Protocol):
    def reset(self, case_ref: str, seed: int) -> None: ...


class Checkpointable(Protocol):
    def checkpoint(self) -> str: ...
    def restore(self, checkpoint_ref: str) -> None: ...


class Forkable(Protocol):
    def fork(self) -> EnvironmentSession: ...


ALGORITHM_RUNNING = "running"
ALGORITHM_COMPLETED = "completed"
ALGORITHM_HALTED = "halted"


@register("algorithm-run", 1)
@dataclass(frozen=True)
class AlgorithmRun:
    """PROVISIONAL. Journaled search state: enough to *restart* from the last
    journaled step. Bit-reproducible resumption additionally needs objective,
    RNG-state, and algorithm-state refs — an unresolved need recorded in the
    adrs/README freeze table, settled by the algorithm slice."""

    algorithm: str
    run_id: str
    scope: ScopeRef
    budget: BudgetSpec
    status: str
    steps_completed: int


@register("algorithm-step", 1)
@dataclass(frozen=True)
class AlgorithmStep:
    """PROVISIONAL."""

    run_id: str
    step_index: int
    action: str
    subject_ref: str
    detail: str
    usage: BudgetUsage
