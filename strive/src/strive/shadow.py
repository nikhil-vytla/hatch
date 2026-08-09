"""Stage-3B.1 revision shadow reads: subject-specific read parity.

Each concrete generation-native read is paired at its point of use with the
corresponding revision-derived read: cycle baseline and candidate, compare
left/right, replay baseline/candidate, promotion incumbent/target, rollback
active/parent, audit target, and status/restart reads. Generation-native
values drive all behavior; a mismatch is recorded, never substituted.

The revision-derived view (`ShadowView`) is built strictly from the mirror
journal and CAS closure, and is available only when derived state is exact:
every source generation/activation record has exactly one mirror matched by
`SourceRecordRef` (both directions), every mirror uses the supported
projector, there are no duplicates, the full derived artifact closure
(scope manifests, provenance, decision evidence, pinned descriptors, source
artifacts) exists and decodes, revisions/activations/manifests validate
semantically, and lineage traversal is bounded and cycle-free. Derived
corruption or any unexpected exception makes the view *unavailable with a
reason* — it never raises into (or hangs) an already-committed canonical
operation, and no active revision is reported while unavailable.

Every attempted check is recorded with a durable status — agreed, diverged,
unavailable, or not-applicable — in a derived shadow-coverage journal
(`ledger/<task>.shadow.jsonl`) and, when a run event stream exists, as a run
event. A divergence is additionally journaled as a `shadow-divergence`
intervention in the canonical task ledger (identical incidents are
deduplicated), never a silent fallback. `shadow_coverage` reports eligible /
checked / unavailable reads and the divergence rate; `cutover_eligibility`
demands complete parity, zero divergences, AND the declared minimum
coverage — never mere absence of divergence records.

Execution provenance: before each artifact execution the session CAS-stores
a ResolvedHarnessManifest naming the baseline (shadow-active) revision and
the executed artifact's binding, with a tamper-evident journal head
(record count + source-prefix digest), and emits its ref per subject.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Sequence

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing
from strive.codec import register
from strive.contracts import (
    Generation,
    INTERVENTION_SHADOW_DIVERGENCE,
    Intervention,
)
from strive.dualwrite import (
    ActivationMirror,
    MirrorError,
    PINNED_CODE_DESCRIPTOR,
    PROJECTOR_REF,
    ParityError,
    RevisionMirror,
    SourceSnapshot,
    capture_snapshot,
    parity_status,
)
from strive.events import EventLog, now_iso
from strive.revisions import (
    ContractViolation,
    DESCRIPTOR_REGISTRY,
    HarnessRevision,
    JournalHeadRef,
    LEVEL_TASK,
    ManifestBinding,
    MigrationProvenance,
    ResolvedHarnessManifest,
    RevisionActivation,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    content_binding,
    validate_resolved_manifest,
    validate_revision,
    validate_revision_activation,
    validate_scope_manifest,
)
from strive.store import Store

# check statuses — every attempted check gets exactly one
CHECK_AGREED = "agreed"
CHECK_DIVERGED = "diverged"
CHECK_UNAVAILABLE = "unavailable"
CHECK_NOT_APPLICABLE = "not-applicable"

# the declared minimum shadow coverage for revision-read cutover: at least
# this fraction of eligible shadowed reads must have actually been checked
# (agreed or diverged, not unavailable)
MIN_CUTOVER_COVERAGE = 0.9

_SURFACE_KEY = ("strategy-code", "solve")  # manifests searched by (kind, name)


def _rev_id(generation_id: str) -> str:
    return generation_id.replace("gen-", "rev-")


@register("shadow-check", 1)
@dataclass(frozen=True)
class ShadowCheckRecord:
    """One durable coverage record: a native read that was (or could not be)
    paired with its revision-derived read."""

    task_id: str
    subject: str  # e.g. "cycle-baseline", "rollback-parent"
    status: str  # agreed | diverged | unavailable | not-applicable
    detail: str
    at: str
    run_id: str | None = None


@dataclass(frozen=True)
class ShadowCheck:
    subject: str
    status: str
    detail: str


# -- the revision-derived view ----------------------------------------------------------


@dataclass(frozen=True)
class ShadowView:
    """The exact revision-derived read surface, or the reason it is
    unavailable. When unavailable, every accessor reports nothing — no
    active revision, no sources, no lineage."""

    available: bool
    reason: str
    revisions: dict[str, HarnessRevision] = field(default_factory=dict)
    activations: tuple[RevisionActivation, ...] = ()  # source activation order
    sources: dict[str, tuple[str, str]] = field(default_factory=dict)
    # revision_id -> (content_ref, materialized text), from the ScopeManifest

    def active_revision_id(self) -> str | None:
        if not self.available or not self.activations:
            return None
        return self.activations[-1].revision.revision_id

    def parent_of(self, revision_id: str) -> str | None:
        revision = self.revisions.get(revision_id)
        if revision is None or revision.base_parent is None:
            return None
        return revision.base_parent.revision_id

    def lineage_of(self, revision_id: str) -> tuple[str, ...]:
        """Base-parent chain — bounded and cycle-checked at view build."""
        chain: list[str] = []
        cursor: str | None = revision_id
        bound = len(self.revisions) + 1
        while cursor is not None and len(chain) < bound:
            chain.append(cursor)
            cursor = self.parent_of(cursor)
        return tuple(chain)


def _unavailable(reason: str) -> ShadowView:
    return ShadowView(available=False, reason=reason)


def build_shadow_view(store: Store) -> ShadowView:
    """Derive the revision view purely from mirrors + CAS, fail-safe.

    Any derived corruption — an unreadable mirror journal, incomplete or
    duplicated coverage, an unsupported projector, a broken artifact closure,
    a semantic contract violation, a lineage cycle, or an unexpected
    exception — yields an *unavailable* view with a reason. It never raises
    into the canonical operation that asked."""
    try:
        return _build_view(store)
    except MirrorError as exc:
        return _unavailable(f"mirror journal unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001 — derived failure is data, never a crash
        return _unavailable(
            f"unexpected derived-state failure: {type(exc).__name__}: {exc}"
        )


def _build_view(store: Store) -> ShadowView:
    entries = store.mirror.entries()
    snapshot = capture_snapshot(store)

    source_keys = {(r.ref.ordinal, r.ref.digest): r for r in snapshot.records}
    seen_keys: set[tuple[int, str]] = set()
    revisions: dict[str, HarnessRevision] = {}
    activation_mirrors: list[ActivationMirror] = []
    for entry in entries:
        if not isinstance(entry, (RevisionMirror, ActivationMirror)):
            continue
        if entry.projector_ref != PROJECTOR_REF:
            return _unavailable(
                f"mirror at source ordinal {entry.source.ordinal} uses "
                f"unsupported projector {entry.projector_ref!r}"
            )
        key = (entry.source.ordinal, entry.source.digest)
        if key in seen_keys:
            return _unavailable(
                f"duplicate mirror for source ordinal {entry.source.ordinal}"
            )
        seen_keys.add(key)
        if key not in source_keys:
            return _unavailable(
                f"mirror at source ordinal {entry.source.ordinal} matches no "
                "canonical source record (digest mismatch or foreign history)"
            )
        if isinstance(entry, RevisionMirror):
            revision_id = entry.revision.ref.revision_id
            if revision_id in revisions:
                return _unavailable(f"duplicate revision mirror {revision_id}")
            revisions[revision_id] = entry.revision
        else:
            activation_mirrors.append(entry)

    # exact coverage in the other direction: every canonical record mirrored
    for key, record in source_keys.items():
        if key not in seen_keys:
            return _unavailable(
                f"source record at ordinal {record.ref.ordinal} has no mirror "
                "— parity incomplete"
            )

    activation_mirrors.sort(key=lambda m: m.source.ordinal)
    activations = tuple(m.activation for m in activation_mirrors)

    # semantic validation of every derived record
    try:
        for revision in revisions.values():
            validate_revision(revision)
        for activation in activations:
            validate_revision_activation(activation)
    except ContractViolation as exc:
        return _unavailable(f"derived record fails validation: {exc}")

    # activations must target mirrored revisions
    for activation in activations:
        if activation.revision.revision_id not in revisions:
            return _unavailable(
                f"activation targets revision {activation.revision.revision_id} "
                "which has no mirror record"
            )

    # bounded lineage with cycle detection over base parents
    for revision_id in revisions:
        visited: set[str] = set()
        cursor: str | None = revision_id
        while cursor is not None:
            if cursor in visited:
                return _unavailable(f"lineage cycle at {cursor}")
            visited.add(cursor)
            parent_revision = revisions.get(cursor)
            if parent_revision is None:
                return _unavailable(
                    f"lineage breaks at {cursor}: no mirror record"
                )
            cursor = (
                parent_revision.base_parent.revision_id
                if parent_revision.base_parent is not None
                else None
            )

    # full artifact closure: manifest, provenance, decision evidence, pinned
    # descriptors, and the source artifact must exist and decode
    sources: dict[str, tuple[str, str]] = {}
    for revision_id, revision in revisions.items():
        try:
            manifest: ScopeManifest = codec.loads(
                store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
            )
            validate_scope_manifest(manifest)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError,
                ContractViolation) as exc:
            return _unavailable(
                f"scope manifest for {revision_id} unavailable: {exc}"
            )
        binding = next(
            (b for b in manifest.bindings if (b.kind, b.name) == _SURFACE_KEY),
            None,
        )
        if binding is None or binding.binding.content_ref is None:
            return _unavailable(
                f"scope manifest for {revision_id} carries no "
                f"{_SURFACE_KEY[0]}/{_SURFACE_KEY[1]} content binding"
            )
        if binding.binding.descriptor_ref not in DESCRIPTOR_REGISTRY:
            return _unavailable(
                f"{revision_id} pins unknown descriptor "
                f"{binding.binding.descriptor_ref!r}"
            )
        try:
            text = store.objects.get_text(binding.binding.content_ref)
        except (ObjectMissing, ObjectCorruption) as exc:
            return _unavailable(
                f"strategy artifact for {revision_id} unavailable: {exc}"
            )
        sources[revision_id] = (binding.binding.content_ref, text)
        if revision.provenance_ref is None:
            return _unavailable(f"{revision_id} lacks migration provenance")
        try:
            provenance: MigrationProvenance = codec.loads(
                store.objects.get_text(revision.provenance_ref), MigrationProvenance
            )
            if provenance.decision_ref is not None:
                from strive.contracts import Decision

                codec.loads(store.objects.get_text(provenance.decision_ref), Decision)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            return _unavailable(f"provenance closure for {revision_id}: {exc}")

    return ShadowView(
        available=True,
        reason="ok",
        revisions=revisions,
        activations=activations,
        sources=sources,
    )


# -- the derived coverage journal ---------------------------------------------------------


def _append_shadow_record(store: Store, record: ShadowCheckRecord) -> None:
    line = (codec.dumps(record) + "\n").encode("utf-8")
    with store.shadow_path.open("ab") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())


def read_shadow_records(store: Store) -> tuple[list[ShadowCheckRecord], int]:
    """All coverage records plus a count of undecodable lines (the coverage
    journal is derived telemetry: bad lines are counted, never fatal)."""
    if not store.shadow_path.exists():
        return [], 0
    records: list[ShadowCheckRecord] = []
    errors = 0
    raw = store.shadow_path.read_text()
    complete = raw.split("\n")
    if not raw.endswith("\n"):
        complete = complete[:-1]
    for line in complete:
        if not line.strip():
            continue
        try:
            decoded: object = codec.loads(line)
        except codec.SchemaError:
            errors += 1
            continue
        if isinstance(decoded, ShadowCheckRecord) and decoded.task_id == store.task_id:
            records.append(decoded)
        else:
            errors += 1
    return records, errors


# -- the session: per-use-site checks ------------------------------------------------------


class ShadowSession:
    """Pairs each native read with its revision-derived read at the point of
    use. Checks never raise into the caller; `finish` makes every attempted
    check durable and journals deduplicated divergence interventions."""

    def __init__(self, store: Store, run_id: str | None = None) -> None:
        self.store = store
        self.run_id = run_id
        self.checks: list[ShadowCheck] = []

    # views are rebuilt per check: mid-operation appends (retention,
    # activation) must be visible to later checks in the same session
    def _view(self) -> ShadowView:
        return build_shadow_view(self.store)

    def _add(self, subject: str, status: str, detail: str) -> ShadowCheck:
        check = ShadowCheck(subject=subject, status=status, detail=detail)
        self.checks.append(check)
        return check

    def note_not_applicable(self, subject: str, detail: str) -> ShadowCheck:
        return self._add(subject, CHECK_NOT_APPLICABLE, detail)

    def check_generation(
        self, subject: str, generation: Generation | None
    ) -> ShadowCheck:
        """Pair one native generation read (identity, source, parent) with
        its revision-derived counterpart."""
        if generation is None:
            return self._add(subject, CHECK_NOT_APPLICABLE, "no such native read")
        if not self.store.mirror_enabled:
            return self._add(subject, CHECK_NOT_APPLICABLE, "mirroring disabled")
        try:
            view = self._view()
            if not view.available:
                return self._add(subject, CHECK_UNAVAILABLE, view.reason)
            return self._compare_generation(subject, view, generation)
        except Exception as exc:  # noqa: BLE001 — never fail the canonical op
            return self._add(
                subject,
                CHECK_UNAVAILABLE,
                f"shadow check failed: {type(exc).__name__}: {exc}",
            )

    def _compare_generation(
        self, subject: str, view: ShadowView, generation: Generation
    ) -> ShadowCheck:
        revision_id = _rev_id(generation.generation_id)
        revision = view.revisions.get(revision_id)
        if revision is None:
            return self._add(
                subject,
                CHECK_DIVERGED,
                f"no revision mirror for {generation.generation_id}",
            )
        source_ref, source_text = view.sources[revision_id]
        if source_ref != generation.source_ref:
            return self._add(
                subject,
                CHECK_DIVERGED,
                f"source ref: generation-native {generation.source_ref[:12]}… "
                f"vs shadow {source_ref[:12]}…",
            )
        if source_text != self.store.source_of(generation):
            return self._add(
                subject,
                CHECK_DIVERGED,
                f"source text of {generation.generation_id} differs from its "
                "revision-materialized artifact",
            )
        native_parent = (
            _rev_id(generation.parent_id) if generation.parent_id is not None else None
        )
        if view.parent_of(revision_id) != native_parent:
            return self._add(
                subject,
                CHECK_DIVERGED,
                f"parent: generation-native {native_parent} vs shadow "
                f"{view.parent_of(revision_id)}",
            )
        return self._add(subject, CHECK_AGREED, revision_id)

    def check_active(
        self, subject: str, active: Generation | None
    ) -> ShadowCheck:
        """Pair the native active-state read (active id, its source, and its
        rollback target) with the revision-derived active state."""
        if active is None:
            return self._add(subject, CHECK_NOT_APPLICABLE, "no active generation")
        if not self.store.mirror_enabled:
            return self._add(subject, CHECK_NOT_APPLICABLE, "mirroring disabled")
        try:
            view = self._view()
            if not view.available:
                return self._add(subject, CHECK_UNAVAILABLE, view.reason)
            shadow_active = view.active_revision_id()
            expected = _rev_id(active.generation_id)
            if shadow_active != expected:
                return self._add(
                    subject,
                    CHECK_DIVERGED,
                    f"active: generation-native {expected} vs shadow {shadow_active}",
                )
            return self._compare_generation(subject, view, active)
        except Exception as exc:  # noqa: BLE001
            return self._add(
                subject,
                CHECK_UNAVAILABLE,
                f"shadow check failed: {type(exc).__name__}: {exc}",
            )

    def check_lineage(
        self, subject: str, chain: Sequence[Generation]
    ) -> ShadowCheck:
        """Pair the native lineage read (active → seed) with the
        revision-derived base-parent chain."""
        if not chain:
            return self._add(subject, CHECK_NOT_APPLICABLE, "no lineage")
        if not self.store.mirror_enabled:
            return self._add(subject, CHECK_NOT_APPLICABLE, "mirroring disabled")
        try:
            view = self._view()
            if not view.available:
                return self._add(subject, CHECK_UNAVAILABLE, view.reason)
            native = tuple(_rev_id(g.generation_id) for g in chain)
            shadow = view.lineage_of(native[0]) if native[0] in view.revisions else ()
            if shadow != native:
                return self._add(
                    subject,
                    CHECK_DIVERGED,
                    f"lineage: generation-native {list(native)} vs shadow "
                    f"{list(shadow)}",
                )
            return self._add(subject, CHECK_AGREED, " -> ".join(native))
        except Exception as exc:  # noqa: BLE001
            return self._add(
                subject,
                CHECK_UNAVAILABLE,
                f"shadow check failed: {type(exc).__name__}: {exc}",
            )

    # -- execution provenance ------------------------------------------------------

    def execution_manifest(
        self, subject: str, generation: Generation, events: EventLog | None
    ) -> str | None:
        """CAS-store the ResolvedHarnessManifest for one artifact execution,
        BEFORE the execution: the contribution names the baseline
        (shadow-active) revision at a tamper-evident journal head, the
        effective binding names the executed artifact. Emits the ref per
        subject; failure to build one is reported, never blocking."""
        if not self.store.mirror_enabled:
            return None
        try:
            view = self._view()
            if not view.available:
                raise ParityError(view.reason)
            baseline = view.active_revision_id()
            if baseline is None:
                raise ParityError("no active revision to pin as baseline")
            snapshot = capture_snapshot(self.store)
            scope = ScopeRef(LEVEL_TASK, self.store.task_id)
            resolved = ResolvedHarnessManifest(
                resolution_chain=(scope,),
                contributions=(
                    ScopeContribution(
                        scope=scope,
                        revision=RevisionRef(scope, baseline),
                        journal_head=_journal_head(snapshot),
                    ),
                ),
                effective=(
                    ManifestBinding(
                        _SURFACE_KEY[0],
                        _SURFACE_KEY[1],
                        content_binding(
                            _SURFACE_KEY[0],
                            generation.source_ref,
                            descriptor_ref=PINNED_CODE_DESCRIPTOR,
                        ),
                    ),
                ),
            )
            validate_resolved_manifest(resolved)
            ref = self.store.objects.put_text(codec.dumps(resolved))
        except Exception as exc:  # noqa: BLE001 — provenance capture never blocks
            if events is not None:
                events.emit(
                    "execution_manifest",
                    subject=subject,
                    generation_id=generation.generation_id,
                    resolved_manifest_ref=None,
                    reason=f"{type(exc).__name__}: {exc}",
                )
            return None
        if events is not None:
            events.emit(
                "execution_manifest",
                subject=subject,
                generation_id=generation.generation_id,
                baseline_revision=baseline,
                resolved_manifest_ref=ref,
            )
        return ref

    # -- durable recording ----------------------------------------------------------

    def finish(self, events: EventLog | None) -> tuple[ShadowCheck, ...]:
        """Make every attempted check durable (coverage journal + run event)
        and journal deduplicated divergence interventions in the canonical
        ledger. Recording failures degrade to store diagnostics."""
        checks = tuple(self.checks)
        if not self.store.mirror_enabled:
            return checks
        existing_reasons = set()
        try:
            existing_reasons = {
                i.reason
                for i in self.store.interventions()
                if i.kind == INTERVENTION_SHADOW_DIVERGENCE
            }
        except Exception:  # noqa: BLE001 — canonical read failure surfaces elsewhere
            pass
        for check in checks:
            try:
                _append_shadow_record(
                    self.store,
                    ShadowCheckRecord(
                        task_id=self.store.task_id,
                        subject=check.subject,
                        status=check.status,
                        detail=check.detail,
                        at=now_iso(),
                        run_id=self.run_id,
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                self.store._note_diagnostic(
                    f"shadow coverage record failed for {check.subject}: {exc}"
                )
            if events is not None:
                events.emit(
                    "shadow_check",
                    subject=check.subject,
                    status=check.status,
                    detail=check.detail,
                )
            if check.status != CHECK_DIVERGED:
                continue
            reason = f"{check.subject}: {check.detail}"
            if reason in existing_reasons:
                continue  # identical incident already durable — deduplicate
            existing_reasons.add(reason)
            try:
                self.store.append(
                    Intervention(
                        kind=INTERVENTION_SHADOW_DIVERGENCE,
                        reason=reason,
                        at=now_iso(),
                        run_id=self.run_id,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                self.store._note_diagnostic(
                    f"shadow divergence intervention failed: {exc}"
                )
            if events is not None:
                events.emit(
                    "shadow_divergence", subject=check.subject, detail=check.detail
                )
        return checks


def _journal_head(snapshot: SourceSnapshot) -> JournalHeadRef:
    """Tamper-evident journal head: complete-record count AND the
    digest-sequence prefix hash — altering any covered record changes it."""
    return JournalHeadRef(
        "jsonl@1", f"{snapshot.head}:{snapshot.prefix_digest(snapshot.head)}"
    )


# -- coverage + cutover eligibility ----------------------------------------------------------


@dataclass(frozen=True)
class ShadowCoverage:
    """Read-parity coverage over the shadow journal. `eligible` excludes
    not-applicable reads; `checked` counts reads actually paired (agreed or
    diverged); unavailable reads were eligible but could not be paired."""

    total: int
    eligible: int
    checked: int
    agreed: int
    diverged: int
    unavailable: int
    not_applicable: int
    journal_errors: int
    by_subject: dict[str, dict[str, int]]

    @property
    def divergence_rate(self) -> float:
        return self.diverged / self.checked if self.checked else 0.0

    @property
    def coverage_ratio(self) -> float:
        return self.checked / self.eligible if self.eligible else 0.0


def shadow_coverage(store: Store) -> ShadowCoverage:
    records, errors = read_shadow_records(store)
    by_subject: dict[str, dict[str, int]] = {}
    counts = {
        CHECK_AGREED: 0,
        CHECK_DIVERGED: 0,
        CHECK_UNAVAILABLE: 0,
        CHECK_NOT_APPLICABLE: 0,
    }
    for record in records:
        if record.status in counts:
            counts[record.status] += 1
        subject = by_subject.setdefault(record.subject, {})
        subject[record.status] = subject.get(record.status, 0) + 1
    checked = counts[CHECK_AGREED] + counts[CHECK_DIVERGED]
    eligible = checked + counts[CHECK_UNAVAILABLE]
    return ShadowCoverage(
        total=len(records),
        eligible=eligible,
        checked=checked,
        agreed=counts[CHECK_AGREED],
        diverged=counts[CHECK_DIVERGED],
        unavailable=counts[CHECK_UNAVAILABLE],
        not_applicable=counts[CHECK_NOT_APPLICABLE],
        journal_errors=errors,
        by_subject=by_subject,
    )


@dataclass(frozen=True)
class CutoverEligibility:
    """Whether revision-read cutover is defensible NOW: complete parity, zero
    divergences, and at least the declared minimum coverage of eligible
    reads actually checked — absence of divergence records is not enough."""

    eligible: bool
    parity_complete: bool
    coverage: ShadowCoverage
    min_coverage: float
    reasons: tuple[str, ...]


def cutover_eligibility(
    store: Store, min_coverage: float = MIN_CUTOVER_COVERAGE
) -> CutoverEligibility:
    reasons: list[str] = []
    try:
        parity_complete = parity_status(store).complete
        if not parity_complete:
            reasons.append("mirror parity is incomplete")
    except (MirrorError, ParityError) as exc:
        parity_complete = False
        reasons.append(f"parity cannot be verified: {exc}")
    coverage = shadow_coverage(store)
    if coverage.eligible == 0:
        reasons.append("no eligible shadowed reads have been recorded")
    if coverage.diverged > 0:
        reasons.append(f"{coverage.diverged} shadow divergence(s) recorded")
    if coverage.eligible > 0 and coverage.coverage_ratio < min_coverage:
        reasons.append(
            f"coverage {coverage.coverage_ratio:.3f} is below the declared "
            f"minimum {min_coverage:.3f}"
        )
    if coverage.journal_errors:
        reasons.append(
            f"{coverage.journal_errors} undecodable line(s) in the shadow journal"
        )
    return CutoverEligibility(
        eligible=not reasons,
        parity_complete=parity_complete,
        coverage=coverage,
        min_coverage=min_coverage,
        reasons=tuple(reasons),
    )
