"""Stage-3B.1 revision shadow reads.

Every generation-native read gets an equivalent revision-derived read,
computed from the mirror journal and CAS closure alone: active state (by
source activation order), lineage (base-parent chain), rollback target, and
the strategy source materialized from the active revision's ScopeManifest
under its pinned descriptors. Shadowed runs additionally build and CAS-store
a task-only ResolvedHarnessManifest.

Generation-native values still drive all behavior. A shadow/native
divergence is recorded as a structured durable event (a `shadow-divergence`
intervention in the task ledger plus a run event when a stream is available)
and surfaces in reports — never a silent fallback. When activation parity is
incomplete or the mirror journal is unavailable, the shadow view reports
itself unavailable with a reason and **no active revision is reported**.
"""

from __future__ import annotations

from dataclasses import dataclass

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing
from strive.contracts import INTERVENTION_SHADOW_DIVERGENCE, Intervention
from strive.dualwrite import ActivationMirror, MirrorError, RevisionMirror
from strive.events import EventLog, now_iso
from strive.revisions import (
    DESCRIPTOR_REGISTRY,
    HarnessRevision,
    JournalHeadRef,
    LEVEL_TASK,
    ManifestBinding,
    ResolvedHarnessManifest,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    validate_resolved_manifest,
)
from strive.store import Store


@dataclass(frozen=True)
class ShadowState:
    """The revision-derived view, or the precise reason it is unavailable."""

    available: bool
    reason: str
    active_revision_id: str | None = None
    lineage: tuple[str, ...] = ()
    active_source_text: str | None = None
    active_source_ref: str | None = None
    rollback_parent_id: str | None = None


@dataclass(frozen=True)
class ShadowComparison:
    shadow: ShadowState
    checked: tuple[str, ...]
    divergences: tuple[str, ...]


def _unavailable(reason: str) -> ShadowState:
    return ShadowState(available=False, reason=reason)


def compute_shadow(store: Store) -> ShadowState:
    """Derive the revision view purely from mirrors + CAS. Unavailable (with
    a reason, and no active revision) when the mirror journal is unreadable
    or activation parity is incomplete."""
    try:
        entries = store.mirror.entries()
    except MirrorError as exc:
        return _unavailable(f"mirror journal unavailable: {exc}")

    activation_mirrors = sorted(
        (e for e in entries if isinstance(e, ActivationMirror)),
        key=lambda m: m.source.ordinal,
    )
    revision_mirrors = {
        e.revision.ref.revision_id: e.revision
        for e in entries
        if isinstance(e, RevisionMirror)
    }
    source_activations = store.activations()
    if len(activation_mirrors) != len(source_activations):
        return _unavailable(
            "activation parity incomplete: "
            f"{len(activation_mirrors)} mirrors for "
            f"{len(source_activations)} source activations"
        )
    if not activation_mirrors:
        return _unavailable("no activations yet")

    active = activation_mirrors[-1].activation  # source order, by ordinal
    active_id = active.revision.revision_id
    revision = revision_mirrors.get(active_id)
    if revision is None:
        return _unavailable(f"active revision {active_id} has no mirror record")

    # lineage: base-parent chain over mirrored revisions
    lineage: list[str] = []
    cursor: HarnessRevision | None = revision
    while cursor is not None:
        lineage.append(cursor.ref.revision_id)
        if cursor.base_parent is None:
            cursor = None
        else:
            parent_id = cursor.base_parent.revision_id
            cursor = revision_mirrors.get(parent_id)
            if cursor is None:
                return _unavailable(
                    f"lineage breaks at {parent_id}: no mirror record"
                )

    # materialize the strategy source from the ScopeManifest under pinned
    # descriptors — never from generation records
    try:
        manifest: ScopeManifest = codec.loads(
            store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
        )
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        return _unavailable(f"scope manifest unavailable: {exc}")
    binding = next(
        (
            b
            for b in manifest.bindings
            if (b.kind, b.name) == ("strategy-code", "solve")
        ),
        None,
    )
    if binding is None or binding.binding.content_ref is None:
        return _unavailable("scope manifest carries no strategy-code binding")
    if binding.binding.descriptor_ref not in DESCRIPTOR_REGISTRY:
        return _unavailable(
            f"binding pins unknown descriptor {binding.binding.descriptor_ref!r}"
        )
    try:
        source_text = store.objects.get_text(binding.binding.content_ref)
    except (ObjectMissing, ObjectCorruption) as exc:
        return _unavailable(f"strategy artifact unavailable: {exc}")

    return ShadowState(
        available=True,
        reason="ok",
        active_revision_id=active_id,
        lineage=tuple(lineage),
        active_source_text=source_text,
        active_source_ref=binding.binding.content_ref,
        rollback_parent_id=(
            revision.base_parent.revision_id if revision.base_parent else None
        ),
    )


def compare_shadow(store: Store) -> ShadowComparison:
    """Compute generation-native and revision-derived values side by side.

    Compared: active id, lineage, active source ref and text, rollback
    parent, and (when a candidate was retained) the latest generation's
    candidate source. Generation-native values drive behavior regardless."""
    shadow = compute_shadow(store)
    if not shadow.available:
        return ShadowComparison(shadow=shadow, checked=(), divergences=())

    divergences: list[str] = []
    checked: list[str] = []

    active_generation = store.active_generation()
    checked.append("active_id")
    if active_generation is None:
        divergences.append("shadow has an active revision but no active generation")
        return ShadowComparison(shadow, tuple(checked), tuple(divergences))
    expected_active = active_generation.generation_id.replace("gen-", "rev-")
    if shadow.active_revision_id != expected_active:
        divergences.append(
            f"active: generation-native {expected_active} vs shadow "
            f"{shadow.active_revision_id}"
        )

    checked.append("lineage")
    native_lineage = tuple(
        g.generation_id.replace("gen-", "rev-") for g in store.lineage()
    )
    if shadow.lineage != native_lineage:
        divergences.append(
            f"lineage: generation-native {list(native_lineage)} vs shadow "
            f"{list(shadow.lineage)}"
        )

    checked.append("active_source")
    if shadow.active_source_ref != active_generation.source_ref:
        divergences.append(
            f"active source ref: generation-native "
            f"{active_generation.source_ref[:12]}… vs shadow "
            f"{(shadow.active_source_ref or '')[:12]}…"
        )
    elif shadow.active_source_text != store.source_of(active_generation):
        divergences.append("active source text differs from generation-native")

    checked.append("rollback_parent")
    native_parent = (
        active_generation.parent_id.replace("gen-", "rev-")
        if active_generation.parent_id is not None
        else None
    )
    if shadow.rollback_parent_id != native_parent:
        divergences.append(
            f"rollback parent: generation-native {native_parent} vs shadow "
            f"{shadow.rollback_parent_id}"
        )

    checked.append("candidate_source")
    generations = store.generations()
    if generations:
        latest = list(generations.values())[-1]
        mirror = next(
            (
                e.revision
                for e in store.mirror.entries()
                if isinstance(e, RevisionMirror)
                and e.revision.ref.revision_id
                == latest.generation_id.replace("gen-", "rev-")
            ),
            None,
        )
        if mirror is None:
            divergences.append(
                f"latest generation {latest.generation_id} has no revision mirror"
            )
        elif mirror.deltas[0].after.content_ref != latest.source_ref:
            divergences.append(
                f"candidate source: generation-native {latest.source_ref[:12]}… "
                f"vs shadow {(mirror.deltas[0].after.content_ref or '')[:12]}…"
            )

    return ShadowComparison(shadow, tuple(checked), tuple(divergences))


def shadow_resolved_manifest_ref(store: Store, shadow: ShadowState) -> str:
    """Build and CAS-store the task-only ResolvedHarnessManifest for a
    shadowed run: one contribution (this task's active revision at the
    current journal head) and the active manifest's effective bindings."""
    assert shadow.available and shadow.active_revision_id is not None
    scope = ScopeRef(LEVEL_TASK, store.task_id)
    revision_mirror = next(
        e.revision
        for e in store.mirror.entries()
        if isinstance(e, RevisionMirror)
        and e.revision.ref.revision_id == shadow.active_revision_id
    )
    manifest: ScopeManifest = codec.loads(
        store.objects.get_text(revision_mirror.scope_manifest_ref), ScopeManifest
    )
    effective = tuple(
        b for b in manifest.bindings if b.binding.content_ref is not None
    )
    resolved = ResolvedHarnessManifest(
        resolution_chain=(scope,),
        contributions=(
            ScopeContribution(
                scope=scope,
                revision=RevisionRef(scope, shadow.active_revision_id),
                journal_head=JournalHeadRef("jsonl@1", str(len(store.entries()))),
            ),
        ),
        effective=effective,
    )
    validate_resolved_manifest(resolved)
    return store.objects.put_text(codec.dumps(resolved))


def record_shadow_check(store: Store, events: EventLog | None) -> ShadowComparison:
    """Run the shadow comparison and make any divergence durable.

    Divergences are appended to the canonical ledger as `shadow-divergence`
    interventions (structured, durable) and emitted to the run's event stream
    when one is available. Behavior is never altered and never silently falls
    back — the divergence is loud, the generation-native answer stands."""
    if not store.mirror_enabled:
        return ShadowComparison(
            shadow=_unavailable("mirroring disabled"), checked=(), divergences=()
        )
    comparison = compare_shadow(store)
    if comparison.divergences:
        store.append(
            Intervention(
                kind=INTERVENTION_SHADOW_DIVERGENCE,
                reason="; ".join(comparison.divergences),
                at=now_iso(),
            )
        )
        if events is not None:
            events.emit(
                "shadow_divergence", divergences=list(comparison.divergences)
            )
    elif events is not None and comparison.shadow.available:
        events.emit(
            "shadow_resolved_manifest",
            active_revision=comparison.shadow.active_revision_id,
            resolved_manifest_ref=shadow_resolved_manifest_ref(
                store, comparison.shadow
            ),
        )
    return comparison
