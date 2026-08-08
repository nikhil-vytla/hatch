"""EXPERIMENTAL — Stage 3A contract spike (see docs/adrs/).

These typed contracts exist to validate the ADR designs with round-trip tests
before Stage 3B implements them for real. Nothing in the live loop imports
this module; the registered codec kinds are new and additive; shapes here MAY
still change without migration until Stage 3B freezes them. The live ledger
keeps writing generation@2 — `revision_from_generation` is the compatibility
mapping ADR-0001 commits to.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive.codec import register
from strive.contracts import BudgetSpec, Generation

# -- ADR-0001: surfaces ----------------------------------------------------------

SURFACE_STRATEGY_CODE = "strategy-code"
SURFACE_PROMPT = "prompt"
SURFACE_POLICY_PARAMS = "policy-params"

RISK_HIGH = "high"
RISK_MEDIUM = "medium"
RISK_LOW = "low"

OP_CREATE = "create"
OP_UPDATE = "update"
OP_DELETE = "delete"


@dataclass(frozen=True)
class SurfaceDescriptor:
    """Trusted allowlist entry for an evolvable surface kind (kernel data,
    never persisted as evolvable state; the loop cannot extend the registry)."""

    kind: str
    risk_tier: str
    online_adaptable: bool
    materializer: str
    description: str


SURFACE_REGISTRY: dict[str, SurfaceDescriptor] = {
    SURFACE_STRATEGY_CODE: SurfaceDescriptor(
        kind=SURFACE_STRATEGY_CODE,
        risk_tier=RISK_HIGH,
        online_adaptable=False,
        materializer="sandbox-file",
        description="executable strategy module, run only out-of-process",
    ),
    SURFACE_PROMPT: SurfaceDescriptor(
        kind=SURFACE_PROMPT,
        risk_tier=RISK_MEDIUM,
        online_adaptable=False,  # stage 5 may relax, per descriptor not code
        materializer="kernel-text",
        description="text consumed by kernel-side model calls",
    ),
    SURFACE_POLICY_PARAMS: SurfaceDescriptor(
        kind=SURFACE_POLICY_PARAMS,
        risk_tier=RISK_LOW,
        online_adaptable=False,
        materializer="kernel-params",
        description="typed parameter bundle read by trusted components",
    ),
}


@register("surface-artifact", 1)
@dataclass(frozen=True)
class SurfaceArtifact:
    kind: str
    name: str
    scope: str
    content_ref: str
    created_at: str


@register("surface-delta", 1)
@dataclass(frozen=True)
class SurfaceDelta:
    """Typed CRUD over one surface artifact (ADR-0001)."""

    op: str  # create | update | delete
    kind: str
    name: str
    before_ref: str | None
    after_ref: str | None
    risk_tier: str


@register("revision", 1)
@dataclass(frozen=True)
class HarnessRevision:
    """The composite unit of evolution replacing one-generation-one-file."""

    revision_id: str
    scope: str
    parent_ids: tuple[str, ...]
    deltas: tuple[SurfaceDelta, ...]
    manifest_ref: str | None
    proposer: str
    summary: str
    created_at: str


class ContractViolation(Exception):
    """A stage-3 contract's structural rules were broken."""


def validate_delta(delta: SurfaceDelta) -> None:
    if delta.kind not in SURFACE_REGISTRY:
        raise ContractViolation(
            f"surface kind {delta.kind!r} is not in the trusted registry "
            f"{sorted(SURFACE_REGISTRY)}"
        )
    if delta.op == OP_CREATE and not (delta.before_ref is None and delta.after_ref):
        raise ContractViolation(f"create delta {delta.name!r} must have only after_ref")
    if delta.op == OP_DELETE and not (delta.after_ref is None and delta.before_ref):
        raise ContractViolation(f"delete delta {delta.name!r} must have only before_ref")
    if delta.op == OP_UPDATE and not (delta.before_ref and delta.after_ref):
        raise ContractViolation(f"update delta {delta.name!r} must have both refs")
    if delta.op not in (OP_CREATE, OP_UPDATE, OP_DELETE):
        raise ContractViolation(f"unknown delta op {delta.op!r}")


def validate_revision(revision: HarnessRevision) -> None:
    if not revision.deltas:
        raise ContractViolation("a revision must contain at least one delta")
    touched: set[tuple[str, str]] = set()
    for delta in revision.deltas:
        validate_delta(delta)
        key = (delta.kind, delta.name)
        if key in touched:
            raise ContractViolation(f"duplicate delta for surface {key}")
        touched.add(key)


def revision_from_generation(generation: Generation, scope: str) -> HarnessRevision:
    """ADR-0001 compatibility mapping: today's generation is exactly a
    one-delta revision over the strategy-code surface."""
    parent = generation.parent_id
    delta = SurfaceDelta(
        op=OP_UPDATE if parent is not None else OP_CREATE,
        kind=SURFACE_STRATEGY_CODE,
        name="solve",
        before_ref=None if parent is None else f"generation:{parent}",
        after_ref=generation.source_ref,
        risk_tier=RISK_HIGH,
    )
    return HarnessRevision(
        revision_id=generation.generation_id.replace("gen-", "rev-"),
        scope=scope,
        parent_ids=() if parent is None else (parent.replace("gen-", "rev-"),),
        deltas=(delta,),
        manifest_ref=None,
        proposer="migrated",
        summary=f"migrated from {generation.generation_id} ({generation.origin})",
        created_at=generation.created_at,
    )


# -- ADR-0002: scopes -------------------------------------------------------------

SCOPE_GLOBAL = "global"


def scope_chain(scope: str) -> tuple[str, ...]:
    """Resolution order from a scope out to global (nearest-scope shadowing)."""
    if scope == SCOPE_GLOBAL:
        return (SCOPE_GLOBAL,)
    kind, _, _ = scope.partition(":")
    if kind == "project":
        return (scope, SCOPE_GLOBAL)
    if kind == "task":
        return (scope, "project:default", SCOPE_GLOBAL)
    if kind == "run":
        raise ContractViolation(
            "run scopes resolve through their task scope; build the chain from "
            "the task and prepend the run scope explicitly"
        )
    raise ContractViolation(f"unknown scope {scope!r}")


def resolve_artifact(
    artifacts: list[SurfaceArtifact], kind: str, name: str, chain: tuple[str, ...]
) -> SurfaceArtifact | None:
    """Nearest-scope shadowing: first hit along the chain wins (ADR-0002)."""
    by_scope = {
        (a.scope, a.kind, a.name): a for a in artifacts
    }
    for scope in chain:
        hit = by_scope.get((scope, kind, name))
        if hit is not None:
            return hit
    return None


# -- ADR-0003: tasks, datasets, manifests ------------------------------------------


@register("task-spec", 1)
@dataclass(frozen=True)
class TaskSpecVersion:
    """Immutable task identity; changing any field is a new version."""

    task_id: str
    version: int
    description: str
    signature: str
    primitive_catalog: tuple[str, ...]
    fingerprint: str


@register("dataset-revision", 1)
@dataclass(frozen=True)
class DatasetRevision:
    """Append-friendly evaluation data; growing a split is a new revision
    plus a re-evaluation requirement — never a task-drift acknowledgement."""

    dataset_id: str
    revision: int
    split_counts: dict[str, int]
    fingerprint: str
    parent_revision: int | None
    reason: str


@register("evaluation-manifest", 1)
@dataclass(frozen=True)
class EvaluationManifest:
    """Everything a validation ran under, pinned (ADR-0003)."""

    task_fingerprint: str
    dataset_fingerprint: str
    seeds: tuple[int, ...]
    environment: str
    validators: tuple[str, ...]  # name@version
    budget: BudgetSpec


# -- ADR-0004: evidence and selection ------------------------------------------------

VALIDATOR_PASSED = "passed"
VALIDATOR_FAILED = "failed"
VALIDATOR_INCONCLUSIVE = "inconclusive"

DECISION_KINDS = (
    "paired-deterministic",
    "stochastic",
    "hard-constraint",
    "provisional",
    "pareto-retention",
)
VERDICTS = ("promote", "reject", "retain", "provisional")


@register("validator-result", 1)
@dataclass(frozen=True)
class ValidatorResult:
    validator: str  # name@version
    status: str  # passed | failed | inconclusive
    metrics: dict[str, float]
    detail: str
    artifact_ref: str | None = None  # full payload (distributions, traces) in CAS


@register("validation-bundle", 1)
@dataclass(frozen=True)
class ValidationBundle:
    manifest_ref: str
    subject_revision_id: str
    results: tuple[ValidatorResult, ...]
    feedback: str


@register("selection-decision", 1)
@dataclass(frozen=True)
class SelectionDecision:
    policy: str
    policy_version: int
    kind: str  # DECISION_KINDS
    verdict: str  # VERDICTS
    subject_revision_id: str
    incumbent_revision_id: str | None
    evidence_refs: tuple[str, ...]
    rationale: str
    at: str


def validate_selection(decision: SelectionDecision) -> None:
    if decision.kind not in DECISION_KINDS:
        raise ContractViolation(f"unknown decision kind {decision.kind!r}")
    if decision.verdict not in VERDICTS:
        raise ContractViolation(f"unknown verdict {decision.verdict!r}")
    if decision.verdict == "promote" and not decision.evidence_refs:
        raise ContractViolation("a promote verdict requires evidence bundles")
