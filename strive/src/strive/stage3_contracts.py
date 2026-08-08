"""EXPERIMENTAL — Stage 3A contract spike, revised (see docs/adrs/).

These typed contracts validate the ADR designs with round-trip tests before
Stage 3B freezes and implements them. Nothing in the live loop imports this
module; the registered codec kinds are additive and unused by any journal.
Wire schemas here were provisional during the 3A revision pass and are now
the shapes Stage 3B freezes.

Revision-pass highlights (each backed by a test):
- revision *state* (HarnessManifest / state_manifest_ref) is separated from
  evaluation *evidence* (ValidationBundle pins the EvaluationManifest);
- RevisionRef(scope, id) makes lineage globally unambiguous across scopes;
  base_parent (deltas apply here) is distinct from provenance_parents;
- ScopeRef + ResolutionContext replace colon-parsed strings and any implicit
  default project; delete (remove own override) is distinct from mask
  (tombstone that stops inheritance fall-through);
- task specs are environment-generic; solve(str)->int details live in the
  FunctionTask config blob;
- risk is computed from descriptor + scope + operation, never trusted from a
  delta;
- selection decisions are policy-neutral kernel dispositions, all of which
  require evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage, Generation

# -- ADR-0002: typed scopes ---------------------------------------------------------

LEVEL_GLOBAL = "global"
LEVEL_PROJECT = "project"
LEVEL_TASK = "task"
LEVEL_RUN = "run"
SCOPE_LEVELS = (LEVEL_GLOBAL, LEVEL_PROJECT, LEVEL_TASK, LEVEL_RUN)


class ContractViolation(Exception):
    """A stage-3 contract's structural rules were broken."""


@register("scope-ref", 1)
@dataclass(frozen=True)
class ScopeRef:
    """Typed scope identity; no string parsing, no implicit defaults."""

    level: str  # SCOPE_LEVELS
    name: str  # "" only for global


def validate_scope(scope: ScopeRef) -> None:
    if scope.level not in SCOPE_LEVELS:
        raise ContractViolation(f"unknown scope level {scope.level!r}")
    if scope.level == LEVEL_GLOBAL and scope.name != "":
        raise ContractViolation("global scope must have an empty name")
    if scope.level != LEVEL_GLOBAL and not scope.name:
        raise ContractViolation(f"{scope.level} scope requires a name")


GLOBAL_SCOPE = ScopeRef(LEVEL_GLOBAL, "")


@dataclass(frozen=True)
class ResolutionContext:
    """An explicit resolution chain, narrowest scope first.

    Built by trusted code from what is actually known — there is no implicit
    default project: a task with no project resolves task → global.
    """

    chain: tuple[ScopeRef, ...]

    @staticmethod
    def build(
        *, task: str | None = None, project: str | None = None, run: str | None = None
    ) -> "ResolutionContext":
        scopes: list[ScopeRef] = []
        if run is not None:
            if task is None:
                raise ContractViolation("a run scope requires its task scope")
            scopes.append(ScopeRef(LEVEL_RUN, run))
        if task is not None:
            scopes.append(ScopeRef(LEVEL_TASK, task))
        if project is not None:
            scopes.append(ScopeRef(LEVEL_PROJECT, project))
        scopes.append(GLOBAL_SCOPE)
        for scope in scopes:
            validate_scope(scope)
        return ResolutionContext(chain=tuple(scopes))


# -- ADR-0001: surfaces ---------------------------------------------------------

SURFACE_STRATEGY_CODE = "strategy-code"
SURFACE_PROMPT = "prompt"
SURFACE_POLICY_PARAMS = "policy-params"

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"
_RISK_ORDER = (RISK_LOW, RISK_MEDIUM, RISK_HIGH)

OP_CREATE = "create"
OP_UPDATE = "update"
OP_DELETE = "delete"  # remove this scope's own override; inheritance resumes
OP_MASK = "mask"  # tombstone: stop inheritance fall-through at this scope
DELTA_OPS = (OP_CREATE, OP_UPDATE, OP_DELETE, OP_MASK)

ONLINE_NEVER = "never"
ONLINE_PROVISIONAL_ONLY = "provisional-only"


@dataclass(frozen=True)
class SurfaceDescriptor:
    """Versioned trusted allowlist entry for an evolvable surface kind.

    Kernel data, never persisted as evolvable state; the loop cannot extend
    or edit the registry. Risk is *computed* from this descriptor plus the
    delta's scope and operation — a delta carries no risk field to trust.
    """

    kind: str
    version: int
    artifact_schema: str  # schema id for artifact contents
    materializer: str  # id@version: how the artifact lands in a workspace
    allowed_scopes: tuple[str, ...]  # scope levels this kind may live at
    required_validators: tuple[str, ...]  # name@version
    base_risk: str
    online_policy: str  # never | provisional-only


SURFACE_REGISTRY: dict[str, SurfaceDescriptor] = {
    SURFACE_STRATEGY_CODE: SurfaceDescriptor(
        kind=SURFACE_STRATEGY_CODE,
        version=1,
        artifact_schema="python-module@1",
        materializer="sandbox-file@1",
        allowed_scopes=(LEVEL_TASK,),
        required_validators=("selection-suite@1",),
        base_risk=RISK_HIGH,
        online_policy=ONLINE_NEVER,
    ),
    SURFACE_PROMPT: SurfaceDescriptor(
        kind=SURFACE_PROMPT,
        version=1,
        artifact_schema="text@1",
        materializer="kernel-text@1",
        allowed_scopes=SCOPE_LEVELS,
        required_validators=("selection-suite@1",),
        base_risk=RISK_MEDIUM,
        online_policy=ONLINE_NEVER,  # stage 5 may relax via descriptor version
    ),
    SURFACE_POLICY_PARAMS: SurfaceDescriptor(
        kind=SURFACE_POLICY_PARAMS,
        version=1,
        artifact_schema="params@1",
        materializer="kernel-params@1",
        allowed_scopes=SCOPE_LEVELS,
        required_validators=("selection-suite@1",),
        base_risk=RISK_LOW,
        online_policy=ONLINE_NEVER,
    ),
}


def effective_risk(kind: str, scope: ScopeRef, op: str) -> str:
    """Risk from descriptor + scope + operation (never from the delta)."""
    descriptor = SURFACE_REGISTRY.get(kind)
    if descriptor is None:
        raise ContractViolation(f"surface kind {kind!r} is not in the trusted registry")
    index = _RISK_ORDER.index(descriptor.base_risk)
    if scope.level in (LEVEL_GLOBAL, LEVEL_PROJECT):
        index = min(index + 1, len(_RISK_ORDER) - 1)  # broader blast radius
    if op in (OP_DELETE, OP_MASK):
        index = max(index, _RISK_ORDER.index(RISK_MEDIUM))  # removals surprise
    return _RISK_ORDER[index]


@register("surface-artifact", 1)
@dataclass(frozen=True)
class SurfaceArtifact:
    kind: str
    name: str
    scope: ScopeRef
    content_ref: str  # "" iff masked
    created_at: str
    masked: bool = False


@register("surface-delta", 1)
@dataclass(frozen=True)
class SurfaceDelta:
    """Typed CRUD (+mask) over one surface artifact. No risk field: risk is
    computed via `effective_risk` and recorded by the kernel where needed."""

    op: str  # DELTA_OPS
    kind: str
    name: str
    before_ref: str | None
    after_ref: str | None


def validate_delta(delta: SurfaceDelta, scope: ScopeRef) -> None:
    descriptor = SURFACE_REGISTRY.get(delta.kind)
    if descriptor is None:
        raise ContractViolation(
            f"surface kind {delta.kind!r} is not in the trusted registry "
            f"{sorted(SURFACE_REGISTRY)}"
        )
    if scope.level not in descriptor.allowed_scopes:
        raise ContractViolation(
            f"surface kind {delta.kind!r} is not allowed at scope level "
            f"{scope.level!r} (allowed: {descriptor.allowed_scopes})"
        )
    if delta.op == OP_CREATE and not (delta.before_ref is None and delta.after_ref):
        raise ContractViolation(f"create delta {delta.name!r} must have only after_ref")
    elif delta.op == OP_UPDATE and not (delta.before_ref and delta.after_ref):
        raise ContractViolation(f"update delta {delta.name!r} must have both refs")
    elif delta.op == OP_DELETE and not (delta.before_ref and delta.after_ref is None):
        raise ContractViolation(f"delete delta {delta.name!r} must have only before_ref")
    elif delta.op == OP_MASK and not (delta.before_ref is None and delta.after_ref is None):
        raise ContractViolation(f"mask delta {delta.name!r} must carry no content refs")
    elif delta.op not in DELTA_OPS:
        raise ContractViolation(f"unknown delta op {delta.op!r}")


# -- ADR-0001: manifests, refs, revisions ----------------------------------------


@register("manifest-entry", 1)
@dataclass(frozen=True)
class ManifestEntry:
    kind: str
    name: str
    content_ref: str


@register("harness-manifest", 1)
@dataclass(frozen=True)
class HarnessManifest:
    """The complete resolved harness *state* after a revision's deltas apply.

    Content-addressed into CAS; revisions carry its ref. This is state, not
    evidence — evaluation conditions live in EvaluationManifest, owned by
    ValidationBundle (ADR-0004)."""

    entries: tuple[ManifestEntry, ...]


def validate_manifest(manifest: HarnessManifest) -> None:
    keys = [(e.kind, e.name) for e in manifest.entries]
    if len(keys) != len(set(keys)):
        raise ContractViolation("duplicate (kind, name) artifact key in manifest")


@register("revision-ref", 1)
@dataclass(frozen=True)
class RevisionRef:
    """Globally unambiguous revision identity: scope + per-scope id."""

    scope: ScopeRef
    revision_id: str


@register("revision", 1)
@dataclass(frozen=True)
class HarnessRevision:
    """The composite unit of evolution (ADR-0001, revised).

    ``base_parent`` is where the deltas apply; ``provenance_parents`` are
    additional lineage inputs (merge/crossover, cross-scope promotion
    origins) that contributed content but are not the delta base.
    ``state_manifest_ref`` addresses the resolved HarnessManifest — the
    revision owns its state, never its evaluation conditions.
    """

    ref: RevisionRef
    base_parent: RevisionRef | None
    provenance_parents: tuple[RevisionRef, ...]
    deltas: tuple[SurfaceDelta, ...]
    state_manifest_ref: str
    proposer: str  # name@version, always versioned
    summary: str
    created_at: str


def validate_revision(revision: HarnessRevision) -> None:
    validate_scope(revision.ref.scope)
    if not revision.deltas:
        raise ContractViolation("a revision must contain at least one delta")
    if not revision.state_manifest_ref:
        raise ContractViolation("a revision must reference its state manifest")
    if "@" not in revision.proposer:
        raise ContractViolation(
            f"proposer {revision.proposer!r} must be versioned (name@version)"
        )
    if revision.base_parent is not None:
        validate_scope(revision.base_parent.scope)
    for parent in revision.provenance_parents:
        validate_scope(parent.scope)
        if revision.base_parent is not None and parent == revision.base_parent:
            raise ContractViolation("base_parent must not repeat in provenance_parents")
    touched: set[tuple[str, str]] = set()
    for delta in revision.deltas:
        validate_delta(delta, revision.ref.scope)
        key = (delta.kind, delta.name)
        if key in touched:
            raise ContractViolation(f"duplicate delta for surface {key}")
        touched.add(key)


def revision_from_generation(
    generation: Generation,
    parent: Generation | None,
    scope: ScopeRef,
    state_manifest_ref: str,
) -> HarnessRevision:
    """ADR-0001 compatibility mapping: today's generation is exactly a
    one-delta revision over the strategy-code surface. ``before_ref`` is the
    parent's *content* ref (its source), and the migration proposer id is
    versioned like any other."""
    if (parent is None) != (generation.parent_id is None):
        raise ContractViolation(
            "parent generation must be supplied iff the generation has a parent id"
        )
    if parent is not None and parent.generation_id != generation.parent_id:
        raise ContractViolation(
            f"parent mismatch: {parent.generation_id} != {generation.parent_id}"
        )
    delta = SurfaceDelta(
        op=OP_CREATE if parent is None else OP_UPDATE,
        kind=SURFACE_STRATEGY_CODE,
        name="solve",
        before_ref=None if parent is None else parent.source_ref,
        after_ref=generation.source_ref,
    )
    return HarnessRevision(
        ref=RevisionRef(scope, generation.generation_id.replace("gen-", "rev-")),
        base_parent=(
            None
            if generation.parent_id is None
            else RevisionRef(scope, generation.parent_id.replace("gen-", "rev-"))
        ),
        provenance_parents=(),
        deltas=(delta,),
        state_manifest_ref=state_manifest_ref,
        proposer="ledger-migration@1",
        summary=f"migrated from {generation.generation_id} ({generation.origin})",
        created_at=generation.created_at,
    )


def resolve_artifact(
    artifacts: list[SurfaceArtifact],
    kind: str,
    name: str,
    context: ResolutionContext,
) -> SurfaceArtifact | None:
    """Nearest-scope shadowing with mask semantics (ADR-0002).

    A *deleted* override simply isn't present, so resolution falls through to
    broader scopes; a *mask* is present and stops the fall-through, making
    the artifact absent at this scope on purpose."""
    by_key = {(a.scope, a.kind, a.name): a for a in artifacts}
    for scope in context.chain:
        hit = by_key.get((scope, kind, name))
        if hit is not None:
            return None if hit.masked else hit
    return None


# -- ADR-0003: tasks, datasets, evaluation manifests --------------------------------


@register("task-spec", 1)
@dataclass(frozen=True)
class TaskSpecVersion:
    """Immutable, environment-generic task identity.

    The kernel sees an environment adapter, action/observation schemas, a
    scorer, and a config blob — never a function signature. FunctionTask's
    config carries today's `solve(str)->int` signature and primitive catalog.
    """

    task_id: str
    version: int
    description: str
    environment: str  # adapter id@version, e.g. function-task@1
    action_schema: str  # schema id
    observation_schema: str  # schema id
    scorer: str  # id@version
    config_ref: str  # CAS ref of adapter-specific config
    fingerprint: str


@register("dataset-revision", 1)
@dataclass(frozen=True)
class DatasetRevision:
    """Append-friendly evaluation data, fully reconstructable: every split
    points at a CAS manifest of its cases. Growing a split is a new revision
    plus a re-evaluation requirement — never a task-drift acknowledgement."""

    dataset_id: str
    revision: int
    parent_revision: int | None
    reason: str
    split_manifest_refs: dict[str, str]  # split -> CAS ref of case manifest
    split_counts: dict[str, int]  # derivable; kept for cheap display
    fingerprint: str


@register("evaluation-manifest", 1)
@dataclass(frozen=True)
class EvaluationManifest:
    """Everything a validation ran under, pinned (ADR-0003, expanded).

    Owned by ValidationBundle — never by a revision: the same revision is
    routinely evaluated under many manifests (new dataset revisions, more
    seeds, different validators)."""

    harness_state_ref: str  # resolved HarnessManifest under test
    objective_spec_ref: str
    task_fingerprint: str
    dataset_fingerprint: str
    environment: str  # id@version
    scorer: str  # id@version
    tool_versions: dict[str, str]
    runtime: str  # e.g. "cpython-3.12.10"
    seeds: tuple[int, ...]
    validators: tuple[str, ...]  # name@version
    budget: BudgetSpec


# -- ADR-0003: session protocols (runtime, not wire) ---------------------------------


class EnvironmentSession(Protocol):
    """Base episodic session: observe, act, finish. Nothing here requires
    reset — non-resettable environments implement only this."""

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


# -- ADR-0004: evidence and selection ------------------------------------------------

VALIDATOR_PASSED = "passed"
VALIDATOR_FAILED = "failed"
VALIDATOR_INCONCLUSIVE = "inconclusive"


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
    """Evidence: pins the evaluation manifest it was produced under."""

    evaluation_manifest_ref: str
    subject: RevisionRef
    results: tuple[ValidatorResult, ...]
    feedback: str


DISPOSITIONS = ("promote", "reject", "frontier_add", "provisional_activate")


@register("selection-decision", 1)
@dataclass(frozen=True)
class SelectionDecision:
    """Policy-neutral conclusion: a policy_ref plus a small kernel
    disposition vocabulary. Every disposition requires evidence."""

    policy_ref: str  # name@version
    objective_spec_ref: str
    disposition: str  # DISPOSITIONS
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


# -- ADR-0005: resumable algorithm state ----------------------------------------------

ALGORITHM_RUNNING = "running"
ALGORITHM_COMPLETED = "completed"
ALGORITHM_HALTED = "halted"


@register("algorithm-run", 1)
@dataclass(frozen=True)
class AlgorithmRun:
    """Journaled search state: a crashed algorithm resumes from its last
    journaled step, never from in-memory population state."""

    algorithm: str  # name@version
    run_id: str
    scope: ScopeRef
    budget: BudgetSpec
    status: str  # running | completed | halted
    steps_completed: int


@register("algorithm-step", 1)
@dataclass(frozen=True)
class AlgorithmStep:
    run_id: str
    step_index: int
    action: str  # propose | validate | submit
    subject_ref: str  # revision id / bundle ref / decision ref as applicable
    detail: str
    usage: BudgetUsage
