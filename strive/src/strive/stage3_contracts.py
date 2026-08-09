"""EXPERIMENTAL — Stage-3 provisional contracts (see docs/adrs/ freeze table).

The frozen core wire types moved to their permanent home in
``strive.revisions`` when Stage 3B landed; they are re-exported here so the
Stage-3A spike tests keep validating them unchanged. Everything defined
*below* is PROVISIONAL until its own implementation slice: TaskSpecVersion /
DatasetRevision / EvaluationManifest, ValidatorResult / ValidationBundle /
SelectionDecision (and frontier semantics), AlgorithmRun / AlgorithmStep,
and detailed storage-backend schemas. Known unresolved needs are recorded in
docs/adrs/README.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage

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
# PROVISIONAL CONTRACTS — shapes below are NOT frozen for Stage 3B; each is
# finalized by its own implementation slice. Known unresolved needs, recorded
# per ADR README: typed object refs instead of bare strings; typed evidence
# roles (baseline vs candidate bundles); policy-detail refs on decisions;
# frontier removal/snapshot records; objective + RNG + algorithm-state refs
# for resumable search.
# ======================================================================================


@register("task-spec", 1)
@dataclass(frozen=True)
class TaskSpecVersion:
    """PROVISIONAL. Immutable, environment-generic task identity."""

    task_id: str
    version: int
    description: str
    environment: str  # adapter id@version, e.g. function-task@1
    action_schema: str
    observation_schema: str
    scorer: str  # id@version
    config_ref: str  # CAS ref of adapter-specific config (signature/catalog live here)
    fingerprint: str


@register("dataset-revision", 1)
@dataclass(frozen=True)
class DatasetRevision:
    """PROVISIONAL. Append-friendly, reconstructable evaluation data."""

    dataset_id: str
    revision: int
    parent_revision: int | None
    reason: str
    split_manifest_refs: dict[str, str]
    split_counts: dict[str, int]
    fingerprint: str


@register("evaluation-manifest", 1)
@dataclass(frozen=True)
class EvaluationManifest:
    """PROVISIONAL. Everything a validation ran under. References the
    run-resolved manifest — never a revision's own scope manifest."""

    resolved_manifest_ref: str
    objective_spec_ref: str
    task_fingerprint: str
    dataset_fingerprint: str
    environment: str
    scorer: str
    tool_versions: dict[str, str]
    runtime: str
    seeds: tuple[int, ...]
    validators: tuple[str, ...]
    budget: BudgetSpec


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


VALIDATOR_PASSED = "passed"
VALIDATOR_FAILED = "failed"
VALIDATOR_INCONCLUSIVE = "inconclusive"


@register("validator-result", 1)
@dataclass(frozen=True)
class ValidatorResult:
    """PROVISIONAL."""

    validator: str
    status: str
    metrics: dict[str, float]
    detail: str
    artifact_ref: str | None = None


@register("validation-bundle", 1)
@dataclass(frozen=True)
class ValidationBundle:
    """PROVISIONAL. Evidence pins the evaluation manifest it ran under."""

    evaluation_manifest_ref: str
    subject: RevisionRef
    results: tuple[ValidatorResult, ...]
    feedback: str


DISPOSITIONS = ("promote", "reject", "frontier_add", "provisional_activate")


@register("selection-decision", 1)
@dataclass(frozen=True)
class SelectionDecision:
    """PROVISIONAL. Policy-neutral conclusion; every disposition requires
    evidence."""

    policy_ref: str
    objective_spec_ref: str
    disposition: str
    subject: RevisionRef
    incumbent: RevisionRef | None
    evidence_refs: tuple[str, ...]
    rationale: str
    at: str


def validate_selection(decision: SelectionDecision) -> None:
    if decision.disposition not in DISPOSITIONS:
        raise ContractViolation(f"unknown disposition {decision.disposition!r}")
    if "@" not in decision.policy_ref:
        raise ContractViolation(
            f"policy_ref {decision.policy_ref!r} must be versioned (name@version)"
        )
    if not decision.objective_spec_ref:
        raise ContractViolation("a decision must pin its objective spec")
    if not decision.evidence_refs:
        raise ContractViolation(
            f"disposition {decision.disposition!r} requires evidence bundles"
        )
    validate_scope(decision.subject.scope)


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
