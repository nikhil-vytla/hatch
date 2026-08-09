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


@register("migration-intent", 1)
@dataclass(frozen=True)
class MigrationIntent:
    op_id: str
    migration_id: str
    source_head: int  # complete-record count at intent time
    source_hash: str  # sha256 of the source journal bytes at intent time
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
        if not self.path.exists():
            return []
        raw = self.path.read_bytes().decode("utf-8")
        lines = raw.split("\n")
        complete = lines[:-1] if lines and not raw.endswith("\n") else lines
        entries: list[MirrorEntry] = []
        for line_no, line in enumerate(complete, start=1):
            if not line.strip():
                continue
            try:
                decoded: object = codec.loads(line)
            except codec.SchemaError as exc:
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
        return entries


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
    records: tuple[SourceRecord, ...]  # generations + activations, source order

    def generations(self) -> dict[str, Generation]:
        return {
            r.generation.generation_id: r.generation
            for r in self.records
            if r.generation is not None
        }


def capture_snapshot(store: "StoreLike") -> SourceSnapshot:
    """Read-only capture of the source ledger with per-record refs."""
    entries = store.entries()
    journal = f"task:{store.task_id}"
    records: list[SourceRecord] = []
    for ordinal, entry in enumerate(entries):
        digest = hashlib.sha256(codec.dumps(entry).encode("utf-8")).hexdigest()
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
    journal_hash = (
        hashlib.sha256(store.ledger_path.read_bytes()).hexdigest()
        if store.ledger_path.exists()
        else hashlib.sha256(b"").hexdigest()
    )
    return SourceSnapshot(
        task_id=store.task_id,
        head=len(entries),
        journal_hash=journal_hash,
        records=tuple(records),
    )


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
    """Pure planning: project every source record lacking a mirror. Raises
    structured ParityError on unsupported/ambiguous inputs; publishes nothing."""
    validate_source_history(snapshot)
    _check_existing_mirrors(snapshot, existing)
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
        if key in mirrored:
            continue
        if record.generation is not None:
            parent = (
                generations[record.generation.parent_id]
                if record.generation.parent_id is not None
                else None
            )
            mirror, mirror_payloads = _project_generation(
                record.generation, parent, record.ref
            )
            payloads.extend(mirror_payloads)
            mirrors.append(mirror)
        elif record.activation is not None:
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
    """Publish a plan under the mirror-journal writer lock.

    Re-reads the source head first and refuses stale plans: the plan was
    built from a snapshot, and applying it against a moved source would
    publish mirrors for history the plan never saw.
    """
    with journal.writer_lock():
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

    @property
    def complete(self) -> bool:
        return not (self.missing_source_ordinals or self.mismatched)


def parity_status(store: "StoreLike") -> ParityReport:
    """Read-only comparison of source history and mirror journal — publishes
    nothing (expected CAS refs are computed with `hash_text`)."""
    snapshot = capture_snapshot(store)
    validate_source_history(snapshot)
    existing = store.mirror.entries()  # MirrorError on corruption, contained here
    issues = _check_existing_mirrors(snapshot, existing)
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


def open_intent(journal: MirrorJournal) -> MigrationIntent | None:
    """The unfinished operation, if any: last intent without its completion."""
    intents: dict[str, MigrationIntent] = {}
    completed: set[str] = set()
    for entry in journal.entries():
        if isinstance(entry, MigrationIntent):
            intents[entry.op_id] = entry
        elif isinstance(entry, MigrationCompleted):
            completed.add(entry.op_id)
    open_ops = [i for i in intents.values() if i.op_id not in completed]
    return open_ops[-1] if open_ops else None


def run_backfill_operation(store: "StoreLike", migration_id: str) -> ParityReport:
    """The durable backfill/repair state machine.

    Resume-safe at every crash point: an open intent is reused (its source
    head/hash preserved across retries — the operation completes for the
    history it declared); mirrors are idempotent by source ref; completion is
    journaled only after parity validation over the intent's snapshot.
    """
    from strive.events import now_iso
    import uuid

    journal = store.mirror
    intent = open_intent(journal)
    if intent is None:
        snapshot = capture_snapshot(store)
        validate_source_history(snapshot)
        intent = MigrationIntent(
            op_id=f"op-{uuid.uuid4().hex[:8]}",
            migration_id=migration_id,
            source_head=snapshot.head,
            source_hash=snapshot.journal_hash,
            projector_ref=PROJECTOR_REF,
            started_at=now_iso(),
        )
        journal.append(intent)  # durable BEFORE any work

    # the operation targets the intent's declared history, not whatever the
    # source looks like now; new source records are a future operation
    full = capture_snapshot(store)
    if full.head < intent.source_head:
        raise ParityError(
            f"source journal shrank below intent head {intent.source_head}; "
            "append-only history was violated — refusing"
        )
    snapshot = SourceSnapshot(
        task_id=full.task_id,
        head=intent.source_head,
        journal_hash=intent.source_hash,
        records=tuple(r for r in full.records if r.ref.ordinal < intent.source_head),
    )
    plan = plan_projection(snapshot, journal.entries())
    # The plan covers the intent's declared range. The apply-time staleness
    # check must compare against the *current* source head (the source may
    # legitimately have advanced past the intent; those newer records are a
    # future operation's work), so rebase the plan's head onto now.
    current_plan = dataclasses.replace(
        plan, source_head=full.head, source_hash=full.journal_hash
    )
    if plan.mirrors:
        apply_projection(store, journal, current_plan)
        journal.append(
            MigrationProgress(
                op_id=intent.op_id,
                mirrored_through_ordinal=max(
                    m.source.ordinal for m in plan.mirrors
                ),
                at=now_iso(),
            )
        )

    # validate parity over the intent's snapshot before declaring completion
    report = parity_status(store)
    covered = [o for o in report.missing_source_ordinals if o < intent.source_head]
    if report.mismatched or covered:
        raise ParityError(
            "backfill did not reach parity over the intent's history; "
            f"mismatched={list(report.mismatched)} missing={covered}"
        )
    journal.append(
        MigrationCompleted(
            op_id=intent.op_id,
            at=now_iso(),
            detail=(
                f"{migration_id}: mirrored through source head "
                f"{intent.source_head} (source sha256 {intent.source_hash[:12]}…)"
            ),
        )
    )
    return parity_status(store)


class StoreLike(Protocol):
    """Structural store interface (satisfied by strive.store.Store)."""

    objects: ObjectStore
    task_id: str
    ledger_path: Path
    mirror: MirrorJournal

    def entries(self) -> Sequence[object]: ...
    def generations(self) -> dict[str, Generation]: ...
