"""The frozen Stage-3B core wire types for composite revisions (ADR-0001/0002).

Moved verbatim from the Stage-3A spike after the freeze: typed scopes and
resolution contexts, revision refs, binding-state transitions, scope vs
run-resolved manifests, harness revisions, the revision-activation lifecycle
seam, migration provenance, and the historical descriptor + trusted
risk-policy registries.

These records are written to task journals by the Stage-3B dual-write mirror
(see `strive.dualwrite`): generation-native records remain the authoritative
source of truth, and the live loop, activation, cycles, and replay stay
generation-native until a later parity slice.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from strive.codec import register
from strive.contracts import Activation as LegacyActivation
from strive.contracts import Generation

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


# Trusted settings must not be representable as evolvable policy-params at
# all: sandbox controls, hard budget ceilings, evaluator/acceptance settings,
# secret permissions, and ledger settings are kernel configuration, not
# evolvable surface. Only reviewed agent-behavior families are admissible,
# and they operate inside trusted caps.
FORBIDDEN_PARAM_FAMILIES = frozenset(
    {"sandbox", "budget", "evaluator", "acceptance", "secrets", "ledger"}
)
ALLOWED_PARAM_FAMILIES: dict[str, str] = {
    "search": RISK_MEDIUM,
    "retry": RISK_MEDIUM,
    "proposal": RISK_MEDIUM,
    "display": RISK_LOW,
}


def validate_param_name(name: str) -> str:
    """Fail closed: unknown families are rejected, never defaulted to low;
    trusted-setting families are not evolvable at any risk level."""
    family = name.split(".", 1)[0]
    if family in FORBIDDEN_PARAM_FAMILIES:
        raise ContractViolation(
            f"policy-param family {family!r} is a trusted kernel setting and "
            "is not representable as an evolvable surface"
        )
    if family not in ALLOWED_PARAM_FAMILIES:
        raise ContractViolation(
            f"unknown policy-param family {family!r}; admissible families are "
            f"{sorted(ALLOWED_PARAM_FAMILIES)} (fail-closed, no low-risk default)"
        )
    return ALLOWED_PARAM_FAMILIES[family]


def _params_risk(name: str, scope: ScopeRef, label: str) -> str:
    """Reviewed agent-behavior parameter families only, tiered — and fail
    closed on anything unrecognized."""
    return _bump_for_scope_and_label(validate_param_name(name), scope, label)


RISK_POLICIES: dict[str, RiskPolicy] = {
    "code-risk@1": _code_risk,
    "prompt-risk@1": _prompt_risk,
    "params-risk@1": _params_risk,
}


def _descriptor(**kwargs: object) -> SurfaceDescriptor:
    return SurfaceDescriptor(**kwargs)  # type: ignore[arg-type]


# Descriptors are stored historically: the registry is keyed by descriptor_ref
# (kind@version) and a separate pointer names each kind's *current* version.
# Old bindings stay valid against the exact descriptor they pinned.
DESCRIPTOR_REGISTRY: dict[str, SurfaceDescriptor] = {
    "strategy-code@1": _descriptor(
        kind=SURFACE_STRATEGY_CODE,
        version=1,
        artifact_schema="python-module@1",
        materializer="sandbox-file@1",
        allowed_scopes=(LEVEL_TASK,),
        validation_policy="paired-deterministic@1",
        risk_policy_ref="code-risk@1",
        online_policy=ONLINE_NEVER,
    ),
    "prompt@1": _descriptor(
        kind=SURFACE_PROMPT,
        version=1,
        artifact_schema="text@1",
        materializer="kernel-text@1",
        allowed_scopes=SCOPE_LEVELS,
        validation_policy="paired-deterministic@1",
        risk_policy_ref="prompt-risk@1",
        online_policy=ONLINE_NEVER,
    ),
    # prompt@2 exists to prove historical pinning: prompt@1 bindings remain
    # valid after prompt@2 becomes current.
    "prompt@2": _descriptor(
        kind=SURFACE_PROMPT,
        version=2,
        artifact_schema="text@1",
        materializer="kernel-text@1",
        allowed_scopes=SCOPE_LEVELS,
        validation_policy="paired-deterministic@1",
        risk_policy_ref="prompt-risk@1",
        online_policy=ONLINE_NEVER,  # stage 5 revisits via a descriptor version
    ),
    "policy-params@1": _descriptor(
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

CURRENT_DESCRIPTOR: dict[str, str] = {
    SURFACE_STRATEGY_CODE: "strategy-code@1",
    SURFACE_PROMPT: "prompt@2",
    SURFACE_POLICY_PARAMS: "policy-params@1",
}

SURFACE_KINDS = tuple(CURRENT_DESCRIPTOR)


def descriptor_for(descriptor_ref: str) -> SurfaceDescriptor:
    descriptor = DESCRIPTOR_REGISTRY.get(descriptor_ref)
    if descriptor is None:
        raise ContractViolation(
            f"descriptor {descriptor_ref!r} is not in the trusted registry"
        )
    return descriptor


def current_descriptor(kind: str) -> SurfaceDescriptor:
    ref = CURRENT_DESCRIPTOR.get(kind)
    if ref is None:
        raise ContractViolation(f"surface kind {kind!r} is not in the trusted registry")
    return DESCRIPTOR_REGISTRY[ref]


def effective_risk(delta: "SurfaceDelta", scope: ScopeRef) -> str:
    """Risk from descriptor + scope + the delta's own transition.

    Callers cannot supply a label: it is derived from the delta's before/after
    states, so a proposal has nothing to spoof."""
    descriptor = current_descriptor(delta.kind)
    return RISK_POLICIES[descriptor.risk_policy_ref](
        delta.name, scope, delta_label(delta)
    )


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


def content_binding(
    kind: str, content_ref: str, descriptor_ref: str | None = None
) -> BindingState:
    """A content binding pinned to a descriptor: the kind's *current*
    descriptor by default, or an explicit historical descriptor_ref."""
    if descriptor_ref is None:
        descriptor_ref = current_descriptor(kind).descriptor_ref
    descriptor = descriptor_for(descriptor_ref)
    if descriptor.kind != kind:
        raise ContractViolation(
            f"descriptor {descriptor_ref!r} does not describe kind {kind!r}"
        )
    return BindingState(BINDING_CONTENT, content_ref, descriptor_ref)


def validate_binding(binding: BindingState, kind: str) -> None:
    """Validation resolves the binding's exact *pinned* descriptor — a
    historical version stays valid after a newer one becomes current."""
    if binding.state not in BINDING_STATES:
        raise ContractViolation(f"unknown binding state {binding.state!r}")
    if binding.state == BINDING_CONTENT:
        if not binding.content_ref or not binding.descriptor_ref:
            raise ContractViolation(
                "a content binding requires both content_ref and descriptor_ref"
            )
        pinned = descriptor_for(binding.descriptor_ref)  # exact version, not current
        if pinned.kind != kind:
            raise ContractViolation(
                f"descriptor_ref {binding.descriptor_ref!r} does not describe "
                f"kind {kind!r}"
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
    descriptor = current_descriptor(delta.kind)  # raises on unknown kinds
    if delta.kind == SURFACE_POLICY_PARAMS:
        validate_param_name(delta.name)  # fail closed; trusted settings barred
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
        # unknown or scope-disallowed kinds are rejected for content AND masks
        descriptor = current_descriptor(entry.kind)
        if manifest.scope.level not in descriptor.allowed_scopes:
            raise ContractViolation(
                f"surface kind {entry.kind!r} is not allowed at scope level "
                f"{manifest.scope.level!r}"
            )
        if entry.kind == SURFACE_POLICY_PARAMS:
            validate_param_name(entry.name)
        validate_binding(entry.binding, entry.kind)


@register("journal-head", 1)
@dataclass(frozen=True)
class JournalHeadRef:
    """Opaque, backend-versioned journal position — never a bare int, so a
    backend change (JSONL byte offset today, an indexed sequence tomorrow)
    does not change this contract's meaning."""

    backend: str  # e.g. "jsonl@1"
    value: str  # backend-interpreted position token


@register("scope-contribution", 1)
@dataclass(frozen=True)
class ScopeContribution:
    """Which active revision (and journal head) a scope contributed to a
    resolved manifest — the provenance of run-resolved state."""

    scope: ScopeRef
    revision: RevisionRef
    journal_head: JournalHeadRef


@register("resolved-manifest", 1)
@dataclass(frozen=True)
class ResolvedHarnessManifest:
    """Run-resolved effective state after resolution over an explicit chain.

    Runs and evaluations reference *this*; revisions never do — a revision
    owns only its own scope's manifest."""

    resolution_chain: tuple[ScopeRef, ...]  # the exact chain, narrowest first
    contributions: tuple[ScopeContribution, ...]  # unique, in chain order
    effective: tuple[ManifestBinding, ...]  # content bindings only, canonical


def validate_resolved_manifest(manifest: ResolvedHarnessManifest) -> None:
    if not manifest.resolution_chain:
        raise ContractViolation("a resolved manifest must record its resolution chain")
    for scope in manifest.resolution_chain:
        validate_scope(scope)
    if len(set(manifest.resolution_chain)) != len(manifest.resolution_chain):
        raise ContractViolation("resolution chain must not repeat scopes")
    _require_canonical(manifest.effective, "resolved manifest")
    for entry in manifest.effective:
        if entry.binding.state != BINDING_CONTENT:
            raise ContractViolation(
                "resolved manifests carry effective content bindings only "
                f"({entry.name!r} is {entry.binding.state})"
            )
        validate_binding(entry.binding, entry.kind)
    chain_index = {scope: i for i, scope in enumerate(manifest.resolution_chain)}
    last_index = -1
    seen: set[ScopeRef] = set()
    for contribution in manifest.contributions:
        validate_scope(contribution.scope)
        if contribution.scope not in chain_index:
            raise ContractViolation(
                f"contribution scope {contribution.scope} is not in the "
                "resolution chain"
            )
        if contribution.scope in seen:
            raise ContractViolation(
                f"duplicate contribution for scope {contribution.scope}"
            )
        seen.add(contribution.scope)
        index = chain_index[contribution.scope]
        if index <= last_index:
            raise ContractViolation("contributions must follow resolution-chain order")
        last_index = index
        if contribution.revision.scope != contribution.scope:
            raise ContractViolation(
                "a contribution's revision must belong to the contributing scope"
            )


def resolve_bindings(
    scope_manifests: list[ScopeManifest], context: ResolutionContext
) -> tuple[ManifestBinding, ...]:
    """Nearest-scope shadowing over scope manifests: masks stop fall-through
    (absent on purpose); a scope with no binding falls through."""
    by_scope: dict[ScopeRef, ScopeManifest] = {}
    for manifest in scope_manifests:
        if manifest.scope in by_scope:
            raise ContractViolation(
                f"duplicate scope manifest for {manifest.scope}"
            )
        by_scope[manifest.scope] = manifest
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
        if revision.base_parent.scope != revision.ref.scope:
            raise ContractViolation(
                "base_parent must live at the revision's own scope; cross-scope "
                "origins belong in provenance_parents"
            )
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


# -- revision lifecycle (ADR-0001; frozen) --------------------------------------------

ACTIVATION_DURABLE = "durable"
ACTIVATION_PROVISIONAL = "provisional"
ACTIVATION_REASONS = (
    "seed", "evolved", "rollback", "promote", "confirmed", "expired-reverted",
    "migrated",
)


@register("revision-activation", 1)
@dataclass(frozen=True)
class RevisionActivation:
    """The activation record for revisions — the frozen lifecycle seam.

    Active-state derivation is unchanged from today: the last activation
    entry in a scope's append-only journal names the active revision; nothing
    is ever mutated, and rollback/expiry are just further activations.

    Exact mapping from the live ``activation@2``:
    - ``generation_id`` + ``task_id``  → ``revision = RevisionRef(task scope,
      gen→rev id)``;
    - ``mode``/``reason``/``at``       → verbatim (same vocabularies);
    - ``policy``                       → ``policy_ref`` (already-versioned
      strings pass through; legacy unversioned markers like "seed"/"manual"
      map to ``name@0`` — version 0 is the reserved pre-versioned era);
    - ``expires_after_cycles`` and ``baseline_score`` (the provisional
      monitoring data) are preserved verbatim;
    - ``decision_ref`` is new: for accepted evolved generations the migration
      encodes the generation's embedded ``decision@1`` into CAS and points
      here; seeds and rollbacks carry None.
    Rollback history maps activation-by-activation in journal order, so the
    derived active revision at every historical prefix is identical.
    """

    revision: RevisionRef
    mode: str  # durable | provisional
    reason: str  # ACTIVATION_REASONS
    at: str
    policy_ref: str  # name@version (version 0 = legacy pre-versioned marker)
    decision_ref: str | None = None  # CAS ref of the decision/evidence record
    expires_after_cycles: int | None = None
    baseline_score: float | None = None


def validate_revision_activation(activation: RevisionActivation) -> None:
    validate_scope(activation.revision.scope)
    if activation.mode not in (ACTIVATION_DURABLE, ACTIVATION_PROVISIONAL):
        raise ContractViolation(f"unknown activation mode {activation.mode!r}")
    if activation.reason not in ACTIVATION_REASONS:
        raise ContractViolation(f"unknown activation reason {activation.reason!r}")
    if "@" not in activation.policy_ref:
        raise ContractViolation(
            f"policy_ref {activation.policy_ref!r} must be versioned (name@version)"
        )
    if activation.mode == ACTIVATION_PROVISIONAL and activation.expires_after_cycles is None:
        raise ContractViolation("a provisional activation must carry its expiry")


def _legacy_policy_ref(policy: str) -> str:
    return policy if "@" in policy else f"{policy}@0"


def revision_activation_from_activation(
    activation: "LegacyActivation", decision_ref: str | None
) -> RevisionActivation:
    """Field-exact mapping from the live activation@2 record (see the
    RevisionActivation docstring for the rules)."""
    scope = ScopeRef(LEVEL_TASK, activation.task_id)
    return RevisionActivation(
        revision=RevisionRef(
            scope, activation.generation_id.replace("gen-", "rev-")
        ),
        mode=activation.mode,
        reason=activation.reason,
        at=activation.at,
        policy_ref=_legacy_policy_ref(activation.policy),
        decision_ref=decision_ref,
        expires_after_cycles=activation.expires_after_cycles,
        baseline_score=activation.baseline_score,
    )


@register("migration-provenance", 1)
@dataclass(frozen=True)
class MigrationProvenance:
    """Everything a migrated ``generation@2`` carried that has no direct
    revision field, preserved losslessly in CAS and referenced from the
    revision's ``provenance_ref``:

    - ``task_fingerprint`` — the task definition the generation was created
      against (drives the drift guard exactly as before);
    - ``origin`` (seed/evolved/manual) and ``weakness_id``;
    - ``decision_ref`` — the embedded ``decision@1`` (acceptance/rejection
      evidence: policy identity, scores, regressed case ids) codec-encoded
      into CAS, or None for seeds.

    Existing ``cycle@1`` records are untouched by migration and stay
    replayable as-is: they reference generation ids and task fingerprints,
    and Stage 3B is *dual-write* — the loop keeps writing generation-native
    records while revisions are written alongside, so execution-and-decision
    replay continues to run against the generation records it was built for.
    """

    source: str  # e.g. "generation@2"
    generation_id: str
    task_id: str
    task_fingerprint: str
    origin: str
    weakness_id: str | None
    decision_ref: str | None


