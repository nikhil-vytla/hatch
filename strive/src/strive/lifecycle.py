"""Stage-3B.3: the canonical native-revision lifecycle.

An append-only, task-scoped journal (`ledger/<task>.revisions.jsonl`) that
OWNS native composite revisions — separate from the generation ledger and
from the generation→revision mirror (which remain derived compatibility
state). It records three kinds of entry in crash-framed, hash-chained,
expected-head batches (see `strive.framing`):

- `RevisionRetained` — a native revision entered the lifecycle (accepted or
  rejected), pinned by the content-addressed ref of the EXACT
  `HarnessRevision` that was evaluated, with links to its evaluation and
  decision evidence;
- `RevisionActivation` (the frozen ADR-0001 record) — the active revision at
  a point in history; active state is the latest valid activation;
- `LifecycleBreaker` — a durable block on activation when a composite
  revision fails validation, cleared only against a revalidated revision.

Identity is exact: the revision id that was evaluated is the id retained and,
on acceptance, the id activated — never an equivalent replacement built after
evaluation. Active state is materialized from the revision's COMPLETE
`ScopeManifest` (every surface), so multi-surface state is never flattened
into a strategy-only `Generation`; a strategy-only generation exists only as
an explicitly derived compatibility projection.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore, hash_text
from strive.codec import register
from strive.framing import FramedJournal, FramedView, FramingError
from strive.revisions import (
    ACTIVATION_DURABLE,
    ContractViolation,
    DESCRIPTOR_REGISTRY,
    HarnessRevision,
    LEVEL_TASK,
    ManifestBinding,
    ResolvedHarnessManifest,
    RevisionActivation,
    RevisionProvenance,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    JournalHeadRef,
    MigrationProvenance,
    content_binding,
    validate_resolved_manifest,
    validate_revision,
    validate_scope_manifest,
)
from strive.events import now_iso

LIFECYCLE_STREAM = "revision-lifecycle@1"


class LifecycleError(Exception):
    """A native-revision lifecycle failure (validation, staleness, breaker)."""


# -- journal records ----------------------------------------------------------------------------


@register("revision-retained", 1)
@dataclass(frozen=True)
class RevisionRetained:
    """A native revision entered the lifecycle. The revision itself lives in
    CAS at ``revision_ref`` (content-addressed, so the id↔artifact binding is
    provable); this record links the exact baseline and candidate revisions
    to their existing evaluation/decision evidence — no evidence schema is
    frozen, only versioned CAS refs are stored."""

    revision_id: str
    revision_ref: str  # CAS ref of the exact HarnessRevision
    base_parent_id: str | None
    task_id: str
    task_fingerprint: str
    accepted: bool
    baseline_revision_id: str | None
    evaluation_ref: str | None  # CAS ref of the candidate Evaluation
    decision_ref: str | None  # CAS ref of the Decision
    at: str


@register("lifecycle-breaker", 1)
@dataclass(frozen=True)
class LifecycleBreaker:
    state: str  # "open" | "cleared"
    reason: str
    at: str


LifecycleEntry = RevisionRetained | RevisionActivation | LifecycleBreaker

_ENTRY_TYPES = (RevisionRetained, RevisionActivation, LifecycleBreaker)


# -- the journal --------------------------------------------------------------------------------


class RevisionLifecycle(FramedJournal):
    """The canonical native-revision journal for one task."""

    def __init__(self, root_ledger_path: "object", task_id: str) -> None:
        from pathlib import Path

        base = Path(str(root_ledger_path))
        super().__init__(
            base.with_name(f"{task_id}.revisions.jsonl"),
            task_id,
            LIFECYCLE_STREAM,
            _ENTRY_TYPES,
        )


# a store-shaped protocol is avoided; we take the pieces we need explicitly
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
    activation_order: tuple[str, ...]  # revision ids, activation order
    active_revision_id: str | None
    breaker_open: bool
    breaker_reason: str | None
    journal_errors: int


def _state_from(view: FramedView) -> LifecycleState:
    retained: dict[str, RevisionRetained] = {}
    order: list[str] = []
    active: str | None = None
    breaker_open = False
    breaker_reason: str | None = None
    for entry in view.entries:
        if isinstance(entry, RevisionRetained):
            retained[entry.revision_id] = entry
        elif isinstance(entry, RevisionActivation):
            revision_id = entry.revision.revision_id
            order.append(revision_id)
            if revision_id in retained:  # only a retained revision can be active
                active = revision_id
        elif isinstance(entry, LifecycleBreaker):
            breaker_open = entry.state == "open"
            breaker_reason = entry.reason if breaker_open else None
    return LifecycleState(
        head=view.head,
        retained=retained,
        activation_order=tuple(order),
        active_revision_id=active,
        breaker_open=breaker_open,
        breaker_reason=breaker_reason,
        journal_errors=view.errors,
    )


def state(store: object) -> LifecycleState:
    return _state_from(lifecycle(store).journal.read())


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


def validate_composite(
    ctx: _Ctx, revision: HarnessRevision, revision_ref: str
) -> ScopeManifest:
    """Full pre-retention/activation validation of a composite revision:
    identity, whole-revision structure, descriptors, scope, manifest closure,
    provenance, and artifact hashes. Raises LifecycleError (fail closed)."""
    # the content-addressed ref must actually name THIS revision
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
    # the scope manifest: exists, decodes, validates, task-scoped
    try:
        manifest: ScopeManifest = codec.loads(
            ctx.objects.get_text(revision.scope_manifest_ref), ScopeManifest
        )
        validate_scope_manifest(manifest)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, ContractViolation) as exc:
        raise LifecycleError(f"scope manifest unavailable/invalid: {exc}") from None
    if manifest.scope != revision.ref.scope:
        raise LifecycleError("scope manifest scope disagrees with the revision")
    # manifest closure: every content binding pins a known descriptor and its
    # artifact exists and hashes correctly (CAS get_text verifies the hash)
    manifest_content = {
        (b.kind, b.name): b.binding
        for b in manifest.bindings
        if b.binding.state == "content"
    }
    for (kind, name), binding in manifest_content.items():
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
    # every delta's post-state must be represented in the manifest closure,
    # so active state materialized from the manifest is exactly the deltas'
    # result — non-code surfaces can never be silently dropped
    for delta in revision.deltas:
        after = delta.after
        if after.state == "content":
            got = manifest_content.get((delta.kind, delta.name))
            if got is None or got.content_ref != after.content_ref:
                raise LifecycleError(
                    f"delta {delta.kind}/{delta.name} after-state is not present "
                    "in the scope manifest (closure incomplete)"
                )
        elif (delta.kind, delta.name) in manifest_content:
            raise LifecycleError(
                f"delta {delta.kind}/{delta.name} removes the surface but the "
                "manifest still binds content (closure inconsistent)"
            )
    # provenance: decodes to a known provenance record
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


# -- retention ----------------------------------------------------------------------------------


def retain(
    store: object,
    revision: HarnessRevision,
    *,
    accepted: bool,
    baseline_revision_id: str | None,
    evaluation_ref: str | None,
    decision_ref: str | None,
    task_fingerprint: str,
    expected_head: str | None = None,
) -> str:
    """Persist the EXACT evaluated revision into the lifecycle (idempotent).

    The revision is stored in CAS; a `RevisionRetained` entry links it to its
    evidence. Re-retaining the same id with the same content is a no-op
    (crash-after-retention recovery); a different content for the same id
    fails closed. Returns the new (or unchanged) lifecycle head."""
    ctx = lifecycle(store)
    revision_ref = ctx.objects.put_text(codec.dumps(revision))
    validate_composite(ctx, revision, revision_ref)
    revision_id = revision.ref.revision_id
    base_parent_id = revision.base_parent.revision_id if revision.base_parent else None

    # optimistic: read state, then append under append_batch's own lock with
    # an expected-head guard (holding the flock across append would deadlock —
    # flock is not reentrant across the two open descriptions)
    st = _state_from(ctx.journal.read())
    existing = st.retained.get(revision_id)
    if existing is not None:
        if existing.revision_ref != revision_ref:
            raise LifecycleError(
                f"revision {revision_id} already retained with different "
                "content — refusing to redefine an immutable revision"
            )
        return st.head  # idempotent: already retained, same artifact
    # parent-head check: a non-seed revision's base parent must already be
    # retained (you cannot retain a child of an unknown revision)
    if base_parent_id is not None and base_parent_id not in st.retained:
        raise LifecycleError(
            f"base parent {base_parent_id} of {revision_id} is not retained; "
            "retain the parent first"
        )
    record = RevisionRetained(
        revision_id=revision_id,
        revision_ref=revision_ref,
        base_parent_id=base_parent_id,
        task_id=ctx.task_id,
        task_fingerprint=task_fingerprint,
        accepted=accepted,
        baseline_revision_id=baseline_revision_id,
        evaluation_ref=evaluation_ref,
        decision_ref=decision_ref,
        at=now_iso(),
    )
    try:
        return ctx.journal.append_batch(
            [record], expected_head=expected_head or st.head
        )
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


# -- activation + rollback ----------------------------------------------------------------------


def activate(
    store: object,
    revision_id: str,
    *,
    reason: str,
    policy_ref: str,
    decision_ref: str | None = None,
    expected_head: str | None = None,
    expected_active_revision_id: str | None = "__unset__",
) -> str:
    """Activate a retained revision, revalidating it first. On validation
    failure the durable breaker opens and activation refuses — never a lossy
    fallback to a generation. Activation requires the expected lifecycle head
    and (unless suppressed) the expected currently-active revision."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
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
    # revalidate the exact revision before it takes effect
    try:
        revision = load_revision(ctx, record.revision_ref)
        validate_composite(ctx, revision, record.revision_ref)
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
    activation = RevisionActivation(
        revision=RevisionRef(ScopeRef(LEVEL_TASK, ctx.task_id), revision_id),
        mode=ACTIVATION_DURABLE,
        reason=reason,
        at=now_iso(),
        policy_ref=policy_ref,
        decision_ref=decision_ref,
    )
    try:
        return ctx.journal.append_batch([activation], expected_head=st.head)
    except FramingError as exc:
        raise LifecycleError(str(exc)) from None


def rollback(store: object, *, expected_active_revision_id: str | None = "__unset__") -> str:
    """Whole-revision rollback: append a new activation of the current active
    revision's base parent (the prior known-good revision). Nothing is
    deleted; per-surface rollback is later work."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    if st.active_revision_id is None:
        raise LifecycleError("no active revision to roll back")
    record = st.retained[st.active_revision_id]
    if record.base_parent_id is None:
        raise LifecycleError(
            f"active revision {st.active_revision_id} has no parent to roll back to"
        )
    return activate(
        store,
        record.base_parent_id,
        reason="rollback",
        policy_ref="manual@0",
        expected_head=st.head,
        expected_active_revision_id=(
            st.active_revision_id
            if expected_active_revision_id == "__unset__"
            else expected_active_revision_id
        ),
    )


# -- breaker / kill -----------------------------------------------------------------------------


def open_breaker(store: object, reason: str) -> None:
    ctx = lifecycle(store)
    ctx.journal.append_batch([LifecycleBreaker(state="open", reason=reason, at=now_iso())])


def clear_breaker(store: object, reason: str) -> None:
    """Clear the breaker only when the active revision revalidates (or there
    is no active revision) — never an implicit lossy recovery."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    if not st.breaker_open:
        raise LifecycleError("the lifecycle breaker is not open")
    if st.active_revision_id is not None:
        record = st.retained[st.active_revision_id]
        revision = load_revision(ctx, record.revision_ref)
        validate_composite(ctx, revision, record.revision_ref)  # raises if still bad
    ctx.journal.append_batch(
        [LifecycleBreaker(state="cleared", reason=reason, at=now_iso())]
    )


# -- materialization + compatibility projection -------------------------------------------------


def materialize_active(store: object) -> ResolvedHarnessManifest | None:
    """The active composite state, resolved from the active revision's COMPLETE
    scope manifest (every surface). None when there is no active revision."""
    ctx = lifecycle(store)
    st = _state_from(ctx.journal.read())
    if st.active_revision_id is None:
        return None
    record = st.retained[st.active_revision_id]
    revision = load_revision(ctx, record.revision_ref)
    manifest: ScopeManifest = codec.loads(
        ctx.objects.get_text(revision.scope_manifest_ref), ScopeManifest
    )
    scope = ScopeRef(LEVEL_TASK, ctx.task_id)
    effective = tuple(
        b for b in manifest.bindings if b.binding.state == "content"
    )
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
    other_surfaces: tuple[tuple[str, str], ...]  # (kind, name) present but not projected
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


# -- composite fixture builder ------------------------------------------------------------------


def seed_lifecycle(
    store: object, *, seed_revision_id: str, seed_source: str, task_fingerprint: str
) -> str | None:
    """Seed the lifecycle from the seed strategy artifact, exactly once: build
    a base (no-parent) strategy-code revision, retain it, and activate it.
    No-op when the lifecycle already has an active revision (idempotent across
    restarts and repeated cycles). Returns the active revision id, or None."""
    if state(store).active_revision_id is not None:
        return active_revision_id(store)
    revision, _ref = compose_revision(
        store,
        revision_id=seed_revision_id,
        base_parent_id=None,
        parent_manifest_bindings=(),
        surfaces={("strategy-code", "solve"): seed_source},
        proposer="seed@0",
        summary="lifecycle seed",
        task_fingerprint=task_fingerprint,
        origin="seed",
    )
    retain(
        store,
        revision,
        accepted=True,
        baseline_revision_id=None,
        evaluation_ref=None,
        decision_ref=None,
        task_fingerprint=task_fingerprint,
    )
    activate(
        store,
        seed_revision_id,
        reason="seed",
        policy_ref="seed@0",
        expected_active_revision_id=None,
    )
    return seed_revision_id


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
    """Build and CAS-store an immutable multi-surface revision (its manifest,
    provenance, and the revision itself) from a set of ``(kind, name) -> source
    text`` surfaces, deriving deltas against the parent's manifest bindings.

    Lifecycle-only: this exists so code+prompt revisions can be exercised
    through retain/activate/rollback without any claim that the extra surface
    improves behavior. Returns (revision, revision_ref)."""
    from strive.revisions import SurfaceDelta, delta_label

    ctx = lifecycle(store)
    scope = ScopeRef(LEVEL_TASK, ctx.task_id)
    parent_by_key = {(b.kind, b.name): b.binding for b in parent_manifest_bindings}

    manifest_bindings: list[ManifestBinding] = []
    deltas: list[SurfaceDelta] = []
    for (kind, name), text in surfaces.items():
        content_ref = ctx.objects.put_text(text)
        after = content_binding(kind, content_ref)
        manifest_bindings.append(ManifestBinding(kind, name, after))
        before = parent_by_key.get((kind, name))
        from strive.revisions import ABSENT

        deltas.append(
            SurfaceDelta(kind=kind, name=name, before=before or ABSENT, after=after)
        )
    manifest_bindings.sort(key=lambda b: (b.kind, b.name))
    deltas.sort(key=lambda d: (d.kind, d.name))
    for delta in deltas:
        delta_label(delta)  # rejects no-ops

    manifest = ScopeManifest(scope=scope, bindings=tuple(manifest_bindings))
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
