"""EXPERIMENTAL — Stage 3A contract spike, final pre-merge form (see docs/adrs/).

Freeze status (ADR README has the authoritative list):
- FROZEN for Stage 3B: the core wire types — ScopeRef, RevisionRef,
  BindingState, SurfaceDelta, ManifestBinding, ScopeManifest,
  ScopeContribution, ResolvedHarnessManifest, HarnessRevision — plus the
  SurfaceDescriptor registry shape.
- PROVISIONAL until their implementation slices: TaskSpecVersion /
  DatasetRevision / EvaluationManifest, ValidatorResult / ValidationBundle /
  SelectionDecision (and frontier semantics), AlgorithmRun / AlgorithmStep,
  and detailed storage-backend schemas.

Nothing in the live loop imports this module; the registered codec kinds are
additive and unused by any journal.

Model summary:
- a revision owns a `ScopeManifest` (its scope's bindings, masks included);
  runs/evaluations reference a `ResolvedHarnessManifest` (the effective
  bindings after run→task→project→global resolution, plus which active
  revision and journal head each scope contributed);
- artifact state is a complete `BindingState` (absent | masked |
  content(ref, descriptor_ref)); a `SurfaceDelta` is a before→after state
  transition, so exact inversion, unmasking, and conflict checks are
  representable; create/update/delete/mask/unmask are *derived labels*;
- persisted content bindings pin their `descriptor_ref` (kind@version);
  risk is computed by the descriptor's risk policy from (name, scope,
  transition label) — policy parameters are NOT one universally low-risk
  bucket.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage, Generation

# -- typed scopes (ADR-0002; frozen) -------------------------------------------------

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
    """An explicit resolution chain, narrowest scope first. There is no
    implicit default project: a projectless task resolves task → global."""

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


@register("revision-ref", 1)
@dataclass(frozen=True)
class RevisionRef:
    """Globally unambiguous revision identity: scope + per-scope id."""

    scope: ScopeRef
    revision_id: str


# -- surface kinds, descriptors, risk (ADR-0001/0003; registry shape frozen) ---------

SURFACE_STRATEGY_CODE = "strategy-code"
SURFACE_PROMPT = "prompt"
SURFACE_POLICY_PARAMS = "policy-params"

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"
_RISK_ORDER = (RISK_LOW, RISK_MEDIUM, RISK_HIGH)

ONLINE_NEVER = "never"
ONLINE_PROVISIONAL_ONLY = "provisional-only"


@dataclass(frozen=True)
class SurfaceDescriptor:
    """Versioned trusted allowlist entry for an evolvable surface kind.

    Kernel data, never persisted as evolvable state. Persisted content
    bindings pin ``descriptor_ref = kind@version`` so history records which
    descriptor governed them.
    """

    kind: str
    version: int
    artifact_schema: str  # schema id for artifact contents
    materializer: str  # id@version
    allowed_scopes: tuple[str, ...]  # scope levels this kind may live at
    validation_policy: str  # name@version — validators this kind must pass
    risk_policy_ref: str  # name@version into RISK_POLICIES
    online_policy: str  # never | provisional-only

    @property
    def descriptor_ref(self) -> str:
        return f"{self.kind}@{self.version}"


# Risk policies compute risk from (artifact name, scope, transition label) —
# a delta carries nothing to trust, and policy parameters are explicitly NOT
# one universally low-risk bucket (see params_risk).
RiskPolicy = Callable[[str, "ScopeRef", str], str]


def _bump_for_scope_and_label(risk: str, scope: ScopeRef, label: str) -> str:
    index = _RISK_ORDER.index(risk)
    if scope.level in (LEVEL_GLOBAL, LEVEL_PROJECT):
        index = min(index + 1, len(_RISK_ORDER) - 1)  # broader blast radius
    if label in ("delete", "mask"):
        index = max(index, _RISK_ORDER.index(RISK_MEDIUM))  # removals surprise
    return _RISK_ORDER[index]


def _code_risk(name: str, scope: ScopeRef, label: str) -> str:
    return _bump_for_scope_and_label(RISK_HIGH, scope, label)


def _prompt_risk(name: str, scope: ScopeRef, label: str) -> str:
    return _bump_for_scope_and_label(RISK_MEDIUM, scope, label)


def _params_risk(name: str, scope: ScopeRef, label: str) -> str:
    """Policy parameters are tiered by what they control, not uniformly low:
    parameters steering budgets or the sandbox are as dangerous as code."""
    family = name.split(".", 1)[0]
    base = {
        "sandbox": RISK_HIGH,
        "budget": RISK_HIGH,
        "search": RISK_MEDIUM,
        "retry": RISK_MEDIUM,
    }.get(family, RISK_LOW)
    return _bump_for_scope_and_label(base, scope, label)


RISK_POLICIES: dict[str, RiskPolicy] = {
    "code-risk@1": _code_risk,
    "prompt-risk@1": _prompt_risk,
    "params-risk@1": _params_risk,
}


SURFACE_REGISTRY: dict[str, SurfaceDescriptor] = {
    SURFACE_STRATEGY_CODE: SurfaceDescriptor(
        kind=SURFACE_STRATEGY_CODE,
        version=1,
        artifact_schema="python-module@1",
        materializer="sandbox-file@1",
        allowed_scopes=(LEVEL_TASK,),
        validation_policy="paired-deterministic@1",
        risk_policy_ref="code-risk@1",
        online_policy=ONLINE_NEVER,
    ),
    SURFACE_PROMPT: SurfaceDescriptor(
        kind=SURFACE_PROMPT,
        version=1,
        artifact_schema="text@1",
        materializer="kernel-text@1",
        allowed_scopes=SCOPE_LEVELS,
        validation_policy="paired-deterministic@1",
        risk_policy_ref="prompt-risk@1",
        online_policy=ONLINE_NEVER,  # stage 5 revisits via a descriptor version
    ),
    SURFACE_POLICY_PARAMS: SurfaceDescriptor(
        kind=SURFACE_POLICY_PARAMS,
        version=1,
        artifact_schema="params@1",
        materializer="kernel-params@1",
        allowed_scopes=SCOPE_LEVELS,
        validation_policy="paired-deterministic@1",
        risk_policy_ref="params-risk@1",
        online_policy=ONLINE_NEVER,
    ),
}


def effective_risk(kind: str, name: str, scope: ScopeRef, label: str) -> str:
    """Risk from descriptor + scope + transition label (never from a delta)."""
    descriptor = SURFACE_REGISTRY.get(kind)
    if descriptor is None:
        raise ContractViolation(f"surface kind {kind!r} is not in the trusted registry")
    return RISK_POLICIES[descriptor.risk_policy_ref](name, scope, label)


# -- binding states and deltas (ADR-0001; frozen) -------------------------------------

BINDING_ABSENT = "absent"
BINDING_MASKED = "masked"
BINDING_CONTENT = "content"
BINDING_STATES = (BINDING_ABSENT, BINDING_MASKED, BINDING_CONTENT)


@register("binding-state", 1)
@dataclass(frozen=True)
class BindingState:
    """Complete artifact state at one scope: absent | masked |
    content(content_ref, descriptor_ref)."""

    state: str
    content_ref: str | None = None
    descriptor_ref: str | None = None  # kind@version, pinned for content


ABSENT = BindingState(BINDING_ABSENT)
MASKED = BindingState(BINDING_MASKED)


def content_binding(kind: str, content_ref: str) -> BindingState:
    descriptor = SURFACE_REGISTRY.get(kind)
    if descriptor is None:
        raise ContractViolation(f"surface kind {kind!r} is not in the trusted registry")
    return BindingState(BINDING_CONTENT, content_ref, descriptor.descriptor_ref)


def validate_binding(binding: BindingState, kind: str) -> None:
    if binding.state not in BINDING_STATES:
        raise ContractViolation(f"unknown binding state {binding.state!r}")
    if binding.state == BINDING_CONTENT:
        if not binding.content_ref or not binding.descriptor_ref:
            raise ContractViolation(
                "a content binding requires both content_ref and descriptor_ref"
            )
        expected = f"{kind}@{SURFACE_REGISTRY[kind].version}" if kind in SURFACE_REGISTRY else None
        if expected is None:
            raise ContractViolation(f"surface kind {kind!r} is not in the trusted registry")
        if binding.descriptor_ref != expected:
            raise ContractViolation(
                f"descriptor_ref {binding.descriptor_ref!r} does not pin the "
                f"registered descriptor {expected!r}"
            )
    else:
        if binding.content_ref is not None or binding.descriptor_ref is not None:
            raise ContractViolation(
                f"{binding.state} bindings must carry no content or descriptor refs"
            )


@register("surface-delta", 1)
@dataclass(frozen=True)
class SurfaceDelta:
    """A complete before→after binding transition for one surface artifact.

    create/update/delete/mask/unmask are *derived labels* (`delta_label`);
    the states themselves make exact inversion (`invert_delta`) and
    application conflict checks (`check_delta_applies`) representable."""

    kind: str
    name: str
    before: BindingState
    after: BindingState


def delta_label(delta: SurfaceDelta) -> str:
    before, after = delta.before.state, delta.after.state
    if delta.before == delta.after:
        raise ContractViolation(
            f"delta for {delta.name!r} is a no-op (before == after)"
        )
    if after == BINDING_MASKED:
        return "mask"
    if before == BINDING_MASKED:
        return "unmask"
    if before == BINDING_ABSENT and after == BINDING_CONTENT:
        return "create"
    if before == BINDING_CONTENT and after == BINDING_ABSENT:
        return "delete"
    return "update"  # content -> content with a different ref


def invert_delta(delta: SurfaceDelta) -> SurfaceDelta:
    """Exact inversion: swap the states (per-surface rollback, ADR-0001)."""
    return SurfaceDelta(delta.kind, delta.name, before=delta.after, after=delta.before)


def check_delta_applies(delta: SurfaceDelta, current: BindingState) -> None:
    """Conflict check: a delta applies only to the exact state it recorded."""
    if current != delta.before:
        raise ContractViolation(
            f"delta for {delta.name!r} expected binding {delta.before} "
            f"but found {current}"
        )


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
    validate_binding(delta.before, delta.kind)
    validate_binding(delta.after, delta.kind)
    delta_label(delta)  # raises on no-op


# -- manifests: revision-owned vs run-resolved (ADR-0001/0002; frozen) ----------------


@register("manifest-binding", 1)
@dataclass(frozen=True)
class ManifestBinding:
    kind: str
    name: str
    binding: BindingState


def _require_canonical(bindings: tuple[ManifestBinding, ...], where: str) -> None:
    keys = [(b.kind, b.name) for b in bindings]
    if keys != sorted(keys):
        raise ContractViolation(f"{where}: bindings must be in canonical (kind, name) order")
    if len(keys) != len(set(keys)):
        raise ContractViolation(f"{where}: duplicate (kind, name) binding")


@register("scope-manifest", 1)
@dataclass(frozen=True)
class ScopeManifest:
    """The artifacts and masks one revision owns at one scope. This is
    revision-owned *state* — resolution across scopes is not its business."""

    scope: ScopeRef
    bindings: tuple[ManifestBinding, ...]  # masked or content; absent isn't stored


def validate_scope_manifest(manifest: ScopeManifest) -> None:
    validate_scope(manifest.scope)
    _require_canonical(manifest.bindings, "scope manifest")
    for entry in manifest.bindings:
        if entry.binding.state == BINDING_ABSENT:
            raise ContractViolation(
                f"scope manifest must not store absent bindings ({entry.name!r})"
            )
        validate_binding(entry.binding, entry.kind)


@register("scope-contribution", 1)
@dataclass(frozen=True)
class ScopeContribution:
    """Which active revision (and journal head) a scope contributed to a
    resolved manifest — the provenance of run-resolved state."""

    scope: ScopeRef
    revision: RevisionRef
    journal_head: int


@register("resolved-manifest", 1)
@dataclass(frozen=True)
class ResolvedHarnessManifest:
    """Run-resolved effective state after run→task→project→global resolution.

    Runs and evaluations reference *this*; revisions never do — a revision
    owns only its own scope's manifest."""

    contributions: tuple[ScopeContribution, ...]  # narrowest scope first
    effective: tuple[ManifestBinding, ...]  # content bindings only, canonical


def validate_resolved_manifest(manifest: ResolvedHarnessManifest) -> None:
    _require_canonical(manifest.effective, "resolved manifest")
    for entry in manifest.effective:
        if entry.binding.state != BINDING_CONTENT:
            raise ContractViolation(
                "resolved manifests carry effective content bindings only "
                f"({entry.name!r} is {entry.binding.state})"
            )
        validate_binding(entry.binding, entry.kind)
    for contribution in manifest.contributions:
        validate_scope(contribution.scope)


def resolve_bindings(
    scope_manifests: list[ScopeManifest], context: ResolutionContext
) -> tuple[ManifestBinding, ...]:
    """Nearest-scope shadowing over scope manifests: masks stop fall-through
    (absent on purpose); a scope with no binding falls through."""
    by_scope = {m.scope: m for m in scope_manifests}
    keys: set[tuple[str, str]] = set()
    for manifest in scope_manifests:
        keys.update((b.kind, b.name) for b in manifest.bindings)
    effective: list[ManifestBinding] = []
    for kind, name in sorted(keys):
        for scope in context.chain:
            scoped = by_scope.get(scope)
            if scoped is None:
                continue
            hit = next(
                (b for b in scoped.bindings if (b.kind, b.name) == (kind, name)),
                None,
            )
            if hit is not None:
                if hit.binding.state == BINDING_CONTENT:
                    effective.append(hit)
                break  # masked: stop fall-through, artifact absent on purpose
    return tuple(effective)


# -- revisions (ADR-0001; frozen) -----------------------------------------------------


@register("revision", 1)
@dataclass(frozen=True)
class HarnessRevision:
    """The composite unit of evolution.

    ``scope_manifest_ref`` addresses the revision's own ScopeManifest (its
    scope's post-delta state); evaluation conditions live with evidence
    (ValidationBundle), never here. ``proposal_ref``/``provenance_ref``
    optionally point at the proposal artifact and provenance record in CAS.
    """

    ref: RevisionRef
    base_parent: RevisionRef | None
    provenance_parents: tuple[RevisionRef, ...]
    deltas: tuple[SurfaceDelta, ...]
    scope_manifest_ref: str
    proposer: str  # name@version, always versioned
    summary: str
    created_at: str
    proposal_ref: str | None = None
    provenance_ref: str | None = None


def validate_revision(revision: HarnessRevision) -> None:
    validate_scope(revision.ref.scope)
    if not revision.deltas:
        raise ContractViolation("a revision must contain at least one delta")
    if not revision.scope_manifest_ref:
        raise ContractViolation("a revision must reference its scope manifest")
    if "@" not in revision.proposer:
        raise ContractViolation(
            f"proposer {revision.proposer!r} must be versioned (name@version)"
        )
    if revision.base_parent is not None:
        validate_scope(revision.base_parent.scope)
        if revision.base_parent == revision.ref:
            raise ContractViolation("a revision cannot be its own base parent")
    seen_parents: set[RevisionRef] = set()
    for parent in revision.provenance_parents:
        validate_scope(parent.scope)
        if parent == revision.ref:
            raise ContractViolation("a revision cannot be its own provenance parent")
        if parent == revision.base_parent:
            raise ContractViolation("base_parent must not repeat in provenance_parents")
        if parent in seen_parents:
            raise ContractViolation(f"duplicate provenance parent {parent}")
        seen_parents.add(parent)
    keys = [(d.kind, d.name) for d in revision.deltas]
    if keys != sorted(keys):
        raise ContractViolation("deltas must be in canonical (kind, name) order")
    if len(keys) != len(set(keys)):
        raise ContractViolation(f"duplicate delta for surface {keys}")
    for delta in revision.deltas:
        validate_delta(delta, revision.ref.scope)


def revision_from_generation(
    generation: Generation,
    parent: Generation | None,
    scope: ScopeRef,
    scope_manifest_ref: str,
) -> HarnessRevision:
    """ADR-0001 compatibility mapping: today's generation is exactly a
    one-delta revision over the strategy-code surface, with complete binding
    transitions (before = the parent's *content* binding)."""
    if (parent is None) != (generation.parent_id is None):
        raise ContractViolation(
            "parent generation must be supplied iff the generation has a parent id"
        )
    if parent is not None and parent.generation_id != generation.parent_id:
        raise ContractViolation(
            f"parent mismatch: {parent.generation_id} != {generation.parent_id}"
        )
    delta = SurfaceDelta(
        kind=SURFACE_STRATEGY_CODE,
        name="solve",
        before=ABSENT if parent is None else content_binding(
            SURFACE_STRATEGY_CODE, parent.source_ref
        ),
        after=content_binding(SURFACE_STRATEGY_CODE, generation.source_ref),
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
        scope_manifest_ref=scope_manifest_ref,
        proposer="ledger-migration@1",
        summary=f"migrated from {generation.generation_id} ({generation.origin})",
        created_at=generation.created_at,
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
    """PROVISIONAL. Journaled search state (resumption via journaled steps)."""

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
