"""Stage-3B.3: the canonical native-revision lifecycle.

An append-only, task-scoped journal (`ledger/<task>.revisions.jsonl`) that
OWNS native composite revisions — separate from the generation ledger and
from the generation→revision mirror (which remain derived compatibility
state). It is a crash-framed, hash-chained, expected-head stream (see
`strive.framing`; the chain is tamper-EVIDENT, not same-UID tamper-proof —
which is why lifecycle authority is refused for unsafe model-generated code
until host confinement or mediation exists).

Identity is separated from evidence:

- `RevisionRetained` records immutable revision IDENTITY only — the exact
  `HarnessRevision` pinned by its content-addressed ref;
- `RevisionEvaluated` / `RevisionSelected` are appended per assessment, so
  one revision can be evaluated repeatedly under different manifests,
  policies, and baselines; every evidence ref is validated;
- `CompatibilityLink` records which generation serves a revision (derived
  compatibility state, made explicit);
- activation of promote-like reasons requires CURRENT accepted selection
  evidence against the active baseline; rejected or evidence-free revisions
  activate only through a distinct `TrustedOverride` record;
- `ActivationIntent` / `ActivationProgress` / `ActivationCompleted` make the
  cross-journal activation (generation compatibility activation + lifecycle
  activation) ONE recoverable operation: identity + evidence persist before
  served behavior changes, and every crash point resumes or reconciles.

Composite state is validated against its PARENT: every `delta.before` must
match the parent's ScopeManifest binding exactly, all transitions
(create/update/delete/mask/unmask) are applied, unchanged bindings carry
over, and the result must equal the stored child manifest — undeclared
changes, stale before-states, mask/absent confusion, and dropped surfaces
all fail closed. Active state materializes from the COMPLETE manifest, so
multi-surface state is never flattened into a strategy-only `Generation`;
the strategy-only generation exists only as an explicitly derived
compatibility projection, and lifecycle/compatibility parity is exposed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore, hash_text
from strive.codec import register
from strive.contracts import Decision, Evaluation
from strive.events import now_iso
from strive.framing import FramedJournal, FramedView, FramingError
from strive.revisions import (
    ABSENT,
    ACTIVATION_DURABLE,
    BINDING_ABSENT,
    BindingState,
    ContractViolation,
    DESCRIPTOR_REGISTRY,
    HarnessRevision,
    JournalHeadRef,
    LEVEL_TASK,
    ManifestBinding,
    MigrationProvenance,
    ResolvedHarnessManifest,
    RevisionActivation,
    RevisionProvenance,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    SurfaceDelta,
    content_binding,
    delta_label,
    validate_resolved_manifest,
    validate_revision,
    validate_scope_manifest,
)

LIFECYCLE_STREAM = "revision-lifecycle@1"

# activation reasons that demand current accepted selection evidence; the
# remaining ACTIVATION_REASONS (seed, rollback, migrated, expired-reverted)
# are structural re-activations of previously known-good state
EVIDENCE_REQUIRED_REASONS = ("evolved", "promote", "confirmed")


class LifecycleError(Exception):
    """A native-revision lifecycle failure (validation, staleness, evidence,
    breaker, or journal integrity)."""


# -- journal records ----------------------------------------------------------------------------


@register("revision-retained", 2)
@dataclass(frozen=True)
class RevisionRetained:
    """Immutable revision IDENTITY only: the exact `HarnessRevision` pinned
    by content-addressed ref. Evidence lives in separate appended records."""

    revision_id: str
    revision_ref: str  # CAS ref of the exact HarnessRevision
    base_parent_id: str | None
    task_id: str
    task_fingerprint: str
    at: str


@register("revision-evaluated", 1)
@dataclass(frozen=True)
class RevisionEvaluated:
    """One assessment of a retained revision. A revision may be evaluated
    repeatedly under different manifests and baselines."""

    revision_id: str
    baseline_revision_id: str | None
    evaluation_ref: str  # CAS ref of the Evaluation
    manifest_ref: str  # the ScopeManifest the assessment evaluated
    at: str
    run_id: str | None = None


@register("revision-selected", 1)
@dataclass(frozen=True)
class RevisionSelected:
    """One selection decision over a retained revision against a baseline.
    The LATEST selection for a revision is its current verdict."""

    revision_id: str
    baseline_revision_id: str | None
    evaluation_ref: str
    decision_ref: str  # CAS ref of the Decision
    policy_ref: str
    accepted: bool
    at: str
    run_id: str | None = None


@register("trusted-override", 1)
@dataclass(frozen=True)
class TrustedOverride:
    """A distinct, durable operator record authorizing an activation that the
    evidence gate would refuse (rejected or evidence-free revision)."""

    revision_id: str
    reason: str
    at: str


@register("compatibility-link", 1)
@dataclass(frozen=True)
class CompatibilityLink:
    """Which generation serves a revision — the derived compatibility state,
    made explicit so served behavior and lifecycle state can be driven and
    compared together."""

    revision_id: str
    generation_id: str
    at: str


@register("activation-intent", 1)
@dataclass(frozen=True)
class ActivationIntent:
    """Durable intent for ONE cross-journal activation operation: activate
    `generation_id` (served compatibility behavior) and `revision_id` (the
    lifecycle) together, from `baseline_revision_id`."""

    op_id: str
    revision_id: str
    baseline_revision_id: str | None
    generation_id: str
    reason: str
    policy_ref: str
    decision_ref: str | None
    at: str


@register("activation-progress", 1)
@dataclass(frozen=True)
class ActivationProgress:
    op_id: str
    step: str  # e.g. "generation-activated"
    at: str


@register("activation-completed", 1)
@dataclass(frozen=True)
class ActivationCompleted:
    op_id: str
    outcome: str  # completed | abandoned | reverted
    detail: str
    at: str


@register("lifecycle-breaker", 1)
@dataclass(frozen=True)
class LifecycleBreaker:
    state: str  # "open" | "cleared"
    reason: str
    at: str


LifecycleEntry = (
    RevisionRetained
    | RevisionEvaluated
    | RevisionSelected
    | TrustedOverride
    | CompatibilityLink
    | ActivationIntent
    | ActivationProgress
    | ActivationCompleted
    | RevisionActivation
    | LifecycleBreaker
)

_ENTRY_TYPES = (
    RevisionRetained,
    RevisionEvaluated,
    RevisionSelected,
    TrustedOverride,
    CompatibilityLink,
    ActivationIntent,
    ActivationProgress,
    ActivationCompleted,
    RevisionActivation,
    LifecycleBreaker,
)


# -- the journal --------------------------------------------------------------------------------


class RevisionLifecycle(FramedJournal):
    """The canonical native-revision journal for one task."""

    def __init__(self, root_ledger_path: object, task_id: str) -> None:
        base = Path(str(root_ledger_path))
        super().__init__(
            base.with_name(f"{task_id}.revisions.jsonl"),
            task_id,
            LIFECYCLE_STREAM,
            _ENTRY_TYPES,
        )


@dataclass(frozen=True)
class _Ctx:
    task_id: str
    objects: ObjectStore
    journal: RevisionLifecycle


def lifecycle(store: object) -> _Ctx:
    task_id = str(getattr(store, "task_id"))
    objects = getattr(store, "objects")
    ledger_path = getattr(store, "ledger_path")
    return _Ctx(task_id, objects, RevisionLifecycle(ledger_path, task_id))


# -- derived state ------------------------------------------------------------------------------


@dataclass(frozen=True)
class LifecycleState:
    head: str
    retained: dict[str, RevisionRetained]
    links: dict[str, str]  # revision_id -> generation_id
    evaluations: dict[str, tuple[RevisionEvaluated, ...]]
    selections: dict[str, tuple[RevisionSelected, ...]]
    overrides: dict[str, tuple[TrustedOverride, ...]]
    activation_order: tuple[str, ...]  # revision ids, activation order
    active_revision_id: str | None
    open_intents: tuple[ActivationIntent, ...]
    breaker_open: bool
    breaker_reason: str | None
    journal_errors: int


def _state_from(view: FramedView) -> LifecycleState:
    retained: dict[str, RevisionRetained] = {}
    links: dict[str, str] = {}
    evaluations: dict[str, list[RevisionEvaluated]] = {}
    selections: dict[str, list[RevisionSelected]] = {}
    overrides: dict[str, list[TrustedOverride]] = {}
    order: list[str] = []
    active: str | None = None
    intents: dict[str, ActivationIntent] = {}
    completed: set[str] = set()
    breaker_open = False
    breaker_reason: str | None = None
    for entry in view.entries:
        if isinstance(entry, RevisionRetained):
            retained[entry.revision_id] = entry
        elif isinstance(entry, CompatibilityLink):
            links.setdefault(entry.revision_id, entry.generation_id)
        elif isinstance(entry, RevisionEvaluated):
            evaluations.setdefault(entry.revision_id, []).append(entry)
        elif isinstance(entry, RevisionSelected):
            selections.setdefault(entry.revision_id, []).append(entry)
        elif isinstance(entry, TrustedOverride):
            overrides.setdefault(entry.revision_id, []).append(entry)
        elif isinstance(entry, RevisionActivation):
            revision_id = entry.revision.revision_id
            order.append(revision_id)
            if revision_id in retained:  # only a retained revision can be active
                active = revision_id
        elif isinstance(entry, ActivationIntent):
            intents[entry.op_id] = entry
        elif isinstance(entry, ActivationCompleted):
            completed.add(entry.op_id)
        elif isinstance(entry, LifecycleBreaker):
            breaker_open = entry.state == "open"
            breaker_reason = entry.reason if breaker_open else None
    return LifecycleState(
        head=view.head,
        retained=retained,
        links=links,
        evaluations={k: tuple(v) for k, v in evaluations.items()},
        selections={k: tuple(v) for k, v in selections.items()},
        overrides={k: tuple(v) for k, v in overrides.items()},
        activation_order=tuple(order),
        active_revision_id=active,
        open_intents=tuple(
            i for op, i in intents.items() if op not in completed
        ),
        breaker_open=breaker_open,
        breaker_reason=breaker_reason,
        journal_errors=view.errors,
    )


def state(store: object) -> LifecycleState:
    return _state_from(lifecycle(store).journal.read())


def _require_clean(st: LifecycleState, what: str) -> None:
    """Journal errors refuse BOTH mutation and materialization: partial or
    tampered views must never drive state."""
    if st.journal_errors:
        raise LifecycleError(
            f"{what} refused: the lifecycle journal has {st.journal_errors} "
            "unverifiable line(s); repair it first"
        )


def active_revision_id(store: object) -> str | None:
    return state(store).active_revision_id


def lineage(store: object) -> tuple[str, ...]:
    """Base-parent chain from the active revision (bounded, cycle-free)."""
    st = state(store)
    chain: list[str] = []
    cursor = st.active_revision_id
    seen: set[str] = set()
    while cursor is not None and cursor not in seen and len(chain) <= len(st.retained):
        chain.append(cursor)
        seen.add(cursor)
        record = st.retained.get(cursor)
        cursor = record.base_parent_id if record is not None else None
    return tuple(chain)


# -- validation ---------------------------------------------------------------------------------


def load_revision(ctx: _Ctx, revision_ref: str) -> HarnessRevision:
    return codec.loads(ctx.objects.get_text(revision_ref), HarnessRevision)


def _load_manifest(ctx: _Ctx, manifest_ref: str) -> ScopeManifest:
    try:
        manifest: ScopeManifest = codec.loads(
            ctx.objects.get_text(manifest_ref), ScopeManifest
        )
        validate_scope_manifest(manifest)
        return manifest
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, ContractViolation) as exc:
        raise LifecycleError(f"scope manifest unavailable/invalid: {exc}") from None


def _parent_manifest(
    ctx: _Ctx, st: LifecycleState, revision: HarnessRevision
) -> ScopeManifest | None:
    if revision.base_parent is None:
        return None
    parent = st.retained.get(revision.base_parent.revision_id)
    if parent is None:
        raise LifecycleError(
            f"base parent {revision.base_parent.revision_id} of "
            f"{revision.ref.revision_id} is not retained; retain the parent first"
        )
    parent_revision = load_revision(ctx, parent.revision_ref)
    return _load_manifest(ctx, parent_revision.scope_manifest_ref)


def validate_composite(
    ctx: _Ctx,
    revision: HarnessRevision,
    revision_ref: str,
    parent_manifest: ScopeManifest | None,
) -> ScopeManifest:
    """Full pre-retention/activation validation of a composite revision:
    identity, whole-revision structure, descriptors, scope, provenance,
    artifact hashes — and STATE REPLAY against the parent manifest: every
    delta.before must equal the parent's exact binding, all transitions
    apply, unchanged bindings carry over, and the result must equal the
    stored child manifest. Undeclared changes, stale before-states,
    mask/absent confusion, and dropped surfaces fail closed."""
    if hash_text(codec.dumps(revision)) != revision_ref:
        raise LifecycleError(
            f"revision_ref {revision_ref[:12]}… does not match the revision's "
            "content hash — identity mismatch"
        )
    if revision.ref.scope != ScopeRef(LEVEL_TASK, ctx.task_id):
        raise LifecycleError(
            f"revision {revision.ref.revision_id} is scoped to "
            f"{revision.ref.scope}, not task {ctx.task_id!r}"
        )
    try:
        validate_revision(revision)  # whole revision: all deltas, order, parents
    except ContractViolation as exc:
        raise LifecycleError(f"revision fails validation: {exc}") from None
    manifest = _load_manifest(ctx, revision.scope_manifest_ref)
    if manifest.scope != revision.ref.scope:
        raise LifecycleError("scope manifest scope disagrees with the revision")

    # -- state replay against the parent ------------------------------------
    parent_bindings: dict[tuple[str, str], BindingState] = (
        {}
        if parent_manifest is None
        else {(b.kind, b.name): b.binding for b in parent_manifest.bindings}
    )
    computed = dict(parent_bindings)  # unchanged bindings carry over
    for delta in revision.deltas:
        key = (delta.kind, delta.name)
        current = parent_bindings.get(key, ABSENT)
        if current != delta.before:
            raise LifecycleError(
                f"delta {delta.kind}/{delta.name} declares before={delta.before} "
                f"but the parent manifest holds {current} — stale or mismatched "
                "before-state"
            )
        if delta.after.state == BINDING_ABSENT:
            computed.pop(key, None)  # delete: the surface leaves the manifest
        else:
            computed[key] = delta.after  # create/update/mask/unmask
    stored = {(b.kind, b.name): b.binding for b in manifest.bindings}
    if computed != stored:
        undeclared = {k for k in stored if stored[k] != computed.get(k)}
        dropped = {k for k in computed if k not in stored}
        raise LifecycleError(
            "child manifest does not equal the parent manifest with the "
            f"declared deltas applied (undeclared changes: {sorted(undeclared)}; "
            f"dropped surfaces: {sorted(dropped)})"
        )

    # -- closure over the child manifest -------------------------------------
    for (kind, name), binding in stored.items():
        if binding.state != "content":
            continue
        if binding.descriptor_ref not in DESCRIPTOR_REGISTRY:
            raise LifecycleError(
                f"binding {kind}/{name} pins unknown descriptor "
                f"{binding.descriptor_ref!r}"
            )
        assert binding.content_ref is not None
        try:
            ctx.objects.get_text(binding.content_ref)  # verifies content==hash
        except (ObjectMissing, ObjectCorruption) as exc:
            raise LifecycleError(
                f"artifact for {kind}/{name} unavailable: {exc}"
            ) from None
    if revision.provenance_ref is not None:
        try:
            text = ctx.objects.get_text(revision.provenance_ref)
            try:
                codec.loads(text, RevisionProvenance)
            except codec.SchemaError:
                codec.loads(text, MigrationProvenance)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            raise LifecycleError(f"provenance unavailable/invalid: {exc}") from None
    return manifest


# -- retention (identity only) ------------------------------------------------------------------


def retain(
    store: object,
    revision: HarnessRevision,
    *,
    task_fingerprint: str,
    generation_id: str | None = None,
    expected_head: str | None = None,
) -> str:
    """Persist the EXACT revision's identity into the lifecycle (idempotent).

    Re-retaining the same id with the same content is a no-op
    (crash-after-retention recovery); a different content for the same id
    fails closed. ``generation_id`` records the serving compatibility
    generation (a CompatibilityLink). Returns the lifecycle head."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "retention")
    if revision.ref.scope != ScopeRef(LEVEL_TASK, ctx.task_id):
        raise LifecycleError(
            f"revision {revision.ref.revision_id} is scoped to "
            f"{revision.ref.scope}, not task {ctx.task_id!r}"
        )
    revision_ref = ctx.objects.put_text(codec.dumps(revision))
    revision_id = revision.ref.revision_id
    existing = st.retained.get(revision_id)
    if existing is not None:
        if existing.revision_ref != revision_ref:
            raise LifecycleError(
                f"revision {revision_id} already retained with different "
                "content — refusing to redefine an immutable revision"
            )
        if generation_id is not None and revision_id not in st.links:
            ctx.journal.append_batch(
                [CompatibilityLink(revision_id, generation_id, now_iso())]
            )
        return st.head  # idempotent: already retained, same artifact
    parent_manifest = _parent_manifest(ctx, st, revision)
    validate_composite(ctx, revision, revision_ref, parent_manifest)
    batch: list[object] = [
        RevisionRetained(
            revision_id=revision_id,
            revision_ref=revision_ref,
            base_parent_id=(
                revision.base_parent.revision_id if revision.base_parent else None
            ),
            task_id=ctx.task_id,
            task_fingerprint=task_fingerprint,
            at=now_iso(),
        )
    ]
    if generation_id is not None:
        batch.append(CompatibilityLink(revision_id, generation_id, now_iso()))
    try:
        return ctx.journal.append_batch(batch, expected_head=expected_head or st.head)
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


# -- evidence -----------------------------------------------------------------------------------


def record_evaluation(
    store: object,
    revision_id: str,
    *,
    baseline_revision_id: str | None,
    evaluation_ref: str,
    manifest_ref: str,
    run_id: str | None = None,
) -> str:
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "evaluation recording")
    if revision_id not in st.retained:
        raise LifecycleError(f"cannot record evaluation: {revision_id} not retained")
    if baseline_revision_id is not None and baseline_revision_id not in st.retained:
        raise LifecycleError(
            f"cannot record evaluation: baseline {baseline_revision_id} not retained"
        )
    try:  # every evidence ref must decode to its schema
        codec.loads(ctx.objects.get_text(evaluation_ref), Evaluation)
        _load_manifest(ctx, manifest_ref)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        raise LifecycleError(f"evaluation evidence invalid: {exc}") from None
    try:
        return ctx.journal.append_batch(
            [
                RevisionEvaluated(
                    revision_id=revision_id,
                    baseline_revision_id=baseline_revision_id,
                    evaluation_ref=evaluation_ref,
                    manifest_ref=manifest_ref,
                    at=now_iso(),
                    run_id=run_id,
                )
            ]
        )
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


def record_selection(
    store: object,
    revision_id: str,
    *,
    baseline_revision_id: str | None,
    evaluation_ref: str,
    decision_ref: str,
    policy_ref: str,
    accepted: bool,
    run_id: str | None = None,
) -> str:
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "selection recording")
    if revision_id not in st.retained:
        raise LifecycleError(f"cannot record selection: {revision_id} not retained")
    if baseline_revision_id == revision_id:
        raise LifecycleError("a revision cannot be selected against itself")
    if baseline_revision_id is not None and baseline_revision_id not in st.retained:
        raise LifecycleError(
            f"cannot record selection: baseline {baseline_revision_id} not retained"
        )
    try:
        decision: Decision = codec.loads(ctx.objects.get_text(decision_ref), Decision)
        codec.loads(ctx.objects.get_text(evaluation_ref), Evaluation)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        raise LifecycleError(f"selection evidence invalid: {exc}") from None
    if decision.accepted != accepted:
        raise LifecycleError(
            "selection record disagrees with its decision evidence "
            f"(record says accepted={accepted}, decision says {decision.accepted})"
        )
    try:
        return ctx.journal.append_batch(
            [
                RevisionSelected(
                    revision_id=revision_id,
                    baseline_revision_id=baseline_revision_id,
                    evaluation_ref=evaluation_ref,
                    decision_ref=decision_ref,
                    policy_ref=policy_ref,
                    accepted=accepted,
                    at=now_iso(),
                    run_id=run_id,
                )
            ]
        )
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


def _check_promote_evidence(st: LifecycleState, revision_id: str) -> None:
    """Promote-like activation requires the revision's LATEST selection to be
    accepted against the CURRENT active baseline."""
    selections = st.selections.get(revision_id, ())
    if not selections:
        raise LifecycleError(
            f"activation of {revision_id} refused: no selection evidence "
            "(use a trusted override to activate without evidence)"
        )
    latest = selections[-1]
    if not latest.accepted:
        raise LifecycleError(
            f"activation of {revision_id} refused: its latest selection was "
            "REJECTED (use a trusted override to activate anyway)"
        )
    if latest.baseline_revision_id != st.active_revision_id:
        raise LifecycleError(
            f"activation of {revision_id} refused: its accepted selection was "
            f"against baseline {latest.baseline_revision_id}, but the active "
            f"revision is {st.active_revision_id} — re-evaluate against the "
            "current baseline"
        )


# -- activation (lifecycle-side) ----------------------------------------------------------------


def activate(
    store: object,
    revision_id: str,
    *,
    reason: str,
    policy_ref: str,
    decision_ref: str | None = None,
    expected_head: str | None = None,
    expected_active_revision_id: str | None = "__unset__",
    override_reason: str | None = None,
) -> str:
    """Activate a retained revision in the LIFECYCLE journal, revalidating it
    against its parent first. Promote-like reasons require current accepted
    selection evidence (or an explicit TrustedOverride). On validation
    failure the durable breaker opens and activation refuses — never a lossy
    fallback. Served compatibility behavior is driven by `run_activation_op`,
    which wraps this in a recoverable cross-journal operation."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "activation")
    if st.breaker_open:
        raise LifecycleError(
            f"lifecycle breaker is open ({st.breaker_reason}); resolve it "
            "before activating"
        )
    if expected_head is not None and st.head != expected_head:
        raise LifecycleError(
            f"stale lifecycle head: authorized at {expected_head.split(':')[0]} "
            f"but the journal is at {st.head.split(':')[0]}"
        )
    if (
        expected_active_revision_id != "__unset__"
        and st.active_revision_id != expected_active_revision_id
    ):
        raise LifecycleError(
            f"expected active revision {expected_active_revision_id} but the "
            f"active revision is {st.active_revision_id}"
        )
    record = st.retained.get(revision_id)
    if record is None:
        raise LifecycleError(f"cannot activate {revision_id}: it is not retained")

    batch: list[object] = []
    if reason in EVIDENCE_REQUIRED_REASONS:
        if override_reason is not None:
            batch.append(TrustedOverride(revision_id, override_reason, now_iso()))
        else:
            _check_promote_evidence(st, revision_id)
    elif override_reason is not None:
        batch.append(TrustedOverride(revision_id, override_reason, now_iso()))

    # revalidate the exact revision against its parent before it takes effect
    try:
        revision = load_revision(ctx, record.revision_ref)
        parent_manifest = _parent_manifest(ctx, st, revision)
        validate_composite(ctx, revision, record.revision_ref, parent_manifest)
    except LifecycleError as exc:
        ctx.journal.append_batch(
            [
                LifecycleBreaker(
                    state="open",
                    reason=f"invalid composite activation of {revision_id}: {exc}",
                    at=now_iso(),
                )
            ]
        )
        raise LifecycleError(
            f"activation of {revision_id} refused and breaker opened: {exc}"
        ) from None
    batch.append(
        RevisionActivation(
            revision=RevisionRef(ScopeRef(LEVEL_TASK, ctx.task_id), revision_id),
            mode=ACTIVATION_DURABLE,
            reason=reason,
            at=now_iso(),
            policy_ref=policy_ref,
            decision_ref=decision_ref,
        )
    )
    try:
        return ctx.journal.append_batch(batch, expected_head=st.head)
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


# -- the recoverable cross-journal activation operation ------------------------------------------


def run_activation_op(
    store: object,
    revision_id: str,
    *,
    reason: str,
    policy_ref: str,
    decision_ref: str | None = None,
    override_reason: str | None = None,
    gen_expected_active: str | None = None,
    gen_expected_head: str | None = None,
) -> str:
    """Activate served compatibility behavior AND the lifecycle as one
    recoverable operation: intent → generation activation → lifecycle
    activation → completion. Identity + evidence must already be persisted
    (retention/evidence records precede this). Crash points resume through
    `reconcile`; a lifecycle failure after the generation activation is NOT
    swallowed — the generation activation is reverted and recorded."""
    from strive.store import Store

    assert isinstance(store, Store)
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "activation operation")
    if st.breaker_open:
        raise LifecycleError(
            f"lifecycle breaker is open ({st.breaker_reason}); resolve it first"
        )
    if st.open_intents:
        raise LifecycleError(
            f"{len(st.open_intents)} unfinished activation operation(s); "
            "reconcile before starting another"
        )
    record = st.retained.get(revision_id)
    if record is None:
        raise LifecycleError(f"cannot activate {revision_id}: it is not retained")
    generation_id = st.links.get(revision_id)
    if generation_id is None:
        raise LifecycleError(
            f"no compatibility generation is linked to {revision_id}; refusing "
            "to change served behavior (link the revision at retention time)"
        )
    # gates run BEFORE the intent so a refused activation writes nothing
    if reason in EVIDENCE_REQUIRED_REASONS and override_reason is None:
        _check_promote_evidence(st, revision_id)

    intent = ActivationIntent(
        op_id=f"op-{uuid.uuid4().hex[:8]}",
        revision_id=revision_id,
        baseline_revision_id=st.active_revision_id,
        generation_id=generation_id,
        reason=reason,
        policy_ref=policy_ref,
        decision_ref=decision_ref,
        at=now_iso(),
    )
    ctx.journal.append_batch([intent])

    # served behavior changes ONLY after intent + identity + evidence persist
    store.activate(
        generation_id,
        reason=reason,
        policy=policy_ref,
        expected_active=gen_expected_active,
        expected_head=gen_expected_head,
    )
    ctx.journal.append_batch(
        [ActivationProgress(intent.op_id, "generation-activated", now_iso())]
    )
    try:
        activate(
            store,
            revision_id,
            reason=reason,
            policy_ref=policy_ref,
            decision_ref=decision_ref,
            override_reason=override_reason,
        )
    except LifecycleError as exc:
        # NOT swallowed: revert the served behavior and record the outcome
        _revert_generation(store, st, intent)
        ctx.journal.append_batch(
            [
                ActivationCompleted(
                    intent.op_id,
                    "reverted",
                    f"lifecycle activation failed after generation activation: {exc}",
                    now_iso(),
                )
            ]
        )
        raise LifecycleError(
            f"activation op {intent.op_id} reverted: {exc}"
        ) from None
    ctx.journal.append_batch(
        [ActivationCompleted(intent.op_id, "completed", "ok", now_iso())]
    )
    return intent.op_id


def _revert_generation(store: object, st: LifecycleState, intent: ActivationIntent) -> None:
    from strive.store import Store

    assert isinstance(store, Store)
    baseline_generation = (
        st.links.get(intent.baseline_revision_id)
        if intent.baseline_revision_id is not None
        else None
    )
    if baseline_generation is not None:
        store.activate(baseline_generation, reason="rollback", policy="manual@0")


def reconcile(store: object) -> tuple[str, ...]:
    """Resume or reconcile unfinished activation operations (every crash
    point): after intent but before the generation activation → abandoned
    (served behavior never changed; the authorizing operation died); after
    the generation activation but before the lifecycle activation → the
    lifecycle activation completes (or the generation activation is reverted
    and the breaker opens); after both → the completion record is appended.
    Returns the outcomes."""
    from strive.store import Store

    assert isinstance(store, Store)
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    if st.journal_errors or not st.open_intents:
        return ()
    if len(st.open_intents) > 1:
        raise LifecycleError(
            f"{len(st.open_intents)} unfinished activation operations; "
            "ambiguous state — manual repair required"
        )
    intent = st.open_intents[0]
    outcomes: list[str] = []
    active_generation = store.active_generation()
    if st.active_revision_id == intent.revision_id:
        ctx.journal.append_batch(
            [
                ActivationCompleted(
                    intent.op_id, "completed", "reconciled: already active", now_iso()
                )
            ]
        )
        outcomes.append("completed")
    elif (
        active_generation is not None
        and active_generation.generation_id == intent.generation_id
    ):
        try:
            activate(
                store,
                intent.revision_id,
                reason=intent.reason,
                policy_ref=intent.policy_ref,
                decision_ref=intent.decision_ref,
            )
            ctx.journal.append_batch(
                [
                    ActivationCompleted(
                        intent.op_id, "completed", "reconciled: resumed", now_iso()
                    )
                ]
            )
            outcomes.append("completed")
        except LifecycleError as exc:
            _revert_generation(store, st, intent)
            ctx.journal.append_batch(
                [
                    ActivationCompleted(
                        intent.op_id,
                        "reverted",
                        f"reconcile: lifecycle activation failed, generation "
                        f"reverted: {exc}",
                        now_iso(),
                    )
                ]
            )
            outcomes.append("reverted")
    else:
        ctx.journal.append_batch(
            [
                ActivationCompleted(
                    intent.op_id,
                    "abandoned",
                    "reconciled: served behavior never changed",
                    now_iso(),
                )
            ]
        )
        outcomes.append("abandoned")
    return tuple(outcomes)


def rollback(store: object) -> str:
    """Whole-revision rollback as ONE recoverable operation: re-activate the
    active revision's base parent in BOTH the generation ledger (served
    behavior) and the lifecycle. Nothing is deleted; per-surface rollback is
    later work. Refuses when the parent has no compatibility generation."""
    st = state(store)
    _require_clean(st, "rollback")
    if st.active_revision_id is None:
        raise LifecycleError("no active revision to roll back")
    record = st.retained[st.active_revision_id]
    if record.base_parent_id is None:
        raise LifecycleError(
            f"active revision {st.active_revision_id} has no parent to roll back to"
        )
    return run_activation_op(
        store,
        record.base_parent_id,
        reason="rollback",
        policy_ref="manual@0",
    )


# -- breaker ------------------------------------------------------------------------------------


def open_breaker(store: object, reason: str, *, expected_head: str | None = None) -> None:
    ctx = lifecycle(store)
    ctx.journal.append_batch(
        [LifecycleBreaker(state="open", reason=reason, at=now_iso())],
        expected_head=expected_head,
    )


def clear_breaker(store: object, reason: str, *, expected_head: str | None = None) -> None:
    """Clear the breaker only when the active revision revalidates against
    its parent (or there is no active revision) — never an implicit lossy
    recovery. Head-checked: a concurrent journal write refuses the clear."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "breaker clear")
    if not st.breaker_open:
        raise LifecycleError("the lifecycle breaker is not open")
    if st.active_revision_id is not None:
        record = st.retained[st.active_revision_id]
        revision = load_revision(ctx, record.revision_ref)
        parent_manifest = _parent_manifest(ctx, st, revision)
        validate_composite(ctx, revision, record.revision_ref, parent_manifest)
    try:
        ctx.journal.append_batch(
            [LifecycleBreaker(state="cleared", reason=reason, at=now_iso())],
            expected_head=expected_head or st.head,
        )
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


# -- materialization + compatibility parity -----------------------------------------------------


def materialize_active(store: object) -> ResolvedHarnessManifest | None:
    """The active composite state, resolved from the active revision's COMPLETE
    scope manifest (every surface). None when there is no active revision.
    Refuses to materialize over a corrupt journal."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "materialization")
    if st.active_revision_id is None:
        return None
    record = st.retained[st.active_revision_id]
    revision = load_revision(ctx, record.revision_ref)
    manifest = _load_manifest(ctx, revision.scope_manifest_ref)
    scope = ScopeRef(LEVEL_TASK, ctx.task_id)
    effective = tuple(b for b in manifest.bindings if b.binding.state == "content")
    resolved = ResolvedHarnessManifest(
        resolution_chain=(scope,),
        contributions=(
            ScopeContribution(
                scope=scope,
                revision=RevisionRef(scope, st.active_revision_id),
                journal_head=JournalHeadRef("revisions-jsonl@1", st.head),
            ),
        ),
        effective=effective,
    )
    validate_resolved_manifest(resolved)
    return resolved


@dataclass(frozen=True)
class CompatibilityProjection:
    """The explicitly-derived strategy-only view of the active composite
    revision — for Stage 1–2b compatibility. Non-code surfaces are listed but
    live only in the composite manifest; they are never flattened into this
    projection."""

    active_revision_id: str
    strategy_source_ref: str
    strategy_source_text: str
    other_surfaces: tuple[tuple[str, str], ...]
    derived: bool = True


def compatibility_projection(store: object) -> CompatibilityProjection | None:
    ctx = lifecycle(store)
    resolved = materialize_active(store)
    if resolved is None:
        return None
    st = _state_from(ctx.journal.read())
    assert st.active_revision_id is not None
    strategy = next(
        (
            b
            for b in resolved.effective
            if (b.kind, b.name) == ("strategy-code", "solve")
        ),
        None,
    )
    if strategy is None or strategy.binding.content_ref is None:
        raise LifecycleError(
            f"active revision {st.active_revision_id} has no strategy-code/solve "
            "binding to project"
        )
    others = tuple(
        (b.kind, b.name)
        for b in resolved.effective
        if (b.kind, b.name) != ("strategy-code", "solve")
    )
    return CompatibilityProjection(
        active_revision_id=st.active_revision_id,
        strategy_source_ref=strategy.binding.content_ref,
        strategy_source_text=ctx.objects.get_text(strategy.binding.content_ref),
        other_surfaces=others,
    )


@dataclass(frozen=True)
class CompatParity:
    """Lifecycle vs served-compatibility agreement, exposed — never assumed."""

    ok: bool
    lifecycle_active: str | None
    linked_generation: str | None
    generation_active: str | None
    reason: str


def compat_parity(store: object) -> CompatParity:
    from strive.store import Store

    assert isinstance(store, Store)
    st = state(store)
    active_generation = store.active_generation()
    generation_active = (
        active_generation.generation_id if active_generation is not None else None
    )
    if st.journal_errors:
        return CompatParity(
            False, None, None, generation_active,
            f"lifecycle journal has {st.journal_errors} unverifiable line(s)",
        )
    if st.active_revision_id is None:
        return CompatParity(
            generation_active is None, None, None, generation_active,
            "no active revision" if generation_active is None
            else "generation active but lifecycle empty (run migrate/sync)",
        )
    linked = st.links.get(st.active_revision_id)
    if linked is None:
        return CompatParity(
            False, st.active_revision_id, None, generation_active,
            f"active revision {st.active_revision_id} has no compatibility link",
        )
    if linked != generation_active:
        return CompatParity(
            False, st.active_revision_id, linked, generation_active,
            f"lifecycle serves {linked} but the generation ledger serves "
            f"{generation_active}",
        )
    projection = compatibility_projection(store)
    assert projection is not None and active_generation is not None
    if projection.strategy_source_ref != active_generation.source_ref:
        return CompatParity(
            False, st.active_revision_id, linked, generation_active,
            "linked generation source differs from the revision's strategy binding",
        )
    return CompatParity(
        True, st.active_revision_id, linked, generation_active, "ok"
    )


# -- generation-history sync (migration 0003 + ongoing convergence) ------------------------------


def _backfill_revision(
    ctx: _Ctx,
    generation: object,
    parent_revision_id: str | None,
    parent_source_ref: str | None,
) -> HarnessRevision:
    """A strategy-only revision for a generation with no lifecycle identity
    (pre-lifecycle history, or runs where lifecycle authority was refused)."""
    from strive.contracts import Generation

    assert isinstance(generation, Generation)
    pinned = "strategy-code@1"
    scope = ScopeRef(LEVEL_TASK, ctx.task_id)
    before = (
        ABSENT
        if parent_source_ref is None
        else content_binding("strategy-code", parent_source_ref, descriptor_ref=pinned)
    )
    after = content_binding(
        "strategy-code", generation.source_ref, descriptor_ref=pinned
    )
    manifest = ScopeManifest(
        scope=scope,
        bindings=(ManifestBinding("strategy-code", "solve", after),),
    )
    validate_scope_manifest(manifest)
    manifest_ref = ctx.objects.put_text(codec.dumps(manifest))
    provenance = RevisionProvenance(
        origin="generation-backfill",
        task_id=ctx.task_id,
        task_fingerprint=generation.task_fingerprint,
        surface=generation.surface,
        weakness_id=generation.weakness_id,
        parent_revision_id=parent_revision_id,
        decision_ref=None,
    )
    provenance_ref = ctx.objects.put_text(codec.dumps(provenance))
    revision = HarnessRevision(
        ref=RevisionRef(scope, generation.generation_id.replace("gen-", "rev-")),
        base_parent=(
            RevisionRef(scope, parent_revision_id)
            if parent_revision_id is not None
            else None
        ),
        provenance_parents=(),
        deltas=(SurfaceDelta("strategy-code", "solve", before, after),),
        scope_manifest_ref=manifest_ref,
        proposer="generation-backfill@1",
        summary=f"backfilled from {generation.generation_id} ({generation.origin})",
        created_at=generation.created_at,
        provenance_ref=provenance_ref,
    )
    validate_revision(revision)
    return revision


def sync_needed(store: object) -> bool:
    from strive.store import Store

    assert isinstance(store, Store)
    st = state(store)
    if st.journal_errors:
        return False  # repair first; sync would refuse over a corrupt journal
    generation_to_revision = {g: r for r, g in st.links.items()}
    for generation_id in store.generations():
        if generation_id not in generation_to_revision:
            return True
    mapped = [st.links[r] for r in st.activation_order if r in st.links]
    native = [a.generation_id for a in store.activations()]
    return len(mapped) < len(native)


def sync_from_generations(store: object) -> None:
    """Converge the lifecycle with generation-native history: backfill a
    lifecycle identity for every generation that lacks one (parents first,
    ledger order) and replay the generation activation history so the ACTUAL
    active revision is preserved — never just the seed. Used by migration
    `0003-lifecycle-backfill` and by every seeding pass, so pre-lifecycle
    stores and lifecycle-refused runs both reconcile. Fails loudly when the
    histories have diverged (never silently rewrites either side)."""
    from strive.store import Store

    assert isinstance(store, Store)
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    _require_clean(st, "generation-history sync")
    if st.open_intents:
        raise LifecycleError("unfinished activation operation; reconcile first")

    generation_to_revision = {g: r for r, g in st.links.items()}
    generations = store.generations()
    # 1. identities: backfill unlinked generations, parents first (ledger order)
    for generation_id, generation in generations.items():
        if generation_id in generation_to_revision:
            continue
        parent_revision_id: str | None = None
        parent_source_ref: str | None = None
        if generation.parent_id is not None:
            parent_revision_id = generation_to_revision.get(generation.parent_id)
            if parent_revision_id is None:
                raise LifecycleError(
                    f"cannot backfill {generation_id}: its parent "
                    f"{generation.parent_id} has no lifecycle identity"
                )
            parent_source_ref = generations[generation.parent_id].source_ref
        revision = _backfill_revision(
            ctx, generation, parent_revision_id, parent_source_ref
        )
        retain(
            store,
            revision,
            task_fingerprint=generation.task_fingerprint,
            generation_id=generation_id,
        )
        generation_to_revision[generation_id] = revision.ref.revision_id
        st = _state_from(ctx.journal.read())

    # 2. activations: the lifecycle activation history (mapped to generation
    #    ids) must be a prefix of the native history; replay the missing tail
    mapped = [
        st.links[r] for r in st.activation_order if r in st.links
    ]
    native = store.activations()
    native_ids = [a.generation_id for a in native]
    if mapped != native_ids[: len(mapped)]:
        raise LifecycleError(
            "lifecycle and generation activation histories have diverged; "
            f"lifecycle (mapped): {mapped}, generation: {native_ids} — manual "
            "reconciliation required"
        )
    for activation in native[len(mapped):]:
        revision_id = generation_to_revision.get(activation.generation_id)
        if revision_id is None:
            raise LifecycleError(
                f"activation of {activation.generation_id} has no lifecycle "
                "identity to replay"
            )
        # trusted history replay: these activations already happened in the
        # authoritative ledger; the lifecycle mirrors them (revalidated)
        record = st.retained[revision_id]
        revision = load_revision(ctx, record.revision_ref)
        parent_manifest = _parent_manifest(ctx, st, revision)
        validate_composite(ctx, revision, record.revision_ref, parent_manifest)
        ctx.journal.append_batch(
            [
                RevisionActivation(
                    revision=RevisionRef(
                        ScopeRef(LEVEL_TASK, ctx.task_id), revision_id
                    ),
                    mode=ACTIVATION_DURABLE,
                    reason="migrated",
                    at=activation.at,
                    policy_ref=(
                        activation.policy
                        if "@" in activation.policy
                        else f"{activation.policy}@0"
                    ),
                )
            ]
        )
        st = _state_from(ctx.journal.read())


# -- composite fixture builder ------------------------------------------------------------------


def compose_revision(
    store: object,
    *,
    revision_id: str,
    base_parent_id: str | None,
    parent_manifest_bindings: tuple[ManifestBinding, ...],
    surfaces: dict[tuple[str, str], str],
    proposer: str,
    summary: str,
    task_fingerprint: str,
    weakness_id: str | None = None,
    origin: str = "composite-fixture",
) -> tuple[HarnessRevision, str]:
    """Build and CAS-store an immutable multi-surface revision from a set of
    ``(kind, name) -> source text`` surfaces, deriving deltas against the
    parent's manifest bindings. Bindings the child does NOT touch are carried
    over unchanged (a code-only child of a code+prompt parent preserves the
    prompt). Lifecycle-only; no claim that any surface improves behavior."""
    ctx = lifecycle(store)
    scope = ScopeRef(LEVEL_TASK, ctx.task_id)
    parent_by_key = {(b.kind, b.name): b.binding for b in parent_manifest_bindings}

    deltas: list[SurfaceDelta] = []
    computed: dict[tuple[str, str], BindingState] = dict(parent_by_key)
    for (kind, name), text in surfaces.items():
        content_ref = ctx.objects.put_text(text)
        after = content_binding(kind, content_ref)
        before = parent_by_key.get((kind, name), ABSENT)
        deltas.append(SurfaceDelta(kind=kind, name=name, before=before, after=after))
        computed[(kind, name)] = after
    deltas.sort(key=lambda d: (d.kind, d.name))
    for delta in deltas:
        delta_label(delta)  # rejects no-ops

    manifest_bindings = tuple(
        ManifestBinding(kind, name, binding)
        for (kind, name), binding in sorted(computed.items())
    )
    manifest = ScopeManifest(scope=scope, bindings=manifest_bindings)
    validate_scope_manifest(manifest)
    manifest_ref = ctx.objects.put_text(codec.dumps(manifest))
    provenance = RevisionProvenance(
        origin=origin,
        task_id=ctx.task_id,
        task_fingerprint=task_fingerprint,
        surface="composite" if len(surfaces) > 1 else next(iter(surfaces))[0],
        weakness_id=weakness_id,
        parent_revision_id=base_parent_id,
        decision_ref=None,
    )
    provenance_ref = ctx.objects.put_text(codec.dumps(provenance))
    revision = HarnessRevision(
        ref=RevisionRef(scope, revision_id),
        base_parent=RevisionRef(scope, base_parent_id) if base_parent_id else None,
        provenance_parents=(),
        deltas=tuple(deltas),
        scope_manifest_ref=manifest_ref,
        proposer=proposer,
        summary=summary,
        created_at=now_iso(),
        provenance_ref=provenance_ref,
    )
    validate_revision(revision)
    revision_ref = ctx.objects.put_text(codec.dumps(revision))
    return revision, revision_ref
