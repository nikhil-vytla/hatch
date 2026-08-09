"""Stage-3B.2: the one read boundary, with a reversible revision-read canary.

`StateReader` (the harness read session) is the single boundary every
operation reads through — cycle, compare, replay, audit, promotion,
rollback, provisional resolution, proposal staleness, seeding, status,
lineage, and restart reads. It captures ONE coherent canonical + mirror
snapshot per operation, identified by tamper-evident heads (record count +
digest-sequence hash on both journals), and refreshes only after the
operation's own writes. Direct `Store` reads remain as compatibility
internals. Mutations receive the reader's expected head and refuse stale
activation or rollback.

Modes (durable, journaled, default **native**):

- ``native`` — generation-native values serve every read; no derived reads.
- ``shadow`` — generation-native values serve every read; each supported
  read is compared against the verified revision snapshot and recorded.
- ``revision-canary`` — supported reads are served from the verified
  revision snapshot with the native value compared before use. There is no
  per-read silent fallback: unavailable or divergent derived state opens a
  durable circuit breaker (journaled) that blocks canary use; a kill switch
  returns immediately to native. Activation and durable promotion remain
  generation-native.

`VerifiedRevisionSnapshot` is the ONLY revision-read validator: it runs
parity's checks — complete `SourceRecordRef` agreement (schema, journal,
ordinal, digest) in both directions with source/mirror type agreement,
supported projector, recomputed-projection equality, full artifact closure,
descriptor pinning, provenance closure, manifest validation, and bounded
cycle-free lineage.

Cutover evidence lives in a locked, fsynced trusted reader journal
(`ledger/<task>.reader.jsonl`): every check records reader/projector
version, burn-in epoch, operation id, subject, exact heads, and outcome;
outcomes are recorded in ``finally`` including denied, rejected, stale, and
failing operations, and expected-but-unrecorded subjects are synthesized as
``missing`` so omitted instrumentation lowers eligibility. The epoch resets
after reader/projector changes or repair; older evidence is preserved but
excluded from current eligibility. Eligibility requires complete parity,
zero divergences/errors, minimum total and per-subject samples, and
observed accepted, rejected, no-candidate, rollback, re-promotion, audit,
replay, and restart paths.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Sequence

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
    PROJECTOR_REF,
    RevisionMirror,
    SourceSnapshot,
    _check_existing_mirrors,
    _verify_closure,
    canonical_scope_manifest,
    capture_snapshot,
    parity_status,
    validate_source_history,
)
from strive.events import EventLog, now_iso
from strive.revisions import (
    ContractViolation,
    DESCRIPTOR_REGISTRY,
    HarnessRevision,
    JournalHeadRef,
    LEVEL_TASK,
    ResolvedHarnessManifest,
    RevisionActivation,
    RevisionProvenance,
    RevisionRef,
    ScopeContribution,
    ScopeManifest,
    ScopeRef,
    candidate_overlay_revision,
    validate_resolved_manifest,
)
from strive.store import (
    LedgerEntry,
    Store,
    StoreError,
    derive_active_generation,
    derive_generations,
    derive_lineage,
    ledger_head,
)

READER_VERSION = "state-reader@1"

MODE_NATIVE = "native"
MODE_SHADOW = "shadow"
MODE_CANARY = "revision-canary"
MODES = (MODE_NATIVE, MODE_SHADOW, MODE_CANARY)

OUTCOME_AGREED = "agreed"
OUTCOME_DIVERGED = "diverged"
OUTCOME_UNAVAILABLE = "unavailable"
OUTCOME_NOT_APPLICABLE = "not-applicable"
OUTCOME_NATIVE = "native"  # read served natively with comparison off (native mode)
OUTCOME_MISSING = "missing"  # expected by the operation, never recorded

_SURFACE_KEY = ("strategy-code", "solve")


# expected checks are derived from the centralized operations: an operation
# that fails to record one of its subjects gets a synthesized `missing`
# outcome at finish, which blocks eligibility — omitted instrumentation can
# only ever LOWER coverage
OPERATION_SUBJECTS: dict[str, tuple[str, ...]] = {
    "cycle": ("cycle-baseline", "cycle-candidate"),
    "compare": ("compare-left", "compare-right"),
    "replay": ("replay-baseline", "replay-candidate"),
    "audit": ("audit-target",),
    "promote": ("promote-incumbent", "promote-target"),
    "rollback": ("rollback-active", "rollback-parent"),
    "status": ("status-active",),
    "lineage": ("status-lineage",),
    "seed": ("seed-active",),
}

# eligibility demands per-subject evidence for every routed read kind
REQUIRED_SUBJECTS = (
    "cycle-baseline", "cycle-candidate", "compare-left", "compare-right",
    "replay-baseline", "replay-candidate", "promote-incumbent",
    "promote-target", "rollback-active", "rollback-parent", "audit-target",
    "status-active",
)

# ... and observed outcomes on every behavioral path
REQUIRED_FACTS = (
    "decision-accepted", "decision-rejected", "no-candidate", "rollback",
    "re-promotion", "audit", "replay", "restart",
)

MIN_TOTAL_CHECKS = 20  # declared minimum current-epoch agreed samples
MIN_SUBJECT_CHECKS = 1  # declared minimum per required subject


class ReaderError(Exception):
    """Reader-journal or reader-state failure. Mode resolution degrades to
    native with a diagnostic; it never blocks a canonical operation."""


def _rev_id(generation_id: str) -> str:
    return generation_id.replace("gen-", "rev-")


# -- trusted reader journal (control + evidence stream) --------------------------------------


@register("reader-mode", 1)
@dataclass(frozen=True)
class ModeChange:
    mode: str
    reason: str
    at: str


@register("breaker-event", 1)
@dataclass(frozen=True)
class BreakerEvent:
    state: str  # "open" | "cleared"
    reason: str
    at: str


@register("epoch-reset", 1)
@dataclass(frozen=True)
class EpochReset:
    epoch: str
    reason: str
    reader_version: str
    projector_ref: str
    at: str


@register("read-check", 1)
@dataclass(frozen=True)
class ReadCheck:
    """One durable evidence record: a read routed through the boundary."""

    epoch: str
    op_id: str
    operation: str
    subject: str
    mode: str  # the effective mode the read ran under
    outcome: str
    detail: str
    canonical_head: str
    mirror_head: str
    reader_version: str
    projector_ref: str
    at: str
    run_id: str | None = None


@register("op-summary", 1)
@dataclass(frozen=True)
class OperationSummary:
    """The operation's terminal status (recorded in `finally`): ok, denied,
    rejected, stale, or error:<Type> — plus behavioral facts observed."""

    epoch: str
    op_id: str
    operation: str
    status: str
    facts: tuple[str, ...]
    at: str
    run_id: str | None = None


ReaderEntry = ModeChange | BreakerEvent | EpochReset | ReadCheck | OperationSummary


class ReaderJournal:
    """Locked, fsynced, append-only trusted stream for reader control state
    and cutover evidence."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock_path = path.with_suffix(".lock")
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def locked(self) -> Iterator[None]:
        with self._lock_path.open("a") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def append(self, entry: ReaderEntry) -> None:
        line = (codec.dumps(entry) + "\n").encode("utf-8")
        with self.locked():
            with self.path.open("ab") as handle:
                handle.write(line)
                handle.flush()
                os.fsync(handle.fileno())

    def append_many(self, entries: Sequence[ReaderEntry]) -> None:
        payload = "".join(codec.dumps(e) + "\n" for e in entries).encode("utf-8")
        if not payload:
            return
        with self.locked():
            with self.path.open("ab") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())

    def entries(self) -> tuple[list[ReaderEntry], int]:
        """All decodable entries plus a count of undecodable lines. Errors
        are counted (they block eligibility) but never raise: reader-journal
        corruption must not block canonical operations."""
        if not self.path.exists():
            return [], 0
        try:
            raw = self.path.read_bytes().decode("utf-8", errors="replace")
        except OSError as exc:
            raise ReaderError(f"{self.path}: unreadable reader journal: {exc}") from None
        lines = raw.split("\n")
        complete = lines[:-1] if lines and not raw.endswith("\n") else lines
        out: list[ReaderEntry] = []
        errors = 0
        for line in complete:
            if not line.strip():
                continue
            try:
                decoded: object = codec.loads(line)
            except codec.SchemaError:
                errors += 1
                continue
            if isinstance(
                decoded,
                (ModeChange, BreakerEvent, EpochReset, ReadCheck, OperationSummary),
            ):
                out.append(decoded)
            else:
                errors += 1
        return out, errors


def reader_journal(store: Store) -> ReaderJournal:
    return ReaderJournal(
        store.ledger_path.with_name(f"{store.task_id}.reader.jsonl")
    )


# -- durable reader state: mode, breaker, epoch -----------------------------------------------


@dataclass(frozen=True)
class ReaderState:
    mode: str
    breaker_open: bool
    breaker_reason: str | None
    epoch: str | None  # current epoch for THIS reader/projector version
    journal_errors: int


def reader_state(store: Store) -> ReaderState:
    entries, errors = reader_journal(store).entries()
    mode = MODE_NATIVE
    breaker_open = False
    breaker_reason: str | None = None
    epoch: str | None = None
    for entry in entries:
        if isinstance(entry, ModeChange):
            mode = entry.mode
        elif isinstance(entry, BreakerEvent):
            breaker_open = entry.state == "open"
            breaker_reason = entry.reason if breaker_open else None
        elif isinstance(entry, EpochReset):
            epoch = (
                entry.epoch
                if (
                    entry.reader_version == READER_VERSION
                    and entry.projector_ref == PROJECTOR_REF
                )
                else None  # version change: old epochs are not current
            )
    return ReaderState(
        mode=mode,
        breaker_open=breaker_open,
        breaker_reason=breaker_reason,
        epoch=epoch,
        journal_errors=errors,
    )


def ensure_epoch(store: Store) -> str:
    """The current burn-in epoch, opening a new one when none matches this
    build's reader/projector versions (evidence from other versions is
    preserved but excluded from current eligibility)."""
    state = reader_state(store)
    if state.epoch is not None:
        return state.epoch
    epoch = f"epoch-{uuid.uuid4().hex[:8]}"
    reader_journal(store).append(
        EpochReset(
            epoch=epoch,
            reason="opened for current reader/projector versions",
            reader_version=READER_VERSION,
            projector_ref=PROJECTOR_REF,
            at=now_iso(),
        )
    )
    return epoch


def reset_epoch(store: Store, reason: str) -> str:
    epoch = f"epoch-{uuid.uuid4().hex[:8]}"
    reader_journal(store).append(
        EpochReset(
            epoch=epoch,
            reason=reason,
            reader_version=READER_VERSION,
            projector_ref=PROJECTOR_REF,
            at=now_iso(),
        )
    )
    return epoch


def note_repair(mirror_path: Path, task_id: str, detail: str) -> None:
    """Called by dual-write repair/rebuild operations: derived history
    changed, so the burn-in epoch resets (old evidence preserved, excluded)."""
    journal = ReaderJournal(mirror_path.with_name(f"{task_id}.reader.jsonl"))
    journal.append(
        EpochReset(
            epoch=f"epoch-{uuid.uuid4().hex[:8]}",
            reason=f"repair: {detail}",
            reader_version=READER_VERSION,
            projector_ref=PROJECTOR_REF,
            at=now_iso(),
        )
    )


def set_mode(store: Store, mode: str, reason: str) -> None:
    """Journal a mode change. `native` and `shadow` are unrestricted;
    `revision-canary` must go through `enable_canary` (eligibility-gated)."""
    if mode not in (MODE_NATIVE, MODE_SHADOW):
        raise ReaderError(
            f"set_mode accepts native|shadow; canary requires enable_canary "
            f"(got {mode!r})"
        )
    reader_journal(store).append(ModeChange(mode=mode, reason=reason, at=now_iso()))


def kill_switch(store: Store, reason: str = "kill switch") -> None:
    """Immediate, unconditional return to native reads (journaled)."""
    reader_journal(store).append(
        ModeChange(mode=MODE_NATIVE, reason=reason, at=now_iso())
    )


def enable_canary(store: Store) -> "CutoverEligibility":
    """Enable revision-canary mode — only with current-epoch eligibility and
    a closed breaker."""
    state = reader_state(store)
    verdict = cutover_eligibility(store)
    if state.breaker_open:
        raise ReaderError(
            f"circuit breaker is open ({state.breaker_reason}); repair the "
            "derived state and clear the breaker before enabling the canary"
        )
    if not verdict.eligible:
        raise ReaderError(
            "canary enablement refused; current-epoch eligibility not met: "
            + "; ".join(verdict.reasons)
        )
    reader_journal(store).append(
        ModeChange(
            mode=MODE_CANARY,
            reason=f"eligibility met in epoch {verdict.epoch}",
            at=now_iso(),
        )
    )
    return verdict


def open_breaker(store: Store, reason: str) -> None:
    reader_journal(store).append(
        BreakerEvent(state="open", reason=reason, at=now_iso())
    )


def clear_breaker(store: Store, reason: str) -> None:
    reader_journal(store).append(
        BreakerEvent(state="cleared", reason=reason, at=now_iso())
    )


# -- the verified revision snapshot (the ONLY revision-read validator) ------------------------


@dataclass(frozen=True)
class VerifiedRevisionSnapshot:
    """Revision-derived state verified to parity grade, or the reason it is
    unavailable. Built from complete SourceRecordRef agreement (schema,
    journal, ordinal, digest — both directions, with type agreement),
    supported projector, recomputed-projection equality, full artifact
    closure, descriptor/provenance/manifest validation, and bounded
    cycle-free lineage. When unavailable, no active revision is reported."""

    available: bool
    reason: str
    revisions: dict[str, HarnessRevision] = field(default_factory=dict)
    activations: tuple[RevisionActivation, ...] = ()  # source activation order
    sources: dict[str, tuple[str, str]] = field(default_factory=dict)
    # revision_id -> (content_ref, text) from the revision's ScopeManifest

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
        chain: list[str] = []
        cursor: str | None = revision_id
        bound = len(self.revisions) + 1
        while cursor is not None and len(chain) < bound:
            chain.append(cursor)
            cursor = self.parent_of(cursor)
        return tuple(chain)


def _unavailable(reason: str) -> VerifiedRevisionSnapshot:
    return VerifiedRevisionSnapshot(available=False, reason=reason)


def verify_revision_snapshot(
    store: Store,
    source: SourceSnapshot | None = None,
    mirror_entries: Sequence[object] | None = None,
) -> VerifiedRevisionSnapshot:
    """Build the verified snapshot fail-safe: derived corruption or an
    unexpected exception yields *unavailable with a reason*, never an
    exception into the canonical operation."""
    try:
        return _verify(store, source, mirror_entries)
    except MirrorError as exc:
        return _unavailable(f"mirror journal unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001 — derived failure is data
        return _unavailable(
            f"unexpected derived-state failure: {type(exc).__name__}: {exc}"
        )


def _verify(
    store: Store,
    source: SourceSnapshot | None,
    mirror_entries: Sequence[object] | None,
) -> VerifiedRevisionSnapshot:
    snapshot = source if source is not None else capture_snapshot(store)
    entries = (
        list(mirror_entries) if mirror_entries is not None else store.mirror.entries()
    )
    validate_source_history(snapshot)

    # parity-grade mirror verification: complete refs, projector, duplicates,
    # type agreement, and RECOMPUTED-PROJECTION equality
    issues = _check_existing_mirrors(snapshot, entries)  # type: ignore[arg-type]
    if issues:
        return _unavailable("mirror verification failed: " + "; ".join(issues[:3]))

    # complete SourceRecordRef agreement, both directions
    by_ref = {(r.ref.ordinal, r.ref.digest): r for r in snapshot.records}
    seen: set[tuple[int, str]] = set()
    revisions: dict[str, HarnessRevision] = {}
    activation_mirrors: list[ActivationMirror] = []
    for entry in entries:
        if not isinstance(entry, (RevisionMirror, ActivationMirror)):
            continue
        record = by_ref.get((entry.source.ordinal, entry.source.digest))
        if record is None or entry.source != record.ref:
            return _unavailable(
                f"mirror at ordinal {entry.source.ordinal} does not carry the "
                "complete canonical source ref (schema/journal/ordinal/digest)"
            )
        if isinstance(entry, RevisionMirror) and record.generation is None:
            return _unavailable(
                f"type disagreement at ordinal {entry.source.ordinal}: revision "
                "mirror for a non-generation source record"
            )
        if isinstance(entry, ActivationMirror) and record.activation is None:
            return _unavailable(
                f"type disagreement at ordinal {entry.source.ordinal}: activation "
                "mirror for a non-activation source record"
            )
        seen.add((entry.source.ordinal, entry.source.digest))
        if isinstance(entry, RevisionMirror):
            revisions[entry.revision.ref.revision_id] = entry.revision
        else:
            activation_mirrors.append(entry)
    for key, record in by_ref.items():
        if key not in seen:
            return _unavailable(
                f"source record at ordinal {record.ref.ordinal} has no mirror "
                "— parity incomplete"
            )

    # full artifact closure (manifest/provenance/decision/descriptor/source)
    missing, closure_issues = _verify_closure(store, snapshot, entries)  # type: ignore[arg-type]
    if missing or closure_issues:
        return _unavailable(
            "artifact closure failed: " + "; ".join((missing + closure_issues)[:3])
        )

    activation_mirrors.sort(key=lambda m: m.source.ordinal)
    activations = tuple(m.activation for m in activation_mirrors)
    for activation in activations:
        if activation.revision.revision_id not in revisions:
            return _unavailable(
                f"activation targets revision {activation.revision.revision_id} "
                "with no mirror record"
            )

    # bounded, cycle-free lineage
    for revision_id in revisions:
        visited: set[str] = set()
        cursor: str | None = revision_id
        while cursor is not None:
            if cursor in visited:
                return _unavailable(f"lineage cycle at {cursor}")
            visited.add(cursor)
            node = revisions.get(cursor)
            if node is None:
                return _unavailable(f"lineage breaks at {cursor}: no mirror record")
            cursor = (
                node.base_parent.revision_id if node.base_parent is not None else None
            )

    # materialize sources from each revision's ScopeManifest by (kind, name)
    sources: dict[str, tuple[str, str]] = {}
    for revision_id, revision in revisions.items():
        try:
            manifest: ScopeManifest = codec.loads(
                store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
            )
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            return _unavailable(f"scope manifest for {revision_id}: {exc}")
        binding = next(
            (b for b in manifest.bindings if (b.kind, b.name) == _SURFACE_KEY), None
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
            return _unavailable(f"strategy artifact for {revision_id}: {exc}")
        sources[revision_id] = (binding.binding.content_ref, text)

    return VerifiedRevisionSnapshot(
        available=True,
        reason="ok",
        revisions=revisions,
        activations=activations,
        sources=sources,
    )


# -- execution records (honest evaluated subjects) --------------------------------------------

SUBJECT_ACTIVE_REVISION = "active-revision"
SUBJECT_RETAINED_REVISION = "retained-revision"
SUBJECT_CANDIDATE_OVERLAY = "candidate-overlay"


@register("execution-record", 1)
@dataclass(frozen=True)
class ExecutionRecord:
    """Provenance for ONE artifact execution, pinned before it runs.

    `base_resolved_ref` names the resolved harness the execution ran under
    (the ACTIVE baseline revision with its OWN bindings). The evaluated
    subject is named separately — an active revision, a retained (non-active)
    revision, or an unactivated candidate overlay — with its own effective
    manifest. The active baseline is never claimed to contain a non-active
    candidate, compare, replay, or audit source."""

    operation: str
    subject: str
    subject_kind: str  # active-revision | retained-revision | candidate-overlay
    subject_revision_ref: str | None  # CAS ref of the subject HarnessRevision
    base_resolved_ref: str | None  # CAS ref of the baseline ResolvedHarnessManifest
    effective_manifest_ref: str | None  # ScopeManifest of the EXECUTED artifact
    canonical_head: str
    mirror_head: str
    op_id: str
    detail: str
    at: str
    run_id: str | None = None


@dataclass(frozen=True)
class CandidateSubject:
    """An immutable, unactivated candidate revision created BEFORE its
    evaluation: the exact artifact being evaluated."""

    revision_ref: str  # CAS ref of the candidate HarnessRevision
    manifest_ref: str  # CAS ref of its ScopeManifest
    source_ref: str


# -- the read boundary ------------------------------------------------------------------------


@dataclass(frozen=True)
class _Check:
    subject: str
    outcome: str
    detail: str


class StateReader:
    """One coherent read session per operation (the harness read session).

    Captures the canonical ledger and mirror journal once, derives all
    native values from that capture with the same pure functions the Store
    uses, verifies the revision snapshot once, and pairs each supported read
    per its mode. `finish` must run in ``finally``: it records every
    attempted check — and synthesizes ``missing`` for expected checks that
    never ran — into the trusted reader journal."""

    def __init__(self, store: Store, operation: str, run_id: str | None = None) -> None:
        self.store = store
        self.operation = operation
        self.run_id = run_id
        self.op_id = f"op-{uuid.uuid4().hex[:8]}"
        self._checks: list[_Check] = []
        self._facts: set[str] = set()
        self._finished = False
        try:
            state = reader_state(store)
            self.mode = state.mode
            self.breaker_open = state.breaker_open
        except ReaderError as exc:
            self.mode = MODE_NATIVE
            self.breaker_open = False
            store._note_diagnostic(f"reader journal unavailable: {exc}; mode=native")
        if not store.mirror_enabled:
            self.mode = MODE_NATIVE  # no derived reads at all without mirrors
        self._capture()

    # the effective mode: an open breaker blocks canary use durably — reads
    # revert to native authority with comparisons still recorded (shadow)
    @property
    def effective_mode(self) -> str:
        if self.mode == MODE_CANARY and self.breaker_open:
            return MODE_SHADOW
        return self.mode

    # -- coherent snapshot -----------------------------------------------------

    def _capture(self) -> None:
        self._entries = self.store.entries()
        self.canonical_head = ledger_head(self._entries)
        self.mirror_head = "unread"
        self._snapshot: VerifiedRevisionSnapshot = _unavailable(
            "not captured in native mode"
        )
        if self.effective_mode == MODE_NATIVE:
            return
        try:
            mirror_bytes = (
                self.store.mirror.path.read_bytes()
                if self.store.mirror.path.exists()
                else b""
            )
            mirror_entries = self.store.mirror.entries()
            self.mirror_head = (
                f"{len(mirror_entries)}:{hashlib.sha256(mirror_bytes).hexdigest()}"
            )
        except (MirrorError, OSError) as exc:
            self.mirror_head = "unavailable"
            self._snapshot = _unavailable(f"mirror journal unavailable: {exc}")
            return
        source = capture_snapshot(self.store)
        self._snapshot = verify_revision_snapshot(self.store, source, mirror_entries)

    def refresh(self) -> None:
        """Re-capture the snapshot — legal only after this operation's own
        writes (the one exception is the documented staleness re-read)."""
        self._capture()

    def recheck_active_for_staleness(self) -> Generation | None:
        """The proposal-staleness re-read: deliberately re-captures to observe
        concurrent writers before a candidate is accepted against a superseded
        incumbent. Routed here so the exception to snapshot coherence is
        explicit and single."""
        self.refresh()
        return derive_active_generation(self._entries)

    # -- native view internals (compatibility derivations over the capture) ----

    def ledger_entries(self) -> "list[LedgerEntry]":
        return list(self._entries)

    def native_active(self) -> Generation | None:
        return derive_active_generation(self._entries)

    def native_generation(self, generation_id: str) -> Generation:
        generation = derive_generations(self._entries).get(generation_id)
        if generation is None:
            raise StoreError(
                f"unknown generation for task {self.store.task_id!r}: {generation_id}"
            )
        return generation

    # -- checked, subject-specific reads ----------------------------------------

    def note_not_applicable(self, subject: str, detail: str) -> None:
        self._add(subject, OUTCOME_NOT_APPLICABLE, detail)

    def _add(self, subject: str, outcome: str, detail: str) -> None:
        self._checks.append(_Check(subject=subject, outcome=outcome, detail=detail))

    def read_active(self, subject: str) -> Generation | None:
        native = derive_active_generation(self._entries)
        if native is None:
            self._add(subject, OUTCOME_NOT_APPLICABLE, "no active generation")
            return None
        self._compare_generation(subject, native, expect_active=True)
        return native

    def read_generation(self, subject: str, generation_id: str) -> Generation:
        native = self.native_generation(generation_id)
        self._compare_generation(subject, native, expect_active=False)
        return native

    def read_lineage(self, subject: str) -> list[Generation]:
        native = derive_lineage(self._entries)
        if not native:
            self._add(subject, OUTCOME_NOT_APPLICABLE, "no lineage")
            return native
        if self.effective_mode == MODE_NATIVE:
            self._add(subject, OUTCOME_NATIVE, "comparison off")
            return native
        snapshot = self._snapshot
        if not snapshot.available:
            self._handle_unavailable(subject, snapshot.reason)
            return native
        native_ids = tuple(_rev_id(g.generation_id) for g in native)
        shadow_ids = (
            snapshot.lineage_of(native_ids[0])
            if native_ids[0] in snapshot.revisions
            else ()
        )
        if shadow_ids != native_ids:
            self._handle_divergence(
                subject,
                f"lineage: generation-native {list(native_ids)} vs revision "
                f"{list(shadow_ids)}",
            )
        else:
            self._add(subject, OUTCOME_AGREED, " -> ".join(native_ids))
        return native

    def read_rollback_target(self, subject: str) -> Generation | None:
        active = derive_active_generation(self._entries)
        if active is None or active.parent_id is None:
            self._add(subject, OUTCOME_NOT_APPLICABLE, "no rollback target")
            return None
        parent = self.native_generation(active.parent_id)
        self._compare_generation(subject, parent, expect_active=False)
        return parent

    def source_for_execution(
        self,
        subject: str,
        generation: Generation,
        overlay: CandidateSubject | None = None,
    ) -> str:
        """The strategy source that will actually execute. Native and shadow
        modes serve the generation-native text; the canary serves the
        revision-materialized text after comparing it with the native value
        (they are verified equal before use — no silent substitution)."""
        native_text = self.store.objects.get_text(generation.source_ref)
        if self.effective_mode == MODE_NATIVE:
            return native_text
        derived = self._derived_source(generation, overlay)
        if derived is None:
            return native_text  # outcome already recorded by the caller's check
        _ref, text = derived
        if text != native_text:
            self._handle_divergence(
                subject,
                f"executed source for {generation.generation_id} differs between "
                "generation-native and revision-materialized artifacts",
            )
            return native_text  # divergent revision values are never served
        return text if self.effective_mode == MODE_CANARY else native_text

    def _derived_source(
        self, generation: Generation, overlay: CandidateSubject | None
    ) -> tuple[str, str] | None:
        if overlay is not None:
            try:
                manifest: ScopeManifest = codec.loads(
                    self.store.objects.get_text(overlay.manifest_ref), ScopeManifest
                )
                binding = next(
                    (
                        b
                        for b in manifest.bindings
                        if (b.kind, b.name) == _SURFACE_KEY
                    ),
                    None,
                )
                if binding is None or binding.binding.content_ref is None:
                    return None
                return (
                    binding.binding.content_ref,
                    self.store.objects.get_text(binding.binding.content_ref),
                )
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                return None
        if not self._snapshot.available:
            return None
        return self._snapshot.sources.get(_rev_id(generation.generation_id))

    def check_candidate_overlay(
        self, subject: str, source_ref: str, overlay: CandidateSubject
    ) -> None:
        """Pair an EPHEMERAL evaluation subject (the unactivated candidate)
        with its overlay revision: the evaluated artifact must be exactly the
        overlay's bound artifact."""
        if self.effective_mode == MODE_NATIVE:
            self._add(subject, OUTCOME_NATIVE, "comparison off")
            return
        try:
            manifest: ScopeManifest = codec.loads(
                self.store.objects.get_text(overlay.manifest_ref), ScopeManifest
            )
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            self._handle_unavailable(subject, f"candidate overlay manifest: {exc}")
            return
        binding = next(
            (b for b in manifest.bindings if (b.kind, b.name) == _SURFACE_KEY), None
        )
        if binding is None or binding.binding.content_ref != source_ref:
            self._handle_divergence(
                subject,
                "candidate overlay does not bind the evaluated artifact "
                f"({source_ref[:12]}…)",
            )
            return
        self._add(subject, OUTCOME_AGREED, overlay.revision_ref[:12])

    def _compare_generation(
        self, subject: str, generation: Generation, *, expect_active: bool
    ) -> None:
        if self.effective_mode == MODE_NATIVE:
            self._add(subject, OUTCOME_NATIVE, "comparison off")
            return
        try:
            snapshot = self._snapshot
            if not snapshot.available:
                self._handle_unavailable(subject, snapshot.reason)
                return
            revision_id = _rev_id(generation.generation_id)
            if expect_active:
                shadow_active = snapshot.active_revision_id()
                if shadow_active != revision_id:
                    self._handle_divergence(
                        subject,
                        f"active: generation-native {revision_id} vs revision "
                        f"{shadow_active}",
                    )
                    return
            revision = snapshot.revisions.get(revision_id)
            if revision is None:
                self._handle_divergence(
                    subject, f"no revision mirror for {generation.generation_id}"
                )
                return
            source_ref, source_text = snapshot.sources[revision_id]
            if source_ref != generation.source_ref:
                self._handle_divergence(
                    subject,
                    f"source ref: generation-native {generation.source_ref[:12]}… "
                    f"vs revision {source_ref[:12]}…",
                )
                return
            if source_text != self.store.objects.get_text(generation.source_ref):
                self._handle_divergence(
                    subject,
                    f"source text of {generation.generation_id} differs from its "
                    "revision-materialized artifact",
                )
                return
            native_parent = (
                _rev_id(generation.parent_id)
                if generation.parent_id is not None
                else None
            )
            if snapshot.parent_of(revision_id) != native_parent:
                self._handle_divergence(
                    subject,
                    f"parent: generation-native {native_parent} vs revision "
                    f"{snapshot.parent_of(revision_id)}",
                )
                return
            self._add(subject, OUTCOME_AGREED, revision_id)
        except Exception as exc:  # noqa: BLE001 — never fail the canonical op
            self._handle_unavailable(
                subject, f"check failed: {type(exc).__name__}: {exc}"
            )

    def _handle_divergence(self, subject: str, detail: str) -> None:
        self._add(subject, OUTCOME_DIVERGED, detail)
        reason = f"{subject}: {detail}"
        try:  # durable canonical intervention, deduplicated
            existing = {
                i.reason
                for i in self.store.interventions()
                if i.kind == INTERVENTION_SHADOW_DIVERGENCE
            }
            if reason not in existing:
                self.store.append(
                    Intervention(
                        kind=INTERVENTION_SHADOW_DIVERGENCE,
                        reason=reason,
                        at=now_iso(),
                        run_id=self.run_id,
                    )
                )
        except Exception as exc:  # noqa: BLE001
            self.store._note_diagnostic(f"divergence intervention failed: {exc}")
        self._trip_breaker(f"divergence at {reason}")

    def _handle_unavailable(self, subject: str, reason: str) -> None:
        self._add(subject, OUTCOME_UNAVAILABLE, reason)
        self._trip_breaker(f"unavailable at {subject}: {reason}")

    def _trip_breaker(self, reason: str) -> None:
        """In canary mode, unavailable or divergent derived state opens the
        durable circuit breaker and blocks canary use — never a per-read
        silent fallback."""
        if self.mode != MODE_CANARY or self.breaker_open:
            return
        try:
            open_breaker(self.store, reason)
        except Exception as exc:  # noqa: BLE001
            self.store._note_diagnostic(f"breaker journaling failed: {exc}")
        self.breaker_open = True  # effective mode drops to shadow immediately

    # -- facts + execution provenance -------------------------------------------

    def add_fact(self, fact: str) -> None:
        self._facts.add(fact)

    def record_execution(
        self,
        subject: str,
        generation: Generation,
        events: EventLog | None,
        overlay: CandidateSubject | None = None,
    ) -> str | None:
        """CAS-store the ExecutionRecord for one artifact execution, BEFORE
        it runs. Failure to build one is reported, never blocking."""
        try:
            snapshot = self._snapshot
            base_resolved_ref: str | None = None
            subject_revision_ref: str | None = None
            effective_manifest_ref: str | None = None
            detail = "ok"
            if overlay is not None:
                subject_kind = SUBJECT_CANDIDATE_OVERLAY
                subject_revision_ref = overlay.revision_ref
                effective_manifest_ref = overlay.manifest_ref
            elif generation.origin == "candidate":
                # an ephemeral probe with no overlay available: still named
                # honestly as a candidate, never as a retained revision
                subject_kind = SUBJECT_CANDIDATE_OVERLAY
                detail = "candidate overlay unavailable"
            else:
                revision_id = _rev_id(generation.generation_id)
                revision = (
                    snapshot.revisions.get(revision_id)
                    if snapshot.available
                    else None
                )
                active = derive_active_generation(self._entries)
                is_active = (
                    active is not None
                    and active.generation_id == generation.generation_id
                )
                subject_kind = (
                    SUBJECT_ACTIVE_REVISION if is_active else SUBJECT_RETAINED_REVISION
                )
                if revision is not None:
                    subject_revision_ref = self.store.objects.put_text(
                        codec.dumps(revision)
                    )
                    effective_manifest_ref = revision.scope_manifest_ref
                else:
                    detail = (
                        "subject revision unavailable: "
                        f"{snapshot.reason if not snapshot.available else 'no mirror'}"
                    )
            if snapshot.available:
                base_resolved_ref = self._baseline_resolved_ref()
            record = ExecutionRecord(
                operation=self.operation,
                subject=subject,
                subject_kind=subject_kind,
                subject_revision_ref=subject_revision_ref,
                base_resolved_ref=base_resolved_ref,
                effective_manifest_ref=effective_manifest_ref,
                canonical_head=self.canonical_head,
                mirror_head=self.mirror_head,
                op_id=self.op_id,
                detail=detail,
                at=now_iso(),
                run_id=self.run_id,
            )
            ref = self.store.objects.put_text(codec.dumps(record))
        except Exception as exc:  # noqa: BLE001 — provenance capture never blocks
            if events is not None:
                events.emit(
                    "execution_record",
                    subject=subject,
                    generation_id=generation.generation_id,
                    execution_record_ref=None,
                    reason=f"{type(exc).__name__}: {exc}",
                )
            return None
        if events is not None:
            events.emit(
                "execution_record",
                subject=subject,
                generation_id=generation.generation_id,
                subject_kind=record.subject_kind,
                execution_record_ref=ref,
            )
        return ref

    def _baseline_resolved_ref(self) -> str | None:
        """The resolved harness the execution runs under: the ACTIVE baseline
        revision with its OWN bindings — never the evaluated subject's."""
        snapshot = self._snapshot
        active_id = snapshot.active_revision_id()
        if active_id is None:
            return None
        revision = snapshot.revisions[active_id]
        manifest: ScopeManifest = codec.loads(
            self.store.objects.get_text(revision.scope_manifest_ref), ScopeManifest
        )
        scope = ScopeRef(LEVEL_TASK, self.store.task_id)
        resolved = ResolvedHarnessManifest(
            resolution_chain=(scope,),
            contributions=(
                ScopeContribution(
                    scope=scope,
                    revision=RevisionRef(scope, active_id),
                    journal_head=JournalHeadRef("jsonl@1", self.canonical_head),
                ),
            ),
            effective=tuple(
                b for b in manifest.bindings if b.binding.content_ref is not None
            ),
        )
        validate_resolved_manifest(resolved)
        return self.store.objects.put_text(codec.dumps(resolved))

    def candidate_subject(
        self,
        *,
        candidate_id: str,
        source_ref: str,
        proposer: str,
        summary: str,
        weakness_id: str | None,
        task_fingerprint: str,
    ) -> CandidateSubject | None:
        """Create the immutable, unactivated candidate revision + manifest
        BEFORE evaluation. None (with a recorded reason at the caller's
        check) when the derived baseline is unavailable."""
        try:
            snapshot = self._snapshot
            active = derive_active_generation(self._entries)
            if active is None:
                return None
            active_revision = (
                snapshot.revisions.get(_rev_id(active.generation_id))
                if snapshot.available
                else None
            )
            if active_revision is None:
                return None
            manifest = canonical_scope_manifest(self.store.task_id, source_ref)
            manifest_ref = self.store.objects.put_text(codec.dumps(manifest))
            provenance = RevisionProvenance(
                origin="candidate-overlay",
                task_id=self.store.task_id,
                task_fingerprint=task_fingerprint,
                surface=_SURFACE_KEY[0],
                weakness_id=weakness_id,
                parent_revision_id=active_revision.ref.revision_id,
                decision_ref=None,
            )
            provenance_ref = self.store.objects.put_text(codec.dumps(provenance))
            revision = candidate_overlay_revision(
                candidate_id=candidate_id,
                task_id=self.store.task_id,
                source_ref=source_ref,
                parent_revision=active_revision,
                parent_source_ref=active.source_ref,
                scope_manifest_ref=manifest_ref,
                provenance_ref=provenance_ref,
                proposer=proposer,
                summary=summary,
                created_at=now_iso(),
            )
            revision_ref = self.store.objects.put_text(codec.dumps(revision))
            return CandidateSubject(
                revision_ref=revision_ref,
                manifest_ref=manifest_ref,
                source_ref=source_ref,
            )
        except (ContractViolation, ObjectMissing, ObjectCorruption, OSError):
            return None

    # -- durable recording (must run in `finally`) --------------------------------

    def finish(self, events: EventLog | None = None, status: str = "ok") -> None:
        """Record every attempted check and the operation summary. Expected
        subjects that were never recorded — including on denied, rejected,
        stale, and failing operations — are synthesized as ``missing``, so an
        uninstrumented path can only lower eligibility. Idempotent."""
        if self._finished:
            return
        self._finished = True
        if not self.store.mirror_enabled:
            return  # a mirror-disabled store records no derived state at all
        try:
            epoch = ensure_epoch(self.store)
            recorded = {c.subject for c in self._checks}
            for subject in OPERATION_SUBJECTS.get(self.operation, ()):
                if subject not in recorded:
                    self._add(
                        subject,
                        OUTCOME_MISSING,
                        f"expected by operation {self.operation!r} but never "
                        f"recorded (operation status: {status})",
                    )
            at = now_iso()
            rows: list[ReaderEntry] = [
                ReadCheck(
                    epoch=epoch,
                    op_id=self.op_id,
                    operation=self.operation,
                    subject=check.subject,
                    mode=self.effective_mode,
                    outcome=check.outcome,
                    detail=check.detail,
                    canonical_head=self.canonical_head,
                    mirror_head=self.mirror_head,
                    reader_version=READER_VERSION,
                    projector_ref=PROJECTOR_REF,
                    at=at,
                    run_id=self.run_id,
                )
                for check in self._checks
            ]
            rows.append(
                OperationSummary(
                    epoch=epoch,
                    op_id=self.op_id,
                    operation=self.operation,
                    status=status,
                    facts=tuple(sorted(self._facts)),
                    at=at,
                    run_id=self.run_id,
                )
            )
            reader_journal(self.store).append_many(rows)
        except Exception as exc:  # noqa: BLE001 — evidence loss is a diagnostic,
            self.store._note_diagnostic(  # never a canonical failure
                f"reader evidence recording failed: {exc}"
            )
            return
        if events is not None:
            for check in self._checks:
                events.emit(
                    "read_check",
                    subject=check.subject,
                    outcome=check.outcome,
                    detail=check.detail,
                    mode=self.effective_mode,
                )


# alias: the goal-facing name for the session
HarnessReadSession = StateReader


# -- coverage + cutover eligibility ------------------------------------------------------------


@dataclass(frozen=True)
class ReadCoverage:
    """Current-epoch evidence: outcome totals, per-subject counts, observed
    facts, and journal integrity."""

    epoch: str | None
    total: int
    agreed: int
    diverged: int
    unavailable: int
    missing: int
    not_applicable: int
    native_only: int
    journal_errors: int
    by_subject: dict[str, dict[str, int]]
    facts: tuple[str, ...]


def read_coverage(store: Store) -> ReadCoverage:
    entries, errors = reader_journal(store).entries()
    state = reader_state(store)
    counts = {
        OUTCOME_AGREED: 0,
        OUTCOME_DIVERGED: 0,
        OUTCOME_UNAVAILABLE: 0,
        OUTCOME_MISSING: 0,
        OUTCOME_NOT_APPLICABLE: 0,
        OUTCOME_NATIVE: 0,
    }
    by_subject: dict[str, dict[str, int]] = {}
    facts: set[str] = set()
    total = 0
    for entry in entries:
        if isinstance(entry, ReadCheck) and entry.epoch == state.epoch:
            total += 1
            if entry.outcome in counts:
                counts[entry.outcome] += 1
            subject = by_subject.setdefault(entry.subject, {})
            subject[entry.outcome] = subject.get(entry.outcome, 0) + 1
        elif isinstance(entry, OperationSummary) and entry.epoch == state.epoch:
            facts.update(entry.facts)
    return ReadCoverage(
        epoch=state.epoch,
        total=total,
        agreed=counts[OUTCOME_AGREED],
        diverged=counts[OUTCOME_DIVERGED],
        unavailable=counts[OUTCOME_UNAVAILABLE],
        missing=counts[OUTCOME_MISSING],
        not_applicable=counts[OUTCOME_NOT_APPLICABLE],
        native_only=counts[OUTCOME_NATIVE],
        journal_errors=errors,
        by_subject=by_subject,
        facts=tuple(sorted(facts)),
    )


@dataclass(frozen=True)
class CutoverEligibility:
    eligible: bool
    epoch: str | None
    parity_complete: bool
    coverage: ReadCoverage
    reasons: tuple[str, ...]


def cutover_eligibility(store: Store) -> CutoverEligibility:
    """Whether canary enablement is defensible NOW, from current-epoch
    evidence only: complete parity, zero divergences/errors, minimum total
    and per-subject samples, and every required behavioral path observed."""
    reasons: list[str] = []
    try:
        parity_complete = parity_status(store).complete
        if not parity_complete:
            reasons.append("mirror parity is incomplete")
    except Exception as exc:  # noqa: BLE001 — corrupt derived state blocks cutover
        parity_complete = False
        reasons.append(f"parity cannot be verified: {exc}")
    coverage = read_coverage(store)
    if coverage.epoch is None:
        reasons.append("no current burn-in epoch for this reader/projector version")
    if coverage.journal_errors:
        reasons.append(
            f"{coverage.journal_errors} undecodable line(s) in the reader journal"
        )
    if coverage.diverged:
        reasons.append(f"{coverage.diverged} divergence(s) in the current epoch")
    if coverage.missing:
        reasons.append(
            f"{coverage.missing} expected check(s) were never recorded "
            "(uninstrumented or aborted paths)"
        )
    if coverage.unavailable:
        reasons.append(
            f"{coverage.unavailable} read(s) could not be paired "
            "(derived state unavailable)"
        )
    if coverage.agreed < MIN_TOTAL_CHECKS:
        reasons.append(
            f"only {coverage.agreed} agreed check(s); the declared minimum is "
            f"{MIN_TOTAL_CHECKS}"
        )
    for subject in REQUIRED_SUBJECTS:
        agreed = coverage.by_subject.get(subject, {}).get(OUTCOME_AGREED, 0)
        if agreed < MIN_SUBJECT_CHECKS:
            reasons.append(
                f"subject {subject!r} has {agreed} agreed sample(s); "
                f"minimum {MIN_SUBJECT_CHECKS}"
            )
    observed = set(coverage.facts)
    for fact in REQUIRED_FACTS:
        if fact not in observed:
            reasons.append(f"required path {fact!r} has not been observed")
    return CutoverEligibility(
        eligible=not reasons,
        epoch=coverage.epoch,
        parity_complete=parity_complete,
        coverage=coverage,
        reasons=tuple(reasons),
    )
