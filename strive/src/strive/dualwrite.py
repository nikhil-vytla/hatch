"""Stage-3B dual-write: mirror generation-native history into revision records.

Crash-consistency model (this file's contract):

- **Canonical vs derived.** The task ledger holds only generation-native
  history (`generation@2`, `activation@2`, cycles, interventions) and stays
  authoritative. Revision mirrors live in a *separate* append-only mirror
  journal (`ledger/<task>.mirror.jsonl`), so corrupt or unsupported mirrors
  can never block generation-native run, activation, rollback, replay, or
  inspection.
- **Source refs, not positions.** Every source record has a deterministic
  `SourceRecordRef` (source schema, source-journal identity, complete-record
  ordinal, canonical digest); every mirror envelope carries it. Matching and
  repair go by source ref — never by list position — and revision
  active-state derivation follows *source* activation order, not mirror
  append order.
- **Plan, then apply.** Projection planning is pure: a `ProjectionPlan`
  built from a captured `SourceSnapshot` names the mirror envelopes and CAS
  payload texts/hashes without publishing anything (`cas.hash_text`).
  Application re-reads the source head under the mirror-journal writer lock
  and refuses stale plans. `parity_status` and migration discovery are
  read-only.
- **Fail-closed projector.** `generation@2 → revision@1` is pinned to the
  immutable ``PROJECTOR_REF`` and explicit historical descriptors
  (`strategy-code@1`); source history is validated before parity/backfill
  (unique ids, existing+preceding parents, activations targeting existing
  generations, task identity, supported schemas/surfaces, injective id
  mapping) with structured errors, never KeyError or silent fallback.
- **Operation-specific evidence.** A legacy `activation@2` mirror carries
  ``decision_ref=None``; the generation's original decision lives only in
  its `MigrationProvenance`.
- **Explicit partial-commit condition.** If a source record commits but its
  live mirror publication fails, the operation reports
  ``source-committed-parity-incomplete`` (store diagnostic + detectable by
  parity) instead of pretending the whole operation is uncommitted.
"""

from __future__ import annotations

import dataclasses
import fcntl
import hashlib
import json
import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol, Sequence

from strive import codec
from strive.cas import ObjectStore, hash_text
from strive.codec import register
from strive.contracts import Activation, Generation
from strive.revisions import (
    LEVEL_TASK,
    ContractViolation,
    HarnessRevision,
    ManifestBinding,
    MigrationProvenance,
    RevisionActivation,
    ScopeManifest,
    ScopeRef,
    content_binding,
    revision_activation_from_activation,
    revision_from_generation,
    validate_revision,
    validate_revision_activation,
    validate_scope_manifest,
)

PROJECTOR_REF = "generation-to-revision@1"  # immutable; new logic = new ref
PINNED_CODE_DESCRIPTOR = "strategy-code@1"  # explicit historical descriptor
SURFACE_NAME = "solve"
SOURCE_GENERATION = "generation@2"
SOURCE_ACTIVATION = "activation@2"
CONDITION_PARITY_INCOMPLETE = "source-committed-parity-incomplete"


class MirrorError(Exception):
    """Mirror-journal failure — never blocks generation-native operations."""


class ParityError(Exception):
    """Structured parity/repair failure (ambiguity, unsupported, stale)."""


# -- wire records (mirror journal only) -------------------------------------------------


@register("source-ref", 1)
@dataclass(frozen=True)
class SourceRecordRef:
    """Deterministic identity of one complete record in a source journal."""

    source_schema: str  # generation@2 | activation@2
    journal: str  # e.g. "task:sum-integers"
    ordinal: int  # index among the journal's complete records
    digest: str  # sha256 of the record's canonical encoding


@register("revision-mirror", 1)
@dataclass(frozen=True)
class RevisionMirror:
    projector_ref: str
    source: SourceRecordRef
    revision: HarnessRevision


@register("activation-mirror", 1)
@dataclass(frozen=True)
class ActivationMirror:
    projector_ref: str
    source: SourceRecordRef
    activation: RevisionActivation


@register("migration-intent", 2)
@dataclass(frozen=True)
class MigrationIntent:
    """Durable operation intent, pinning the exact canonical source prefix:
    record count (`source_head`), the hash of the canonical per-record digest
    sequence over that prefix (`prefix_digest`), and the journal-bytes hash
    at intent time (`source_hash`, audit only). Resume verifies the current
    prefix matches exactly — appended records are allowed, altered prefix
    records are not."""

    op_id: str
    migration_id: str
    source_head: int  # complete-record count at intent time
    source_hash: str  # sha256 of the source journal bytes at intent time
    prefix_digest: str  # hash over the canonical digest sequence of the prefix
    projector_ref: str
    started_at: str


@register("migration-progress", 1)
@dataclass(frozen=True)
class MigrationProgress:
    op_id: str
    mirrored_through_ordinal: int
    at: str


@register("migration-completed", 1)
@dataclass(frozen=True)
class MigrationCompleted:
    op_id: str
    at: str
    detail: str


MirrorEntry = (
    RevisionMirror | ActivationMirror | MigrationIntent | MigrationProgress | MigrationCompleted
)

_MIRROR_KINDS = frozenset(
    {
        "revision-mirror",
        "activation-mirror",
        "migration-intent",
        "migration-progress",
        "migration-completed",
    }
)


class MirrorJournal:
    """Append-only derived journal, isolated from the authoritative ledger."""

    def __init__(self, path: Path, task_id: str) -> None:
        self.path = path
        self.task_id = task_id
        self._lock_path = path.with_suffix(".lock")
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def writer_lock(self) -> Iterator[None]:
        with self._lock_path.open("a") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def append(self, entry: MirrorEntry) -> None:
        line = (codec.dumps(entry) + "\n").encode("utf-8")
        with self.path.open("ab") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())

    def entries(self) -> list[MirrorEntry]:
        return self.entries_with_bytes()[1]

    def entries_with_bytes(self) -> tuple[bytes, list[MirrorEntry]]:
        """One read: the exact mirror-journal bytes AND the entries parsed
        from those bytes (the read boundary's coherent capture)."""
        if not self.path.exists():
            return b"", []
        try:
            raw_bytes = self.path.read_bytes()
            raw = raw_bytes.decode("utf-8")
        except OSError as exc:
            raise MirrorError(f"{self.path}: unreadable mirror journal: {exc}") from None
        lines = raw.split("\n")
        complete = lines[:-1] if lines and not raw.endswith("\n") else lines
        entries: list[MirrorEntry] = []
        for line_no, line in enumerate(complete, start=1):
            if not line.strip():
                continue
            try:
                decoded: object = codec.loads(line)
            except codec.SchemaError as exc:
                schema = ""
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        schema = str(parsed.get("schema", ""))
                except ValueError:
                    pass
                # a *known mirror kind at an unsupported version* is a journal
                # written by a different build (e.g. the stage-3B
                # migration-intent@1 format) — name the exact recovery path
                if schema.split("@", 1)[0] in _MIRROR_KINDS:
                    raise MirrorError(
                        f"{self.path}:{line_no}: mirror schema {schema!r} is not "
                        "supported by this build (a stage-3B-era or foreign "
                        "journal format); run `strive parity --rebuild` to "
                        "quarantine this journal byte-for-byte and rebuild it "
                        "from canonical history"
                    ) from None
                raise MirrorError(f"{self.path}:{line_no}: {exc}") from None
            if not isinstance(
                decoded,
                (RevisionMirror, ActivationMirror, MigrationIntent,
                 MigrationProgress, MigrationCompleted),
            ):
                raise MirrorError(
                    f"{self.path}:{line_no}: {type(decoded).__name__} is not a "
                    "mirror-journal entry kind"
                )
            scope: ScopeRef | None = None
            if isinstance(decoded, RevisionMirror):
                scope = decoded.revision.ref.scope
            elif isinstance(decoded, ActivationMirror):
                scope = decoded.activation.revision.scope
            if scope is not None and (
                scope.level != LEVEL_TASK or scope.name != self.task_id
            ):
                raise MirrorError(
                    f"{self.path}:{line_no}: mirror belongs to another task — "
                    "task-isolation violation in the mirror journal"
                )
            entries.append(decoded)
        return raw_bytes, entries


# -- source snapshots --------------------------------------------------------------------


@dataclass(frozen=True)
class SourceRecord:
    ref: SourceRecordRef
    generation: Generation | None = None
    activation: Activation | None = None


@dataclass(frozen=True)
class SourceSnapshot:
    """A captured, validated view of the authoritative task ledger."""

    task_id: str
    head: int  # complete-record count
    journal_hash: str
    entry_digests: tuple[str, ...]  # canonical digest of EVERY complete entry
    records: tuple[SourceRecord, ...]  # generations + activations, source order

    def prefix_digest(self, head: int) -> str:
        """Hash of the canonical digest sequence of the first `head` records —
        the exact source-prefix identity an intent pins. Appending records
        never changes it; altering any prefix record always does."""
        h = hashlib.sha256()
        for digest in self.entry_digests[:head]:
            h.update(bytes.fromhex(digest))
        return h.hexdigest()

    def generations(self) -> dict[str, Generation]:
        return {
            r.generation.generation_id: r.generation
            for r in self.records
            if r.generation is not None
        }


def snapshot_of(
    task_id: str, entries: Sequence[object], raw_bytes: bytes
) -> SourceSnapshot:
    """Pure snapshot construction from ONE capture of the source journal:
    the entries and the bytes they were parsed from. Callers that already
    hold a coherent capture (the read boundary) build from it directly, so
    the snapshot can never mix reads."""
    journal = f"task:{task_id}"
    records: list[SourceRecord] = []
    entry_digests: list[str] = []
    for ordinal, entry in enumerate(entries):
        digest = hashlib.sha256(codec.dumps(entry).encode("utf-8")).hexdigest()
        entry_digests.append(digest)
        if isinstance(entry, Generation):
            records.append(
                SourceRecord(
                    SourceRecordRef(SOURCE_GENERATION, journal, ordinal, digest),
                    generation=entry,
                )
            )
        elif isinstance(entry, Activation):
            records.append(
                SourceRecord(
                    SourceRecordRef(SOURCE_ACTIVATION, journal, ordinal, digest),
                    activation=entry,
                )
            )
    return SourceSnapshot(
        task_id=task_id,
        head=len(entries),
        journal_hash=hashlib.sha256(raw_bytes).hexdigest(),
        entry_digests=tuple(entry_digests),
        records=tuple(records),
    )


def capture_snapshot(store: "StoreLike") -> SourceSnapshot:
    """Read-only capture of the source ledger with per-record refs — one
    read serves both the bytes hash and the parsed entries."""
    raw_bytes, entries = store.entries_with_bytes()
    return snapshot_of(store.task_id, entries, raw_bytes)


def validate_source_history(snapshot: SourceSnapshot) -> None:
    """Fail-closed source validation before any parity/backfill work."""
    seen: dict[str, int] = {}
    mapped: set[str] = set()
    for record in snapshot.records:
        generation = record.generation
        if generation is None:
            continue
        if generation.task_id != snapshot.task_id:
            raise ParityError(
                f"generation {generation.generation_id} belongs to task "
                f"{generation.task_id!r}, not {snapshot.task_id!r}"
            )
        if generation.surface != "strategy-code":
            raise ParityError(
                f"generation {generation.generation_id} has surface "
                f"{generation.surface!r}; projector {PROJECTOR_REF} supports "
                "'strategy-code' only"
            )
        if generation.generation_id in seen:
            raise ParityError(f"duplicate generation id {generation.generation_id}")
        if generation.parent_id is not None and generation.parent_id not in seen:
            raise ParityError(
                f"generation {generation.generation_id} names parent "
                f"{generation.parent_id} which does not precede it (missing or "
                "out of order); lineage must be acyclic and parent-first"
            )
        seen[generation.generation_id] = record.ref.ordinal
        mirror_id = generation.generation_id.replace("gen-", "rev-")
        if mirror_id in mapped:
            raise ParityError(
                f"source-to-mirror id mapping is not injective at {mirror_id}"
            )
        mapped.add(mirror_id)
    for record in snapshot.records:
        activation = record.activation
        if activation is None:
            continue
        if activation.task_id != snapshot.task_id:
            raise ParityError(
                f"activation of {activation.generation_id} belongs to task "
                f"{activation.task_id!r}, not {snapshot.task_id!r}"
            )
        if activation.generation_id not in seen:
            raise ParityError(
                f"activation targets unknown generation {activation.generation_id}"
            )


# -- pure projection ----------------------------------------------------------------------


def canonical_scope_manifest(task_id: str, source_ref: str) -> ScopeManifest:
    manifest = ScopeManifest(
        scope=ScopeRef(LEVEL_TASK, task_id),
        bindings=(
            ManifestBinding(
                "strategy-code",
                SURFACE_NAME,
                content_binding(
                    "strategy-code", source_ref, descriptor_ref=PINNED_CODE_DESCRIPTOR
                ),
            ),
        ),
    )
    validate_scope_manifest(manifest)
    return manifest


@dataclass(frozen=True)
class ProjectionPlan:
    """Pure output of projection: nothing here has been published."""

    task_id: str
    source_head: int
    source_hash: str
    projector_ref: str
    payloads: tuple[tuple[str, str], ...]  # (text, expected CAS ref)
    mirrors: tuple[RevisionMirror | ActivationMirror, ...]


def _project_generation(
    generation: Generation,
    parent: Generation | None,
    source: SourceRecordRef,
) -> tuple[RevisionMirror, list[tuple[str, str]]]:
    payloads: list[tuple[str, str]] = []
    decision_ref: str | None = None
    if generation.decision is not None:
        decision_text = codec.dumps(generation.decision)
        decision_ref = hash_text(decision_text)
        payloads.append((decision_text, decision_ref))
    manifest_text = codec.dumps(
        canonical_scope_manifest(generation.task_id, generation.source_ref)
    )
    manifest_ref = hash_text(manifest_text)
    payloads.append((manifest_text, manifest_ref))
    provenance = MigrationProvenance(
        source=SOURCE_GENERATION,
        generation_id=generation.generation_id,
        task_id=generation.task_id,
        task_fingerprint=generation.task_fingerprint,
        origin=generation.origin,
        surface=generation.surface,
        weakness_id=generation.weakness_id,
        decision_ref=decision_ref,
    )
    provenance_text = codec.dumps(provenance)
    provenance_ref = hash_text(provenance_text)
    payloads.append((provenance_text, provenance_ref))
    scope = ScopeRef(LEVEL_TASK, generation.task_id)
    revision = dataclasses.replace(
        revision_from_generation(generation, parent, scope, manifest_ref),
        provenance_ref=provenance_ref,
    )
    validate_revision(revision)
    return RevisionMirror(PROJECTOR_REF, source, revision), payloads


def _project_activation(
    activation: Activation, source: SourceRecordRef
) -> ActivationMirror:
    # operation-specific evidence: legacy activation@2 carries None
    mirror = revision_activation_from_activation(activation, decision_ref=None)
    validate_revision_activation(mirror)
    return ActivationMirror(PROJECTOR_REF, source, mirror)


def plan_projection(
    snapshot: SourceSnapshot, existing: list[MirrorEntry]
) -> ProjectionPlan:
    """Pure planning: project every source record lacking a mirror.

    Fails closed BEFORE anything could be published: mismatched, duplicated,
    foreign, or unsupported-projector mirrors in the existing journal raise a
    structured ParityError. Payloads are planned for every generation (not
    only missing mirrors), so repair can republish missing derived CAS
    objects for mirrors that already exist."""
    validate_source_history(snapshot)
    issues = _check_existing_mirrors(snapshot, existing)
    if issues:
        raise ParityError(
            "existing mirror journal is ambiguous; refusing to plan: "
            + "; ".join(issues)
        )
    mirrored = {
        (m.source.ordinal, m.source.digest)
        for m in existing
        if isinstance(m, (RevisionMirror, ActivationMirror))
    }
    generations = snapshot.generations()
    payloads: list[tuple[str, str]] = []
    mirrors: list[RevisionMirror | ActivationMirror] = []
    for record in snapshot.records:
        key = (record.ref.ordinal, record.ref.digest)
        if record.generation is not None:
            parent = (
                generations[record.generation.parent_id]
                if record.generation.parent_id is not None
                else None
            )
            mirror, mirror_payloads = _project_generation(
                record.generation, parent, record.ref
            )
            payloads.extend(mirror_payloads)  # closure: planned for ALL
            if key not in mirrored:
                mirrors.append(mirror)
        elif record.activation is not None and key not in mirrored:
            mirrors.append(_project_activation(record.activation, record.ref))
    unique_payloads = tuple(dict(payloads).items())
    return ProjectionPlan(
        task_id=snapshot.task_id,
        source_head=snapshot.head,
        source_hash=snapshot.journal_hash,
        projector_ref=PROJECTOR_REF,
        payloads=unique_payloads,
        mirrors=tuple(mirrors),
    )


def _check_existing_mirrors(
    snapshot: SourceSnapshot, existing: list[MirrorEntry]
) -> list[str]:
    """Structured verification of journaled mirrors against the source
    snapshot. Returns mismatch descriptions (used by parity); raises nothing
    except when journaled data is undecodable (handled upstream)."""
    issues: list[str] = []
    by_key: dict[tuple[int, str], RevisionMirror | ActivationMirror] = {}
    source_keys = {(r.ref.ordinal, r.ref.digest): r for r in snapshot.records}
    generations = snapshot.generations()
    for entry in existing:
        if not isinstance(entry, (RevisionMirror, ActivationMirror)):
            continue
        key = (entry.source.ordinal, entry.source.digest)
        if entry.projector_ref != PROJECTOR_REF:
            issues.append(
                f"mirror at source ordinal {entry.source.ordinal} uses "
                f"unsupported projector {entry.projector_ref!r}"
            )
            continue
        if key in by_key:
            issues.append(
                f"duplicate mirror for source ordinal {entry.source.ordinal}"
            )
            continue
        by_key[key] = entry
        record = source_keys.get(key)
        if record is None:
            issues.append(
                f"mirror at source ordinal {entry.source.ordinal} has no "
                "matching source record (digest mismatch or foreign history)"
            )
            continue
        if isinstance(entry, RevisionMirror):
            if record.generation is None:
                issues.append(
                    f"mirror kind mismatch at source ordinal {entry.source.ordinal}"
                )
                continue
            parent = (
                generations[record.generation.parent_id]
                if record.generation.parent_id is not None
                else None
            )
            expected, _ = _project_generation(record.generation, parent, record.ref)
            if expected != entry:
                issues.append(
                    f"revision mirror for {record.generation.generation_id} does "
                    "not match its recomputed projection"
                )
        else:
            if record.activation is None:
                issues.append(
                    f"mirror kind mismatch at source ordinal {entry.source.ordinal}"
                )
                continue
            if _project_activation(record.activation, record.ref) != entry:
                issues.append(
                    f"activation mirror at source ordinal {entry.source.ordinal} "
                    "does not match its recomputed projection"
                )
    return issues


def apply_projection(
    store: "StoreLike", journal: MirrorJournal, plan: ProjectionPlan
) -> None:
    """Publish a plan under the mirror-journal writer lock (see the unlocked
    core for the staleness contract)."""
    with journal.writer_lock():
        _apply_projection_unlocked(store, journal, plan)


def _apply_projection_unlocked(
    store: "StoreLike", journal: MirrorJournal, plan: ProjectionPlan
) -> None:
    """Publish a plan; caller holds the mirror writer lock.

    Re-reads the source head first and refuses stale plans: the plan was
    built from a snapshot, and applying it against a moved source would
    publish mirrors for history the plan never saw.
    """
    current = capture_snapshot(store)
    if (current.head, current.journal_hash) != (plan.source_head, plan.source_hash):
        raise ParityError(
            f"stale projection plan: planned at head {plan.source_head} "
            f"({plan.source_hash[:12]}…) but the source is now at head "
            f"{current.head} ({current.journal_hash[:12]}…); re-plan"
        )
    for text, expected_ref in plan.payloads:
        actual = store.objects.put_text(text)
        if actual != expected_ref:
            raise ParityError(
                f"CAS publication produced {actual[:12]}…, plan expected "
                f"{expected_ref[:12]}…"
            )
    existing = {
        (m.source.ordinal, m.source.digest)
        for m in journal.entries()
        if isinstance(m, (RevisionMirror, ActivationMirror))
    }
    for mirror in plan.mirrors:
        if (mirror.source.ordinal, mirror.source.digest) not in existing:
            journal.append(mirror)


# -- parity (read-only) --------------------------------------------------------------------


@dataclass(frozen=True)
class ParityReport:
    generations: int
    activations: int
    revision_mirrors: int
    activation_mirrors: int
    missing_source_ordinals: tuple[int, ...]
    mismatched: tuple[str, ...]
    missing_objects: tuple[str, ...]  # derived CAS objects; repairable from a plan
    closure_issues: tuple[str, ...]  # corrupt/mismatched objects; fail closed

    @property
    def complete(self) -> bool:
        return not (
            self.missing_source_ordinals
            or self.mismatched
            or self.missing_objects
            or self.closure_issues
        )


def _verify_closure(
    store: "StoreLike", snapshot: SourceSnapshot, existing: list[MirrorEntry]
) -> tuple[list[str], list[str]]:
    """Full artifact-closure verification (read-only).

    For every journaled revision mirror: the scope manifest, migration
    provenance, decision evidence, pinned descriptors, and the source
    strategy artifact must exist in CAS, hash correctly, decode to the
    expected schema, and agree with the source record. Missing derived
    objects are repairable (a plan carries their payloads); corrupt or
    disagreeing objects fail closed and are never silently overwritten
    (content-addressed writes cannot replace an existing corrupt file)."""
    from strive.cas import ObjectCorruption, ObjectMissing
    from strive.contracts import Decision
    from strive.revisions import DESCRIPTOR_REGISTRY, ScopeManifest

    missing: list[str] = []
    issues: list[str] = []
    generations = snapshot.generations()

    def read(ref: str, what: str) -> str | None:
        try:
            return store.objects.get_text(ref)
        except ObjectMissing:
            missing.append(f"{what} {ref}")
            return None
        except ObjectCorruption as exc:
            issues.append(f"{what} {ref} is corrupt: {exc}")
            return None

    for entry in existing:
        if not isinstance(entry, RevisionMirror):
            continue
        revision = entry.revision
        generation_id = revision.ref.revision_id.replace("rev-", "gen-")
        generation = generations.get(generation_id)
        if generation is None:
            continue  # already reported as a mismatch by _check_existing_mirrors
        # scope manifest: exists, decodes, agrees with the source record
        manifest_text = read(revision.scope_manifest_ref, "scope manifest")
        if manifest_text is not None:
            try:
                manifest = codec.loads(manifest_text, ScopeManifest)
            except codec.SchemaError as exc:
                issues.append(f"scope manifest {revision.scope_manifest_ref}: {exc}")
            else:
                expected_manifest = canonical_scope_manifest(
                    generation.task_id, generation.source_ref
                )
                if manifest != expected_manifest:
                    issues.append(
                        f"scope manifest for {revision.ref.revision_id} disagrees "
                        "with its source generation"
                    )
        # provenance: exists, decodes, agrees field-by-field
        if revision.provenance_ref is None:
            issues.append(f"revision {revision.ref.revision_id} lacks provenance")
        else:
            provenance_text = read(revision.provenance_ref, "provenance")
            if provenance_text is not None:
                try:
                    provenance = codec.loads(provenance_text, MigrationProvenance)
                except codec.SchemaError as exc:
                    issues.append(f"provenance {revision.provenance_ref}: {exc}")
                else:
                    if (
                        provenance.generation_id != generation.generation_id
                        or provenance.task_fingerprint != generation.task_fingerprint
                        or provenance.origin != generation.origin
                        or provenance.surface != generation.surface
                        or provenance.weakness_id != generation.weakness_id
                    ):
                        issues.append(
                            f"provenance for {revision.ref.revision_id} disagrees "
                            "with its source generation"
                        )
                    # decision evidence closure
                    if (generation.decision is None) != (provenance.decision_ref is None):
                        issues.append(
                            f"provenance decision_ref presence for "
                            f"{revision.ref.revision_id} disagrees with the source"
                        )
                    elif provenance.decision_ref is not None:
                        decision_text = read(provenance.decision_ref, "decision")
                        if decision_text is not None:
                            try:
                                decision = codec.loads(decision_text, Decision)
                            except codec.SchemaError as exc:
                                issues.append(
                                    f"decision {provenance.decision_ref}: {exc}"
                                )
                            else:
                                if decision != generation.decision:
                                    issues.append(
                                        f"decision evidence for "
                                        f"{revision.ref.revision_id} disagrees with "
                                        "the source generation's decision"
                                    )
        # pinned descriptors: every content binding's descriptor is registered
        for delta in revision.deltas:
            for binding in (delta.before, delta.after):
                if (
                    binding.descriptor_ref is not None
                    and binding.descriptor_ref not in DESCRIPTOR_REGISTRY
                ):
                    issues.append(
                        f"revision {revision.ref.revision_id} pins unknown "
                        f"descriptor {binding.descriptor_ref!r}"
                    )
        # the source strategy artifact itself (not derivable; fail closed)
        source_text = read(generation.source_ref, "source artifact")
        if source_text is None and f"source artifact {generation.source_ref}" in missing:
            # a missing SOURCE artifact is not repairable from projection
            missing.remove(f"source artifact {generation.source_ref}")
            issues.append(
                f"source artifact {generation.source_ref} for "
                f"{generation.generation_id} is missing — canonical data loss, "
                "not repairable from projection"
            )
    return missing, issues


def parity_status(
    store: "StoreLike", journal: MirrorJournal | None = None
) -> ParityReport:
    """Read-only comparison of source history, mirror journal, and the full
    derived artifact closure — publishes nothing (expected CAS refs come from
    `hash_text`; closure reads verify existing objects only)."""
    snapshot = capture_snapshot(store)
    validate_source_history(snapshot)
    mirror_journal = journal if journal is not None else store.mirror
    existing = mirror_journal.entries()  # MirrorError on corruption, contained here
    return _parity_over(store, snapshot, existing)


def _parity_over(
    store: "StoreLike", snapshot: SourceSnapshot, existing: list[MirrorEntry]
) -> ParityReport:
    """Parity computed over an explicit snapshot + mirror-entry view — the
    common core of full parity and an intent's prefix-scoped parity."""
    issues = _check_existing_mirrors(snapshot, existing)
    missing_objects, closure_issues = _verify_closure(store, snapshot, existing)
    mirrored = {
        (m.source.ordinal, m.source.digest)
        for m in existing
        if isinstance(m, (RevisionMirror, ActivationMirror))
    }
    missing = tuple(
        r.ref.ordinal
        for r in snapshot.records
        if (r.ref.ordinal, r.ref.digest) not in mirrored
    )
    return ParityReport(
        generations=sum(1 for r in snapshot.records if r.generation is not None),
        activations=sum(1 for r in snapshot.records if r.activation is not None),
        revision_mirrors=sum(
            1 for m in existing if isinstance(m, RevisionMirror)
        ),
        activation_mirrors=sum(
            1 for m in existing if isinstance(m, ActivationMirror)
        ),
        missing_source_ordinals=missing,
        mismatched=tuple(issues),
        missing_objects=tuple(missing_objects),
        closure_issues=tuple(closure_issues),
    )


def active_revision_id(store: "StoreLike") -> str | None:
    """Derived active revision: follows SOURCE activation order (by source
    ordinal), never mirror append order."""
    mirrors = [
        m for m in store.mirror.entries() if isinstance(m, ActivationMirror)
    ]
    if not mirrors:
        return None
    latest = max(mirrors, key=lambda m: m.source.ordinal)
    return latest.activation.revision.revision_id


# -- durable operations (intent -> progress -> completed) ------------------------------------


def _entries_within_prefix(
    entries: list[MirrorEntry], source_head: int
) -> list[MirrorEntry]:
    """The mirror-journal view scoped to an intent's declared source prefix:
    mirrors for source ordinals at or past the head are excluded (they belong
    to a later operation); operation-state records pass through."""
    return [
        e
        for e in entries
        if not isinstance(e, (RevisionMirror, ActivationMirror))
        or e.source.ordinal < source_head
    ]


def open_intents(journal: MirrorJournal) -> list[MigrationIntent]:
    """All unfinished operations (intents without completions), journal order."""
    intents: dict[str, MigrationIntent] = {}
    completed: set[str] = set()
    for entry in journal.entries():
        if isinstance(entry, MigrationIntent):
            intents[entry.op_id] = entry
        elif isinstance(entry, MigrationCompleted):
            completed.add(entry.op_id)
    return [i for i in intents.values() if i.op_id not in completed]


def open_intent(journal: MirrorJournal) -> MigrationIntent | None:
    """The single unfinished operation, if any. More than one unfinished
    intent means concurrent writers or a mangled journal: fail closed."""
    open_ops = open_intents(journal)
    if len(open_ops) > 1:
        raise ParityError(
            f"{len(open_ops)} unfinished migration intents "
            f"({', '.join(i.op_id for i in open_ops)}); refusing to resume an "
            "ambiguous operation state"
        )
    return open_ops[0] if open_ops else None


def run_backfill_operation(store: "StoreLike", migration_id: str) -> ParityReport:
    """The durable backfill/repair state machine.

    One operation-level mirror lock is held across intent selection/creation,
    planning, application, and state transitions — two concurrent operations
    cannot both create intents or interleave state. Resume-safe at every
    crash point: the single open intent is reused with its ORIGINAL source
    head/hash/prefix preserved; resume verifies the current source prefix
    matches the intent exactly (appended records allowed, altered prefix
    refused) and that the intent's migration_id and projector_ref match what
    is being resumed.

    Completion is **prefix-scoped**: the operation validates, repairs, and
    completes only the intent's declared source prefix. Source records — and
    their live-dual-write mirrors — appended after the intent was created are
    permitted and left untouched; they are a subsequent operation's work.
    Mirrors are idempotent by source ref; completion is journaled only after
    parity validation (including artifact closure) over the intent's prefix.
    """
    from strive.events import now_iso
    import uuid

    journal = store.mirror
    with journal.writer_lock():
        full = capture_snapshot(store)
        validate_source_history(full)
        intent = open_intent(journal)  # raises on multiple unfinished intents
        if intent is not None:
            # validate what we are resuming
            if intent.migration_id != migration_id:
                raise ParityError(
                    f"open intent {intent.op_id} belongs to migration "
                    f"{intent.migration_id!r}; refusing to resume it as "
                    f"{migration_id!r}"
                )
            if intent.projector_ref != PROJECTOR_REF:
                raise ParityError(
                    f"open intent {intent.op_id} was planned with projector "
                    f"{intent.projector_ref!r}; this build projects with "
                    f"{PROJECTOR_REF!r} — refusing to resume"
                )
            if full.head < intent.source_head:
                raise ParityError(
                    f"source journal shrank below intent head {intent.source_head}; "
                    "append-only history was violated — refusing"
                )
            if full.prefix_digest(intent.source_head) != intent.prefix_digest:
                raise ParityError(
                    "the canonical source prefix pinned by intent "
                    f"{intent.op_id} has been altered; appended records are "
                    "allowed but prefix records must match exactly — refusing"
                )
        else:
            intent = MigrationIntent(
                op_id=f"op-{uuid.uuid4().hex[:8]}",
                migration_id=migration_id,
                source_head=full.head,
                source_hash=full.journal_hash,
                prefix_digest=full.prefix_digest(full.head),
                projector_ref=PROJECTOR_REF,
                started_at=now_iso(),
            )
            journal.append(intent)  # durable BEFORE any work

        # the operation targets the intent's declared history; newer source
        # records are a future operation's work
        snapshot = SourceSnapshot(
            task_id=full.task_id,
            head=intent.source_head,
            journal_hash=intent.source_hash,
            entry_digests=full.entry_digests[: intent.source_head],
            records=tuple(
                r for r in full.records if r.ref.ordinal < intent.source_head
            ),
        )
        # mirrors for records appended AFTER the intent (live dual-write
        # keeps publishing while an intent is open) are out of this
        # operation's scope: excluded from planning and validation, never
        # treated as foreign, never touched
        scoped_entries = _entries_within_prefix(journal.entries(), intent.source_head)
        plan = plan_projection(snapshot, scoped_entries)  # fails closed
        # rebase the staleness check onto the current head: the source may
        # legitimately have advanced past the intent
        current_plan = dataclasses.replace(
            plan, source_head=full.head, source_hash=full.journal_hash
        )
        if plan.mirrors or plan.payloads:
            _apply_projection_unlocked(store, journal, current_plan)
        if plan.mirrors:
            journal.append(
                MigrationProgress(
                    op_id=intent.op_id,
                    mirrored_through_ordinal=max(
                        m.source.ordinal for m in plan.mirrors
                    ),
                    at=now_iso(),
                )
            )

        # validate parity (incl. artifact closure) over the intent's prefix
        report = _parity_over(
            store, snapshot, _entries_within_prefix(journal.entries(), intent.source_head)
        )
        if not report.complete:
            raise ParityError(
                "backfill did not reach parity over the intent's prefix; "
                f"mismatched={list(report.mismatched)} "
                f"missing={list(report.missing_source_ordinals)} "
                f"missing_objects={list(report.missing_objects)} "
                f"closure_issues={list(report.closure_issues)}"
            )
        journal.append(
            MigrationCompleted(
                op_id=intent.op_id,
                at=now_iso(),
                detail=(
                    f"{migration_id}: mirrored through source head "
                    f"{intent.source_head} (prefix {intent.prefix_digest[:12]}…, "
                    f"source sha256 {intent.source_hash[:12]}…)"
                ),
            )
        )
    _note_repair_epoch(store, f"{migration_id} completed ({intent.op_id})")
    return parity_status(store)


def _note_repair_epoch(store: "StoreLike", detail: str) -> None:
    """Repair changed derived history: the reader control journal MUST
    atomically disable any active canary (open the breaker) and reset the
    burn-in epoch. This is fail-closed, not best-effort — a repair whose
    control update cannot be recorded raises, because completing it silently
    would leave a canary running on invalidated evidence."""
    from strive.reader import repair_control_update

    repair_control_update(store.mirror.path, store.task_id, detail)


# -- mirror-journal recovery -----------------------------------------------------------------


@dataclass(frozen=True)
class RebuildReport:
    quarantine_path: str | None
    prior_mirror_sha256: str
    report: ParityReport


def rebuild_mirror(store: "StoreLike") -> RebuildReport:
    """Recover a corrupt or ambiguous mirror journal from canonical history.

    The prior journal is preserved byte-for-byte at a quarantine path; a
    fresh journal (with its own intent → mirrors → completed records naming
    the source prefix, outcome, and prior-mirror hash) is built purely from
    the canonical ledger and CAS closure, fully validated, and atomically
    installed. The canonical task ledger is never touched.
    """
    from strive.events import now_iso
    import uuid

    journal = store.mirror
    with journal.writer_lock():
        prior_bytes = journal.path.read_bytes() if journal.path.exists() else b""
        prior_sha = hashlib.sha256(prior_bytes).hexdigest()
        quarantine_path: str | None = None
        if prior_bytes:
            quarantine = journal.path.with_name(
                journal.path.name + f".quarantine-{now_iso().replace(':', '')}"
            )
            quarantine.write_bytes(prior_bytes)  # byte-for-byte preservation
            quarantine_path = str(quarantine)

        snapshot = capture_snapshot(store)
        validate_source_history(snapshot)
        plan = plan_projection(snapshot, [])  # fresh: no existing mirrors

        temporary = MirrorJournal(
            journal.path.with_name(journal.path.name + ".rebuilding"),
            journal.task_id,
        )
        if temporary.path.exists():
            temporary.path.unlink()
        intent = MigrationIntent(
            op_id=f"op-{uuid.uuid4().hex[:8]}",
            migration_id="mirror-rebuild",
            source_head=snapshot.head,
            source_hash=snapshot.journal_hash,
            prefix_digest=snapshot.prefix_digest(snapshot.head),
            projector_ref=PROJECTOR_REF,
            started_at=now_iso(),
        )
        temporary.append(intent)
        for text, expected_ref in plan.payloads:
            actual = store.objects.put_text(text)
            if actual != expected_ref:
                raise ParityError(
                    f"CAS publication produced {actual[:12]}…, plan expected "
                    f"{expected_ref[:12]}…"
                )
        for mirror in plan.mirrors:
            temporary.append(mirror)
        temporary.append(
            MigrationCompleted(
                op_id=intent.op_id,
                at=now_iso(),
                detail=(
                    f"mirror-rebuild from canonical history (head "
                    f"{snapshot.head}, prefix {intent.prefix_digest[:12]}…); "
                    f"prior mirror sha256 {prior_sha}"
                    + (f"; quarantined at {quarantine_path}" if quarantine_path else "")
                ),
            )
        )

        # full validation BEFORE installation — including artifact closure
        candidate_report = parity_status(store, journal=temporary)
        if not candidate_report.complete:
            raise ParityError(
                "rebuilt mirror failed validation; leaving the existing journal "
                f"in place: mismatched={list(candidate_report.mismatched)} "
                f"missing={list(candidate_report.missing_source_ordinals)} "
                f"closure={list(candidate_report.closure_issues)}"
            )
        os.replace(temporary.path, journal.path)  # atomic install
    _note_repair_epoch(store, f"mirror rebuild ({intent.op_id})")
    return RebuildReport(
        quarantine_path=quarantine_path,
        prior_mirror_sha256=prior_sha,
        report=parity_status(store),
    )


class StoreLike(Protocol):
    """Structural store interface (satisfied by strive.store.Store)."""

    objects: ObjectStore
    task_id: str
    ledger_path: Path
    mirror: MirrorJournal

    def entries(self) -> Sequence[object]: ...
    def entries_with_bytes(self) -> tuple[bytes, Sequence[object]]: ...
    def generations(self) -> dict[str, Generation]: ...
