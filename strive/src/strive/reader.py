"""Stage-3B.2: the one read boundary, with a reversible revision-read canary.

`StateReader` (the harness read session) is the single boundary every
operation reads through — cycle, compare, replay, audit, promotion,
rollback, provisional resolution, proposal staleness, task/drift guards,
proposal history, seeding, status, lineage, and restart reads. It captures
ONE coherent canonical + mirror snapshot per operation: the canonical
entries and bytes come from a single read (native view and `SourceSnapshot`
derive from that exact capture), and the mirror capture is validated by an
optimistic read-recheck loop — an old native capture is never combined with
a newer mirror capture. Snapshots refresh only after the operation's own
writes. Mutations receive the reader's expected head and refuse stale
activation, rollback, seeding, and provisional transitions.

Modes (durable, journaled, default **native**):

- ``native`` — generation-native values serve every read; no derived reads.
- ``shadow`` — generation-native values serve every read; each supported
  read is compared against the verified revision snapshot and recorded.
  Entering shadow starts a new burn-in epoch.
- ``revision-canary`` — the revision-derived **execution/read canary**:
  executed sources are served from the verified revision snapshot (or the
  candidate overlay) after comparing with the native value; identity reads
  (active/generation/lineage/parent) are agreement-gated — the returned
  compatibility values coincide with the native records by construction.
  The canary is effective only while the current epoch remains eligible at
  operation start; unavailable or divergent derived state, reader-journal
  corruption, or lost eligibility opens a durable circuit breaker. A kill
  switch returns immediately to native, and a force-native override
  (sentinel file or STRIVE_FORCE_NATIVE=1) works independently of the
  reader journal. Activation and durable promotion remain generation-native.

Control and evidence live in the **reader journal**
(`ledger/<task>.reader.jsonl`): locked, fsynced, task-bound, and written in
crash-framed, hash-chained batches — every batch ends with a `ReaderFrame`
carrying the batch payload hash and the previous frame's hash, so deletion,
reordering, and naive appended forgeries are detected (unframed lines are
never honored as control state). This journal is kernel-owned but NOT
tamper-proof against candidate code under the current sandbox (same-UID
filesystem access): canary mode is therefore refused for real/unsafe
model-generated code until host-enforced confinement exists.

Every check records its mode and exact canonical/mirror heads at check
time; each expected `(op_id, subject)` gets exactly one terminal outcome
(severity-merged); outcomes are recorded in ``finally`` including denied,
rejected, stale, and failing operations, with `missing` synthesized for
expected-but-unrecorded subjects. Behavioral facts count only from
successfully completed shadow/canary operations. Repair, rebuild, and
reader/projector version changes atomically disable the canary and reset
the epoch (fail-closed, never best-effort); old evidence is preserved but
excluded from current eligibility.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass
from dataclasses import field as dc_field
from pathlib import Path
from typing import Callable, Sequence

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing
from strive.codec import register
from strive.framing import FramedJournal, FramedView, FramingError
from strive.contracts import (
    Decision,
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
    parity_status,
    snapshot_of,
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

READER_VERSION = "state-reader@2"

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

# exactly one terminal outcome per (op_id, subject): repeated probes of the
# same subject merge by severity, the worst outcome wins
_SEVERITY = {
    OUTCOME_NOT_APPLICABLE: 0,
    OUTCOME_NATIVE: 1,
    OUTCOME_AGREED: 2,
    OUTCOME_MISSING: 3,
    OUTCOME_UNAVAILABLE: 4,
    OUTCOME_DIVERGED: 5,
}

_SURFACE_KEY = ("strategy-code", "solve")

FORCE_NATIVE_ENV = "STRIVE_FORCE_NATIVE"

# expected checks derive from the centralized operations: an operation that
# fails to record one of its subjects gets a synthesized `missing` outcome
# at finish, which blocks eligibility — omitted instrumentation can only
# ever LOWER coverage. The candidate-overlay (evaluated artifact) and the
# retained candidate (mirrored revision after retention) are distinct
# subjects.
OPERATION_SUBJECTS: dict[str, tuple[str, ...]] = {
    "cycle": ("cycle-baseline", "cycle-candidate-overlay", "cycle-candidate-retained"),
    "compare": ("compare-left", "compare-right"),
    "replay": ("replay-baseline", "replay-candidate"),
    "audit": ("audit-target",),
    "promote": ("promote-incumbent", "promote-target"),
    "rollback": ("rollback-active", "rollback-parent"),
    "status": ("status-active",),
    "lineage": ("status-lineage",),
    "seed": ("seed-active",),
}

REQUIRED_SUBJECTS = (
    "cycle-baseline", "cycle-candidate-overlay", "cycle-candidate-retained",
    "compare-left", "compare-right", "replay-baseline", "replay-candidate",
    "promote-incumbent", "promote-target", "rollback-active",
    "rollback-parent", "audit-target", "status-active",
)

REQUIRED_FACTS = (
    "decision-accepted", "decision-rejected", "no-candidate", "rollback",
    "re-promotion", "audit", "replay", "restart",
)

MIN_TOTAL_CHECKS = 20  # declared minimum current-epoch agreed samples
MIN_SUBJECT_CHECKS = 1  # declared minimum per required subject


class ReaderError(Exception):
    """Reader-journal or reader-control failure. Mode resolution degrades to
    native; control transitions and repair bookkeeping raise (fail closed)."""


def _rev_id(generation_id: str) -> str:
    return generation_id.replace("gen-", "rev-")


# -- reader journal records --------------------------------------------------------------------


@register("reader-mode", 2)
@dataclass(frozen=True)
class ModeChange:
    mode: str
    reason: str
    at: str
    authorized_head: str = ""  # the reader-journal head this transition saw
    proof: str = ""  # the eligibility evidence the transition authorized


@register("breaker-event", 2)
@dataclass(frozen=True)
class BreakerEvent:
    state: str  # "open" | "cleared"
    reason: str
    at: str
    authorized_head: str = ""
    proof: str = ""


@register("epoch-reset", 1)
@dataclass(frozen=True)
class EpochReset:
    epoch: str
    reason: str
    reader_version: str
    projector_ref: str
    at: str


@register("read-check", 2)
@dataclass(frozen=True)
class ReadCheck:
    """One durable evidence record: a read routed through the boundary.
    `mode` and both heads are captured AT CHECK TIME, not session end."""

    epoch: str
    op_id: str
    operation: str
    subject: str
    mode: str
    outcome: str
    detail: str
    canonical_head: str
    mirror_head: str
    reader_version: str
    projector_ref: str
    at: str
    run_id: str | None = None


@register("op-summary", 2)
@dataclass(frozen=True)
class OperationSummary:
    """The operation's terminal status (recorded in `finally`): ok, denied,
    rejected, stale, or error:<Type> — plus behavioral facts observed.
    Facts count toward eligibility only when status is ok and the mode is
    shadow or canary."""

    epoch: str
    op_id: str
    operation: str
    mode: str
    status: str
    facts: tuple[str, ...]
    at: str
    run_id: str | None = None


ReaderEntry = ModeChange | BreakerEvent | EpochReset | ReadCheck | OperationSummary

_READER_ENTRY_TYPES = (
    ModeChange, BreakerEvent, EpochReset, ReadCheck, OperationSummary
)


class ReaderJournal(FramedJournal):
    """The reader control + evidence stream: a framed journal over the
    reader entry kinds (see strive.framing for the durability contract).
    Framing failures surface as ``ReaderError`` so the reader-control
    contract is unchanged by the shared implementation. A PR#43-era journal
    (frame schema ``reader-frame@1``, pre-shared-framing genesis) fails
    loudly with migration guidance — it is never parsed as corruption."""

    legacy_frame_schemas = ("reader-frame@1",)

    def __init__(self, path: Path, task_id: str) -> None:
        super().__init__(path, task_id, "reader@2", _READER_ENTRY_TYPES)

    def read(self) -> FramedView:
        try:
            return super().read()
        except FramingError as exc:
            raise ReaderError(str(exc)) from None

    def append_batch(
        self, batch: Sequence[object], expected_head: str | None = None
    ) -> str:
        try:
            return super().append_batch(batch, expected_head)
        except FramingError as exc:
            raise ReaderError(str(exc)) from None


def reader_journal(store: Store) -> ReaderJournal:
    return ReaderJournal(
        store.ledger_path.with_name(f"{store.task_id}.reader.jsonl"), store.task_id
    )


# -- PR#43-format journal migration -------------------------------------------------------------

_LEGACY_READER_GENESIS = hashlib.sha256(b"strive-reader-genesis").hexdigest()


@dataclass(frozen=True)
class ReaderUpgradeReport:
    quarantine_path: str
    original_sha256: str
    batches: int
    entries: int


def reader_journal_needs_upgrade(store: Store) -> bool:
    journal = reader_journal(store)
    if not journal.path.exists():
        return False
    return b'"schema":"reader-frame@1"' in journal.path.read_bytes()


def upgrade_reader_journal(store: Store) -> ReaderUpgradeReport:
    """Migrate the exact PR#43 reader journal (frame schema ``reader-frame@1``
    with the old fixed genesis) to the shared framing format.

    The original file is preserved byte-for-byte at a quarantine path (with
    its sha256 recorded); every batch is re-framed in the SAME order with the
    SAME entries and batch boundaries, so mode, breaker, epoch, checks, and
    summaries all carry over exactly. Any verification failure in the old
    chain fails loudly — an ambiguous journal is never partially migrated."""
    import json

    journal = reader_journal(store)
    if not journal.path.exists():
        raise ReaderError(f"{journal.path}: no reader journal to upgrade")
    raw = journal.path.read_bytes()
    if b'"schema":"reader-frame@1"' not in raw:
        raise ReaderError(
            f"{journal.path}: not a PR#43-format journal (no reader-frame@1 "
            "frames); nothing to upgrade"
        )
    if raw and not raw.endswith(b"\n"):
        raise ReaderError(
            f"{journal.path}: legacy journal has a torn final line; refusing "
            "an ambiguous migration — repair or quarantine it manually first"
        )
    # parse + verify with the OLD rules (old genesis; frame without `stream`)
    batches: list[list[ReaderEntry]] = []
    buffer_bytes = b""
    buffer_entries: list[ReaderEntry] = []
    frames = 0
    last_hash = _LEGACY_READER_GENESIS
    for line_no, line in enumerate(raw.split(b"\n")[:-1], start=1):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ReaderError(
                f"{journal.path}:{line_no}: undecodable line in the legacy "
                "journal; refusing an ambiguous migration"
            ) from None
        if isinstance(parsed, dict) and parsed.get("schema") == "reader-frame@1":
            expected = hashlib.sha256(buffer_bytes).hexdigest()
            if (
                parsed.get("task_id") != store.task_id
                or parsed.get("seq") != frames + 1
                or parsed.get("prev") != last_hash
                or parsed.get("payload_hash") != expected
                or parsed.get("count") != len(buffer_entries)
            ):
                raise ReaderError(
                    f"{journal.path}:{line_no}: legacy frame seq "
                    f"{parsed.get('seq')} failed verification; refusing an "
                    "ambiguous migration"
                )
            batches.append(buffer_entries)
            frames += 1
            last_hash = hashlib.sha256(line).hexdigest()
            buffer_bytes = b""
            buffer_entries = []
        else:
            decoded: object = codec.loads(line.decode("utf-8"))
            if not isinstance(decoded, _READER_ENTRY_TYPES):
                raise ReaderError(
                    f"{journal.path}:{line_no}: {type(decoded).__name__} is not "
                    "a reader entry; refusing an ambiguous migration"
                )
            buffer_bytes += line + b"\n"
            buffer_entries.append(decoded)
    if buffer_entries:
        raise ReaderError(
            f"{journal.path}: legacy journal has unframed trailing lines; "
            "refusing an ambiguous migration"
        )
    # preserve, then rewrite in the shared format (same batches, same order)
    original_sha = hashlib.sha256(raw).hexdigest()
    quarantine = journal.path.with_name(
        journal.path.name + f".pre-upgrade-{now_iso().replace(':', '')}"
    )
    quarantine.write_bytes(raw)
    journal.path.unlink()
    total = 0
    for batch in batches:
        journal.append_batch(batch)
        total += len(batch)
    return ReaderUpgradeReport(
        quarantine_path=str(quarantine),
        original_sha256=original_sha,
        batches=len(batches),
        entries=total,
    )


def _force_native_path(journal: ReaderJournal) -> Path:
    return journal.path.with_name(journal.path.name + ".FORCE-NATIVE")


def force_native_active(store: Store) -> bool:
    """The emergency override, independent of the reader journal: a sentinel
    file or STRIVE_FORCE_NATIVE=1 forces native reads unconditionally."""
    if os.environ.get(FORCE_NATIVE_ENV, "") == "1":
        return True
    return _force_native_path(reader_journal(store)).exists()


def force_native(store: Store, reason: str) -> None:
    path = _force_native_path(reader_journal(store))
    path.write_text(f"{now_iso()} {reason}\n")


def lift_force_native(store: Store) -> None:
    path = _force_native_path(reader_journal(store))
    if path.exists():
        path.unlink()


# -- durable reader control state ---------------------------------------------------------------


@dataclass(frozen=True)
class ReaderState:
    mode: str  # the EFFECTIVE configured mode (native when forced)
    configured_mode: str
    forced_native: bool
    breaker_open: bool
    breaker_reason: str | None
    epoch: str | None  # current epoch for THIS reader/projector version
    journal_errors: int
    journal_head: str


def reader_state(store: Store) -> ReaderState:
    view = reader_journal(store).read()
    mode = MODE_NATIVE
    breaker_open = False
    breaker_reason: str | None = None
    epoch: str | None = None
    for entry in view.entries:
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
    forced = force_native_active(store)
    return ReaderState(
        mode=MODE_NATIVE if forced else mode,
        configured_mode=mode,
        forced_native=forced,
        breaker_open=breaker_open,
        breaker_reason=breaker_reason,
        epoch=epoch,
        journal_errors=view.errors,
        journal_head=view.head,
    )


def _new_epoch_reset(reason: str) -> EpochReset:
    return EpochReset(
        epoch=f"epoch-{uuid.uuid4().hex[:8]}",
        reason=reason,
        reader_version=READER_VERSION,
        projector_ref=PROJECTOR_REF,
        at=now_iso(),
    )


def ensure_epoch(store: Store) -> str:
    """The current burn-in epoch, opening a new one when none matches this
    build's reader/projector versions."""
    state = reader_state(store)
    if state.epoch is not None:
        return state.epoch
    reset = _new_epoch_reset("opened for current reader/projector versions")
    reader_journal(store).append_batch([reset])
    return reset.epoch


def reset_epoch(store: Store, reason: str) -> str:
    reset = _new_epoch_reset(reason)
    reader_journal(store).append_batch([reset])
    return reset.epoch


def repair_control_update(mirror_path: Path, task_id: str, detail: str) -> None:
    """Called by dual-write repair/rebuild: derived history changed, so the
    epoch MUST reset, and an active canary MUST be disabled (breaker opened)
    in the same atomic batch. Raises on failure — never best-effort."""
    journal = ReaderJournal(
        mirror_path.with_name(f"{task_id}.reader.jsonl"), task_id
    )
    view = journal.read()
    mode = MODE_NATIVE
    for entry in view.entries:
        if isinstance(entry, ModeChange):
            mode = entry.mode
    batch: list[ReaderEntry] = []
    if mode == MODE_CANARY:
        batch.append(
            BreakerEvent(
                state="open",
                reason=f"derived history changed by repair: {detail}",
                at=now_iso(),
            )
        )
    batch.append(_new_epoch_reset(f"repair: {detail}"))
    journal.append_batch(batch)  # ReaderError propagates: repair fails closed


def set_mode(store: Store, mode: str, reason: str) -> None:
    """Journal a native/shadow mode change with an expected-head check.
    Entering shadow starts a NEW burn-in epoch (evidence gathered under a
    different mode never counts). Canary requires `enable_canary`."""
    if mode not in (MODE_NATIVE, MODE_SHADOW):
        raise ReaderError(
            f"set_mode accepts native|shadow; canary requires enable_canary "
            f"(got {mode!r})"
        )
    journal = reader_journal(store)
    head = journal.read().head
    batch: list[ReaderEntry] = []
    if mode == MODE_SHADOW:
        batch.append(_new_epoch_reset("shadow burn-in entered"))
    batch.append(
        ModeChange(mode=mode, reason=reason, at=now_iso(), authorized_head=head)
    )
    journal.append_batch(batch, expected_head=head)


def kill_switch(store: Store, reason: str = "kill switch") -> None:
    """Immediate, unconditional return to native reads. If even the journal
    append fails, the force-native sentinel is written — the kill path does
    not depend on a healthy reader journal."""
    try:
        reader_journal(store).append_batch(
            [ModeChange(mode=MODE_NATIVE, reason=reason, at=now_iso())]
        )
    except Exception:  # noqa: BLE001 — the kill path must always succeed
        force_native(store, f"kill switch fallback: {reason}")


def enable_canary(store: Store) -> "CutoverEligibility":
    """Enable revision-canary mode: requires no force-native override, a
    closed breaker, and current-epoch eligibility. The transition uses an
    expected reader-journal head and persists the eligibility proof it
    authorized."""
    journal = reader_journal(store)
    head = journal.read().head  # read the head FIRST; append checks it
    state = reader_state(store)
    if state.forced_native:
        raise ReaderError(
            "force-native override is active; lift it before enabling the canary"
        )
    if state.breaker_open:
        raise ReaderError(
            f"circuit breaker is open ({state.breaker_reason}); repair the "
            "derived state and clear the breaker before enabling the canary"
        )
    verdict = cutover_eligibility(store)
    if not verdict.eligible:
        raise ReaderError(
            "canary enablement refused; current-epoch eligibility not met: "
            + "; ".join(verdict.reasons)
        )
    proof = (
        f"epoch={verdict.epoch} agreed={verdict.coverage.agreed} "
        f"diverged=0 missing=0 unavailable=0 parity=complete "
        f"facts={len(verdict.coverage.facts)}"
    )
    journal.append_batch(
        [
            ModeChange(
                mode=MODE_CANARY,
                reason="eligibility met",
                at=now_iso(),
                authorized_head=head,
                proof=proof,
            )
        ],
        expected_head=head,
    )
    return verdict


def open_breaker(store: Store, reason: str) -> None:
    reader_journal(store).append_batch(
        [BreakerEvent(state="open", reason=reason, at=now_iso())]
    )


def clear_breaker(store: Store, reason: str) -> None:
    """Close the breaker — only from native/shadow mode, with complete
    parity, and a FRESH epoch (reset after the breaker opened). Clearing
    never reactivates a canary: enablement is a separate, eligibility-gated
    transition."""
    journal = reader_journal(store)
    head = journal.read().head
    state = reader_state(store)
    if state.configured_mode == MODE_CANARY:
        raise ReaderError(
            "clear-breaker requires native or shadow mode; kill the canary first"
        )
    if not state.breaker_open:
        raise ReaderError("the breaker is not open")
    try:
        if not parity_status(store).complete:
            raise ReaderError(
                "clear-breaker requires complete mirror parity; repair first"
            )
    except ReaderError:
        raise
    except Exception as exc:  # noqa: BLE001 — unverifiable parity fails closed
        raise ReaderError(f"clear-breaker: parity cannot be verified: {exc}") from None
    view = journal.read()
    last_open = -1
    last_epoch = -1
    for index, entry in enumerate(view.entries):
        if isinstance(entry, BreakerEvent) and entry.state == "open":
            last_open = index
        elif isinstance(entry, EpochReset) and (
            entry.reader_version == READER_VERSION
            and entry.projector_ref == PROJECTOR_REF
        ):
            last_epoch = index
    if last_epoch < last_open:
        raise ReaderError(
            "clear-breaker requires a FRESH epoch opened after the breaker; "
            "run the repair (which resets the epoch) or reset it explicitly"
        )
    journal.append_batch(
        [
            BreakerEvent(
                state="cleared",
                reason=reason,
                at=now_iso(),
                authorized_head=head,
                proof=f"mode={state.configured_mode} parity=complete epoch={state.epoch}",
            )
        ],
        expected_head=head,
    )


def quarantine_reader_journal(store: Store, reason: str) -> str | None:
    """Operator recovery for a corrupt reader journal: preserve it
    byte-for-byte at a quarantine path and start fresh (native mode, new
    epoch). Returns the quarantine path."""
    journal = reader_journal(store)
    with journal.locked():
        quarantine: str | None = None
        if journal.path.exists():
            target = journal.path.with_name(
                journal.path.name + f".quarantine-{now_iso().replace(':', '')}"
            )
            journal.path.rename(target)
            quarantine = str(target)
    journal.append_batch(
        [
            _new_epoch_reset(f"reader journal quarantined: {reason}"),
            ModeChange(
                mode=MODE_NATIVE,
                reason=f"journal quarantined: {reason}",
                at=now_iso(),
            ),
        ]
    )
    return quarantine


# -- the verified revision snapshot (the ONLY revision-read validator) ------------------------


@dataclass(frozen=True)
class VerifiedRevisionSnapshot:
    """Revision-derived state verified to parity grade, or the reason it is
    unavailable. When unavailable, no active revision is reported."""

    available: bool
    reason: str
    revisions: dict[str, HarnessRevision] = dc_field(default_factory=dict)
    activations: tuple[RevisionActivation, ...] = ()  # source activation order
    sources: dict[str, tuple[str, str]] = dc_field(default_factory=dict)
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
    exception into the canonical operation. Callers holding a coherent
    capture pass it in; otherwise a fresh coherent capture is taken."""
    try:
        if source is None or mirror_entries is None:
            raw, entries = store.entries_with_bytes()
            source = snapshot_of(store.task_id, entries, raw)
            mirror_entries = store.mirror.entries()
        return _verify(store, source, mirror_entries)
    except MirrorError as exc:
        return _unavailable(f"mirror journal unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001 — derived failure is data
        return _unavailable(
            f"unexpected derived-state failure: {type(exc).__name__}: {exc}"
        )


def _verify(
    store: Store,
    snapshot: SourceSnapshot,
    mirror_entries: Sequence[object],
) -> VerifiedRevisionSnapshot:
    entries = list(mirror_entries)
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


# -- execution + retention provenance (honest evaluated subjects) ------------------------------

SUBJECT_ACTIVE_REVISION = "active-revision"
SUBJECT_RETAINED_REVISION = "retained-revision"
SUBJECT_CANDIDATE_OVERLAY = "candidate-overlay"


@register("execution-record", 1)
@dataclass(frozen=True)
class ExecutionRecord:
    """Provenance for ONE artifact execution, pinned before it runs.
    `base_resolved_ref` names the resolved harness the execution ran under
    (the ACTIVE baseline revision with its OWN bindings); the evaluated
    subject is named separately with its own effective manifest."""

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


@register("retention-record", 1)
@dataclass(frozen=True)
class RetentionRecord:
    """Durable linkage from retention back to the EXACT evaluated candidate:
    the overlay revision that was evaluated, the decision evidence, and the
    retained generation/revision ids. The retained mirror must be
    content-identical to the overlay (same deltas, same scope manifest) —
    verified as the retained-candidate check, never assumed."""

    candidate_id: str
    overlay_revision_ref: str  # CAS ref of the EVALUATED candidate revision
    retained_generation_id: str
    retained_revision_id: str
    decision_ref: str  # CAS ref of the decision evidence
    op_id: str
    at: str
    run_id: str | None = None


@dataclass(frozen=True)
class CandidateSubject:
    """An immutable, unactivated candidate revision created and validated
    BEFORE its evaluation, in every mode: the exact evaluated artifact."""

    revision_ref: str  # CAS ref of the candidate HarnessRevision
    manifest_ref: str  # CAS ref of its ScopeManifest
    provenance_ref: str  # CAS ref of its RevisionProvenance
    source_ref: str


# -- the read boundary ------------------------------------------------------------------------


@dataclass(frozen=True)
class _Check:
    subject: str
    outcome: str
    detail: str
    mode: str  # effective mode AT CHECK TIME
    canonical_head: str  # heads AT CHECK TIME (not session end)
    mirror_head: str


class StateReader:
    """One coherent read session per operation (the harness read session).

    `finish` must run in ``finally``: it records every attempted check —
    synthesizing ``missing`` for expected checks that never ran — into the
    framed reader journal, and (in canary mode) escalates evidence-recording
    failures to the breaker. Telemetry never masks or replaces the canonical
    result."""

    # test hook: called between capture steps so deterministic concurrency
    # tests can append records at every interleaving point
    _on_capture_step: Callable[[str], None] = staticmethod(lambda step: None)

    def __init__(self, store: Store, operation: str, run_id: str | None = None) -> None:
        self.store = store
        self.operation = operation
        self.run_id = run_id
        self.op_id = f"op-{uuid.uuid4().hex[:8]}"
        self._checks: dict[str, _Check] = {}
        self._facts: set[str] = set()
        self._finished = False
        try:
            state = reader_state(store)
            self.mode = state.mode
            self.breaker_open = state.breaker_open
            journal_errors = state.journal_errors
        except ReaderError as exc:
            self.mode = MODE_NATIVE
            self.breaker_open = False
            journal_errors = 0
            store._note_diagnostic(f"reader journal unavailable: {exc}; mode=native")
        if not store.mirror_enabled:
            self.mode = MODE_NATIVE  # no derived reads at all without mirrors
        # fail-closed canary gates AT OPERATION START: journal integrity and
        # current-epoch eligibility must hold for the canary to be effective
        if self.mode == MODE_CANARY and not self.breaker_open:
            if journal_errors > 0:
                # a corrupt/tampered reader journal cannot be trusted to
                # RECORD a breaker either (unframed lines poison later
                # framed appends), so the fail-closed signal is the
                # journal-INDEPENDENT force-native override; every future
                # session recomputes journal_errors and does the same
                force_native(
                    store,
                    f"reader journal integrity: {journal_errors} bad line(s)",
                )
                self.mode = MODE_NATIVE
            else:
                verdict = cutover_eligibility(store)
                if not verdict.eligible:
                    self._open_breaker_now(
                        "current epoch is no longer eligible: "
                        + "; ".join(verdict.reasons[:3])
                    )
        self._capture()

    # an open breaker blocks canary use durably — reads revert to native
    # authority with comparisons still recorded (shadow), never silently
    @property
    def effective_mode(self) -> str:
        if self.mode == MODE_CANARY and self.breaker_open:
            return MODE_SHADOW
        return self.mode

    def _open_breaker_now(self, reason: str) -> None:
        try:
            open_breaker(self.store, reason)
        except Exception as exc:  # noqa: BLE001 — last-resort independent kill
            force_native(self.store, f"breaker journaling failed: {exc}")
            self.store._note_diagnostic(
                f"breaker journaling failed ({exc}); force-native engaged"
            )
        self.breaker_open = True

    # -- coherent snapshot -----------------------------------------------------

    def _capture(self) -> None:
        """One coherent capture: canonical entries/bytes are read once (the
        native view and SourceSnapshot derive from that exact read); the
        mirror capture is paired via an optimistic read-recheck loop so an
        old canonical capture is never combined with a newer mirror capture."""
        raw, entries = self.store.entries_with_bytes()
        self._on_capture_step("canonical")
        self._entries = entries
        self.canonical_head = ledger_head(entries)
        self.mirror_head = "unread"
        self._snapshot: VerifiedRevisionSnapshot = _unavailable(
            "not captured in native mode"
        )
        if self.effective_mode == MODE_NATIVE:
            return
        for _attempt in range(5):
            try:
                mirror_raw, mirror_entries = self.store.mirror.entries_with_bytes()
            except (MirrorError, OSError) as exc:
                self.mirror_head = "unavailable"
                self._snapshot = _unavailable(f"mirror journal unavailable: {exc}")
                return
            self._on_capture_step("mirror")
            recheck = (
                self.store.ledger_path.read_bytes()
                if self.store.ledger_path.exists()
                else b""
            )
            self._on_capture_step("recheck")
            if recheck == raw:
                self.mirror_head = (
                    f"{len(mirror_entries)}:{hashlib.sha256(mirror_raw).hexdigest()}"
                )
                source = snapshot_of(self.store.task_id, entries, raw)
                self._snapshot = verify_revision_snapshot(
                    self.store, source, mirror_entries
                )
                return
            # the canonical journal moved while we read the mirror: retake
            # BOTH captures — never pair an old native view with a new mirror
            raw, entries = self.store.entries_with_bytes()
            self._on_capture_step("canonical")
            self._entries = entries
            self.canonical_head = ledger_head(entries)
        self.mirror_head = "torn"
        self._snapshot = _unavailable(
            "coherent capture failed: concurrent writers kept moving the "
            "canonical journal during the mirror read"
        )

    def refresh(self) -> None:
        """Re-capture — legal only after this operation's own writes (plus
        the one documented staleness re-read)."""
        self._capture()

    def recheck_active_for_staleness(self) -> Generation | None:
        """The proposal-staleness re-read: deliberately re-captures to observe
        concurrent writers before a candidate is accepted against a superseded
        incumbent."""
        self.refresh()
        return derive_active_generation(self._entries)

    # -- native view internals (compatibility derivations over the capture) ----

    def ledger_entries(self) -> list[LedgerEntry]:
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
        """Exactly one terminal outcome per (op_id, subject): repeated
        contributions merge by severity, capturing mode and heads at check
        time."""
        check = _Check(
            subject=subject,
            outcome=outcome,
            detail=detail,
            mode=self.effective_mode,
            canonical_head=self.canonical_head,
            mirror_head=self.mirror_head,
        )
        current = self._checks.get(subject)
        if current is None or _SEVERITY[outcome] >= _SEVERITY[current.outcome]:
            self._checks[subject] = check

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
        """The strategy source that will actually execute. Native mode serves
        the generation-native text. Shadow compares and serves native. The
        canary serves the revision-materialized text after comparison; a
        missing or divergent derived source records its outcome and (in
        canary) opens the breaker — there is NO silent derived→native path."""
        native_text = self.store.objects.get_text(generation.source_ref)
        if self.effective_mode == MODE_NATIVE:
            return native_text
        derived = self._derived_source(generation, overlay)
        if derived is None:
            self._handle_unavailable(
                subject,
                f"revision-derived source for {generation.generation_id} is "
                "unavailable at execution time",
            )
            return native_text  # loud: recorded + breaker in canary
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
        """Pair the EPHEMERAL evaluation subject (the unactivated candidate)
        with its overlay revision: the whole revision must decode and
        validate, and its manifest must bind the exact evaluated artifact."""
        if self.effective_mode == MODE_NATIVE:
            self._add(subject, OUTCOME_NATIVE, "comparison off")
            return
        try:
            revision: HarnessRevision = codec.loads(
                self.store.objects.get_text(overlay.revision_ref), HarnessRevision
            )
            from strive.revisions import validate_revision

            validate_revision(revision)  # the WHOLE revision, not one binding
            manifest: ScopeManifest = codec.loads(
                self.store.objects.get_text(overlay.manifest_ref), ScopeManifest
            )
            if revision.scope_manifest_ref != overlay.manifest_ref:
                self._handle_divergence(
                    subject, "candidate overlay revision names a different manifest"
                )
                return
        except (ObjectMissing, ObjectCorruption, codec.SchemaError,
                ContractViolation) as exc:
            self._handle_unavailable(subject, f"candidate overlay: {exc}")
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

    def overlay_failure(self, subject: str, reason: str) -> None:
        """Candidate-overlay construction failed: recorded, and (in canary)
        the breaker opens BEFORE any execution — never a silent native path."""
        self._handle_unavailable(subject, f"candidate overlay creation failed: {reason}")

    def check_retained_matches_overlay(
        self, subject: str, overlay: CandidateSubject, retained: Generation
    ) -> None:
        """The retained (mirrored) revision must serve the EXACT evaluated
        candidate's strategy artifact. The mirror is a strategy-only
        compatibility projection: a composite overlay's non-code surfaces
        live in the native lifecycle (which retains the whole revision by
        content-addressed identity), so the mirror comparison pins the
        strategy binding — never a disconnected replacement artifact."""
        if self.effective_mode == MODE_NATIVE:
            self._add(subject, OUTCOME_NATIVE, "comparison off")
            return
        try:
            manifest: ScopeManifest = codec.loads(
                self.store.objects.get_text(overlay.manifest_ref), ScopeManifest
            )
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            self._handle_unavailable(subject, f"overlay manifest: {exc}")
            return
        overlay_strategy = next(
            (
                b.binding.content_ref
                for b in manifest.bindings
                if (b.kind, b.name) == _SURFACE_KEY
            ),
            None,
        )
        if not self._snapshot.available:
            self._handle_unavailable(subject, self._snapshot.reason)
            return
        mirrored_id = _rev_id(retained.generation_id)
        if mirrored_id not in self._snapshot.revisions:
            self._handle_divergence(
                subject, f"no revision mirror for {retained.generation_id}"
            )
            return
        mirrored_ref, _text = self._snapshot.sources[mirrored_id]
        if overlay_strategy is None or mirrored_ref != overlay_strategy:
            self._handle_divergence(
                subject,
                f"retained revision {mirrored_id} does not serve the evaluated "
                "candidate's strategy artifact",
            )
            return
        self._add(subject, OUTCOME_AGREED, mirrored_id)

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
        self._open_breaker_now(reason)

    # -- facts + execution/retention provenance -----------------------------------

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
        it runs."""
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
                # an ephemeral probe with no overlay: still named honestly as
                # a candidate, never as a retained revision
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
            self._telemetry_failure(f"execution record failed: {exc}")
            if events is not None:
                self._emit(
                    events,
                    "execution_record",
                    subject=subject,
                    generation_id=generation.generation_id,
                    execution_record_ref=None,
                    reason=f"{type(exc).__name__}: {exc}",
                )
            return None
        if events is not None:
            self._emit(
                events,
                "execution_record",
                subject=subject,
                generation_id=generation.generation_id,
                subject_kind=record.subject_kind,
                execution_record_ref=ref,
            )
        return ref

    def record_retention(
        self,
        candidate_id: str,
        overlay: CandidateSubject,
        retained: Generation,
        decision: Decision,
        events: EventLog | None,
    ) -> str | None:
        """Durable linkage: retention references the EXACT evaluated candidate
        revision and its decision evidence."""
        try:
            decision_ref = self.store.objects.put_text(codec.dumps(decision))
            record = RetentionRecord(
                candidate_id=candidate_id,
                overlay_revision_ref=overlay.revision_ref,
                retained_generation_id=retained.generation_id,
                retained_revision_id=_rev_id(retained.generation_id),
                decision_ref=decision_ref,
                op_id=self.op_id,
                at=now_iso(),
                run_id=self.run_id,
            )
            ref = self.store.objects.put_text(codec.dumps(record))
        except Exception as exc:  # noqa: BLE001
            self._telemetry_failure(f"retention record failed: {exc}")
            return None
        if events is not None:
            self._emit(
                events,
                "retention_record",
                candidate_id=candidate_id,
                retained_generation_id=retained.generation_id,
                overlay_revision_ref=overlay.revision_ref,
                retention_record_ref=ref,
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
        parent_revision_id: str | None = None,
    ) -> CandidateSubject | None:
        """Create and VALIDATE the immutable, unactivated candidate revision +
        manifest + provenance BEFORE evaluation — in every mode (construction
        depends only on native state, not on the derived snapshot).

        ``parent_revision_id`` pins the base parent explicitly (the native
        lifecycle's active revision id); when omitted it defaults to the
        generation-derived id, so callers without the lifecycle keep working."""
        try:
            active = derive_active_generation(self._entries)
            if active is None:
                return None
            parent_id = (
                parent_revision_id
                if parent_revision_id is not None
                else _rev_id(active.generation_id)
            )
            scope = ScopeRef(LEVEL_TASK, self.store.task_id)
            manifest = canonical_scope_manifest(self.store.task_id, source_ref)
            manifest_ref = self.store.objects.put_text(codec.dumps(manifest))
            provenance = RevisionProvenance(
                origin="candidate-overlay",
                task_id=self.store.task_id,
                task_fingerprint=task_fingerprint,
                surface=_SURFACE_KEY[0],
                weakness_id=weakness_id,
                parent_revision_id=parent_id,
                decision_ref=None,
            )
            provenance_ref = self.store.objects.put_text(codec.dumps(provenance))
            revision = candidate_overlay_revision(
                candidate_id=candidate_id,
                task_id=self.store.task_id,
                source_ref=source_ref,
                parent_revision_ref=RevisionRef(scope, parent_id),
                parent_source_ref=active.source_ref,
                scope_manifest_ref=manifest_ref,
                provenance_ref=provenance_ref,
                proposer=proposer,
                summary=summary,
                created_at=now_iso(),
            )  # validate_revision inside: the WHOLE revision is validated
            revision_ref = self.store.objects.put_text(codec.dumps(revision))
            return CandidateSubject(
                revision_ref=revision_ref,
                manifest_ref=manifest_ref,
                provenance_ref=provenance_ref,
                source_ref=source_ref,
            )
        except (ContractViolation, ObjectMissing, ObjectCorruption, OSError):
            return None

    # -- durable recording (must run in `finally`) --------------------------------

    def _emit(self, events: EventLog, event_type: str, **payload: object) -> None:
        """Run-event emission with canary escalation: telemetry failure never
        masks the canonical result, and in canary it opens the breaker."""
        try:
            events.emit(event_type, **payload)
        except Exception as exc:  # noqa: BLE001
            self._telemetry_failure(f"run-event {event_type!r} failed: {exc}")

    def _telemetry_failure(self, detail: str) -> None:
        self.store._note_diagnostic(detail)
        if self.mode == MODE_CANARY and not self.breaker_open:
            self._open_breaker_now(f"telemetry failure in canary: {detail}")

    def finish(self, events: EventLog | None = None, status: str = "ok") -> None:
        """Record every attempted check and the operation summary — one
        terminal outcome per expected subject, with `missing` synthesized for
        subjects that never ran (including on denied/rejected/stale/failing
        operations). Idempotent; never raises into the caller."""
        if self._finished:
            return
        self._finished = True
        if not self.store.mirror_enabled:
            return  # a mirror-disabled store records no derived state at all
        try:
            epoch = ensure_epoch(self.store)
            for subject in OPERATION_SUBJECTS.get(self.operation, ()):
                if subject not in self._checks:
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
                    mode=check.mode,  # at check time, not session end
                    outcome=check.outcome,
                    detail=check.detail,
                    canonical_head=check.canonical_head,
                    mirror_head=check.mirror_head,
                    reader_version=READER_VERSION,
                    projector_ref=PROJECTOR_REF,
                    at=at,
                    run_id=self.run_id,
                )
                for check in self._checks.values()
            ]
            rows.append(
                OperationSummary(
                    epoch=epoch,
                    op_id=self.op_id,
                    operation=self.operation,
                    mode=self.mode,
                    status=status,
                    facts=tuple(sorted(self._facts)),
                    at=at,
                    run_id=self.run_id,
                )
            )
            reader_journal(self.store).append_batch(rows)
        except Exception as exc:  # noqa: BLE001 — evidence loss is loud but
            self._telemetry_failure(  # never a canonical failure
                f"reader evidence recording failed: {exc}"
            )
            return
        if events is not None:
            for check in self._checks.values():
                self._emit(
                    events,
                    "read_check",
                    subject=check.subject,
                    outcome=check.outcome,
                    detail=check.detail,
                    mode=check.mode,
                )


# alias: the goal-facing name for the session
HarnessReadSession = StateReader


# -- coverage + cutover eligibility ------------------------------------------------------------


@dataclass(frozen=True)
class ReadCoverage:
    """Current-epoch evidence. Behavioral facts count only from successfully
    completed shadow/canary operations."""

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
    view = reader_journal(store).read()
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
    for entry in view.entries:
        if isinstance(entry, ReadCheck) and entry.epoch == state.epoch:
            total += 1
            if entry.outcome in counts:
                counts[entry.outcome] += 1
            subject = by_subject.setdefault(entry.subject, {})
            subject[entry.outcome] = subject.get(entry.outcome, 0) + 1
        elif (
            isinstance(entry, OperationSummary)
            and entry.epoch == state.epoch
            and entry.status == "ok"
            and entry.mode in (MODE_SHADOW, MODE_CANARY)
        ):
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
        journal_errors=view.errors,
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
    evidence only."""
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
            f"{coverage.journal_errors} unverifiable line(s) in the reader journal "
            "(corruption, tampering, or a crash-torn batch)"
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
