"""Durable, append-only store: per-task ledger journals + shared
content-addressed objects.

Layout under the artifacts root:

    ledger/<task_id>.jsonl   append-only journal, one per task
    ledger/<task_id>.lock    advisory lock file for mutating operations
    objects/<aa>/<sha256>    content-addressed sources and artifacts (shared)
    runs/<run_id>/events.jsonl

Task isolation: a Store is bound to one task; every generation records its
task id and task fingerprint, every activation records its task id, and each
task has its own journal file — so a generation of one task can never become
another task's incumbent, mechanically.

Durability and atomicity model:
- every append is a single ``write()`` of one complete line followed by fsync;
- the active generation is *derived* from the last activation entry, so
  promotion is atomic-by-construction;
- a torn final line (crash mid-append) is tolerated on read and surfaced as a
  diagnostic; interior corruption is a loud ``LedgerError``;
- nothing is ever deleted: rollback, expiry-revert, and freeze are entries.

Concurrency: the store is designed for a single writer. As belt-and-braces
for same-host concurrent CLIs, mutating operations take an advisory ``flock``
on the task's lock file, generation-id allocation happens under that lock,
and ``activate`` accepts an ``expected_active`` head check that fails cleanly
if the incumbent changed underneath the caller. Cross-host or adversarial
concurrent writers are explicitly out of scope (see HANDOFF).
"""

from __future__ import annotations

import fcntl
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import hashlib

from strive import codec
from strive.cas import ObjectStore
from strive.dualwrite import (
    CONDITION_PARITY_INCOMPLETE,
    ActivationMirror,
    MirrorJournal,
    RevisionMirror,
    SOURCE_ACTIVATION,
    SOURCE_GENERATION,
    SourceRecordRef,
    _project_activation,
    _project_generation,
)
from strive.revisions import HarnessRevision, RevisionActivation
from strive.contracts import (
    ACTIVATION_DURABLE,
    Activation,
    CycleRecord,
    Decision,
    Generation,
    Intervention,
    INTERVENTION_RESUME,
    INTERVENTION_STALL_FREEZE,
)
from strive.events import now_iso

LedgerEntry = Generation | Activation | CycleRecord | Intervention


# -- pure derivations over an entries list ----------------------------------------------
#
# The Stage-3B.2 read boundary (strive.reader.StateReader) captures one
# coherent entries snapshot per operation and derives state from it with the
# SAME functions the Store uses, so a reader value can never disagree with a
# store value for the same entries. Store methods delegate here and remain
# available as compatibility internals.


def entry_digest(entry: LedgerEntry) -> str:
    """The canonical per-record digest (identical to the dual-write mirror's
    SourceRecordRef digest)."""
    return hashlib.sha256(codec.dumps(entry).encode("utf-8")).hexdigest()


def ledger_head(entries: list[LedgerEntry]) -> str:
    """Tamper-evident head token: complete-record count + the hash of the
    canonical per-record digest sequence. Appends change the count; altering
    any covered record changes the digest."""
    h = hashlib.sha256()
    for entry in entries:
        h.update(bytes.fromhex(entry_digest(entry)))
    return f"{len(entries)}:{h.hexdigest()}"


def derive_generations(entries: list[LedgerEntry]) -> dict[str, Generation]:
    return {e.generation_id: e for e in entries if isinstance(e, Generation)}


def derive_activations(entries: list[LedgerEntry]) -> list[Activation]:
    return [e for e in entries if isinstance(e, Activation)]


def derive_active_activation(entries: list[LedgerEntry]) -> Activation | None:
    activation: Activation | None = None
    for entry in entries:
        if isinstance(entry, Activation):
            activation = entry
    return activation


def derive_active_generation(entries: list[LedgerEntry]) -> Generation | None:
    activation = derive_active_activation(entries)
    if activation is None:
        return None
    generation = derive_generations(entries).get(activation.generation_id)
    if generation is None:
        raise LedgerError(
            f"activation targets unknown generation {activation.generation_id}"
        )
    return generation


def derive_lineage(entries: list[LedgerEntry]) -> list[Generation]:
    generations = derive_generations(entries)
    chain: list[Generation] = []
    current = derive_active_generation(entries)
    while current is not None:
        chain.append(current)
        current = (
            generations[current.parent_id]
            if current.parent_id is not None
            else None
        )
    return chain


def derive_cycles(entries: list[LedgerEntry]) -> list[CycleRecord]:
    return [e for e in entries if isinstance(e, CycleRecord)]


def derive_interventions(entries: list[LedgerEntry]) -> list[Intervention]:
    return [e for e in entries if isinstance(e, Intervention)]


def derive_adaptation_frozen(entries: list[LedgerEntry]) -> Intervention | None:
    current: Intervention | None = None
    for entry in derive_interventions(entries):
        if entry.kind == INTERVENTION_STALL_FREEZE:
            current = entry
        elif entry.kind == INTERVENTION_RESUME:
            current = None
    return current


def derive_activation_before(
    entries: list[LedgerEntry], activation: Activation
) -> Activation | None:
    previous: Activation | None = None
    for entry in entries:
        if isinstance(entry, Activation):
            if (
                entry.at == activation.at
                and entry.generation_id == activation.generation_id
                and entry.mode == activation.mode
            ):
                return previous
            previous = entry
    return None


def derive_cycles_since_activation(
    entries: list[LedgerEntry], activation: Activation
) -> list[CycleRecord]:
    result: list[CycleRecord] = []
    seen_activation = False
    for entry in entries:
        if entry is activation or (
            isinstance(entry, Activation)
            and entry.at == activation.at
            and entry.generation_id == activation.generation_id
        ):
            seen_activation = True
            result = []
            continue
        if seen_activation and isinstance(entry, CycleRecord):
            result.append(entry)
    return result


class StoreError(Exception):
    """A store-level failure the CLI can render as a clean diagnostic."""


class LedgerError(StoreError):
    """Interior ledger corruption or schema mismatch (loud, non-recoverable)."""


class LegacyLedgerError(StoreError):
    """A stage-2a `ledger/ledger.jsonl` exists but has not been migrated."""


LEGACY_LEDGER_NAME = "ledger.jsonl"


class Store:
    def __init__(self, root: Path, task_id: str, *, mirror_enabled: bool = True) -> None:
        self.root = root
        self.task_id = task_id
        self.ledger_path = root / "ledger" / f"{task_id}.jsonl"
        self._lock_path = root / "ledger" / f"{task_id}.lock"
        self.runs_dir = root / "runs"
        self.objects = ObjectStore(root / "objects")
        # derived, isolated mirror journal (Stage 3B); its corruption can
        # never block generation-native operations
        self.mirror = MirrorJournal(
            root / "ledger" / f"{task_id}.mirror.jsonl", task_id
        )
        self.mirror_enabled = mirror_enabled
        # derived shadow-check coverage journal (Stage 3B.1) — telemetry for
        # the read-parity coverage report; never blocks canonical operations
        self.shadow_path = root / "ledger" / f"{task_id}.shadow.jsonl"
        for directory in (self.ledger_path.parent, self.runs_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.diagnostics: list[str] = []
        legacy = root / "ledger" / LEGACY_LEDGER_NAME
        if legacy.exists():
            if self.ledger_path.exists():
                self._note_diagnostic(
                    f"legacy ledger {legacy} is present alongside the task ledger; "
                    "assuming it was already migrated (original preserved)"
                )
            else:
                # old history must never be silently ignored
                raise LegacyLedgerError(
                    f"a stage-2a legacy ledger exists at {legacy} and has not "
                    f"been migrated for task {task_id!r}. Run "
                    f"`strive --artifacts {root} --task {task_id} migrate-legacy` "
                    "to convert it to the task-scoped format (the original file "
                    "is preserved), then retry."
                )

    # -- locking ------------------------------------------------------------------

    @contextmanager
    def _writer_lock(self) -> Iterator[None]:
        with self._lock_path.open("a") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    # -- journal ---------------------------------------------------------------

    def _append_unlocked(self, entry: LedgerEntry) -> None:
        line = (codec.dumps(entry) + "\n").encode("utf-8")
        with self.ledger_path.open("ab") as handle:
            handle.write(line)  # one complete line per write
            handle.flush()
            os.fsync(handle.fileno())

    def append(self, entry: LedgerEntry) -> None:
        with self._writer_lock():
            self._append_unlocked(entry)

    def entries(self) -> list[LedgerEntry]:
        if not self.ledger_path.exists():
            return []
        raw = self.ledger_path.read_bytes().decode("utf-8")
        lines = raw.split("\n")
        # A final fragment without newline is a torn append from a crash:
        # tolerated, reported, ignored. Everything else must validate.
        torn_tail = lines[-1] if lines and lines[-1].strip() and not raw.endswith("\n") else None
        complete = lines[:-1] if lines and not raw.endswith("\n") else lines
        if torn_tail is not None:
            self._note_diagnostic(
                f"ledger has a torn final line ({len(torn_tail)} bytes); "
                "ignored as a crash artifact"
            )
        entries: list[LedgerEntry] = []
        for line_no, line in enumerate(complete, start=1):
            if not line.strip():
                continue
            try:
                decoded: object = codec.loads(line)
            except codec.SchemaError as exc:
                raise LedgerError(f"{self.ledger_path}:{line_no}: {exc}") from None
            if not isinstance(decoded, (Generation, Activation, CycleRecord, Intervention)):
                raise LedgerError(
                    f"{self.ledger_path}:{line_no}: {type(decoded).__name__} "
                    "is not a ledger entry kind"
                )
            entry_task = getattr(decoded, "task_id", None)
            if entry_task is not None and entry_task != self.task_id:
                raise LedgerError(
                    f"{self.ledger_path}:{line_no}: {type(decoded).__name__} "
                    f"belongs to task {entry_task!r}, not {self.task_id!r} — "
                    "task-isolation violation in the ledger"
                )
            entries.append(decoded)
        return entries

    def _note_diagnostic(self, message: str) -> None:
        if message not in self.diagnostics:
            self.diagnostics.append(message)

    # -- generations -------------------------------------------------------------

    def generations(self) -> dict[str, Generation]:
        return derive_generations(self.entries())

    def generation(self, generation_id: str) -> Generation:
        generations = self.generations()
        if generation_id not in generations:
            raise StoreError(
                f"unknown generation for task {self.task_id!r}: {generation_id}"
            )
        record = generations[generation_id]
        if record.task_id != self.task_id:
            raise LedgerError(
                f"generation {generation_id} belongs to task {record.task_id!r}, "
                f"not {self.task_id!r} — task-isolation violation in the ledger"
            )
        return record

    def add_generation(
        self,
        source: str,
        *,
        task_fingerprint: str,
        parent_id: str | None,
        origin: str,
        surface: str,
        weakness_id: str | None,
        decision: Decision | None,
    ) -> Generation:
        with self._writer_lock():
            generation_id = f"gen-{len(self.generations()):04d}"
            record = Generation(
                generation_id=generation_id,
                task_id=self.task_id,
                task_fingerprint=task_fingerprint,
                parent_id=parent_id,
                origin=origin,
                surface=surface,
                weakness_id=weakness_id,
                created_at=now_iso(),
                source_ref=self.objects.put_text(source),
                decision=decision,
            )
            ordinal = len(self.entries())
            self._append_unlocked(record)
            self._publish_live_mirror(record, ordinal)
        return record

    def source_of(self, generation: Generation) -> str:
        return self.objects.get_text(generation.source_ref)

    # -- activation ---------------------------------------------------------------

    def activate(
        self,
        generation_id: str,
        *,
        reason: str,
        policy: str,
        mode: str = ACTIVATION_DURABLE,
        expires_after_cycles: int | None = None,
        baseline_score: float | None = None,
        expected_active: str | None = None,
        expected_head: str | None = None,
    ) -> Activation:
        """Append an activation entry (the atomic promotion step).

        ``expected_active`` is an incumbent check: when given, the activation
        is refused if the currently active generation is not the expected one
        — the caller's evidence was gathered against a superseded incumbent.
        ``expected_head`` is the stronger read-boundary check: the exact
        tamper-evident ledger head the caller's read snapshot was captured at;
        ANY intervening append (not only an activation) refuses the mutation
        as stale.
        """
        with self._writer_lock():
            self.generation(generation_id)  # must exist, and belong to this task
            if expected_head is not None:
                current_head = ledger_head(self.entries())
                if current_head != expected_head:
                    raise StoreError(
                        f"stale read head: the mutation was decided at head "
                        f"{expected_head.split(':')[0]} "
                        f"({expected_head.split(':')[1][:12]}…) but the ledger "
                        f"is now at head {current_head.split(':')[0]} "
                        f"({current_head.split(':')[1][:12]}…); re-read and retry"
                    )
            if expected_active is not None:
                current = self.active_generation()
                current_id = current.generation_id if current else None
                if current_id != expected_active:
                    raise StoreError(
                        f"activation head check failed: expected active "
                        f"{expected_active}, found {current_id}"
                    )
            activation = Activation(
                generation_id=generation_id,
                task_id=self.task_id,
                reason=reason,
                mode=mode,
                at=now_iso(),
                policy=policy,
                expires_after_cycles=expires_after_cycles,
                baseline_score=baseline_score,
            )
            ordinal = len(self.entries())
            self._append_unlocked(activation)
            self._publish_live_mirror(activation, ordinal)
        return activation

    def _publish_live_mirror(
        self, entry: Generation | Activation, ordinal: int
    ) -> None:
        """Stage-3B dual-write: publish the derived mirror AFTER its source
        record commits. Deliberately not atomic with the source append — and
        deliberately unable to fail the source operation: a publication
        failure is journaled as the explicit
        `source-committed-parity-incomplete` condition (store diagnostic,
        detectable and repairable via `strive parity`)."""
        if not self.mirror_enabled:
            return
        try:
            digest = hashlib.sha256(codec.dumps(entry).encode("utf-8")).hexdigest()
            journal = f"task:{self.task_id}"
            mirror: RevisionMirror | ActivationMirror
            if isinstance(entry, Generation):
                source = SourceRecordRef(SOURCE_GENERATION, journal, ordinal, digest)
                parent = (
                    self.generations().get(entry.parent_id)
                    if entry.parent_id is not None
                    else None
                )
                mirror, payloads = _project_generation(entry, parent, source)
                for text, _ref in payloads:
                    self.objects.put_text(text)
            else:
                source = SourceRecordRef(SOURCE_ACTIVATION, journal, ordinal, digest)
                mirror = _project_activation(entry, source)
            with self.mirror.writer_lock():
                existing = {
                    (m.source.ordinal, m.source.digest)
                    for m in self.mirror.entries()
                    if isinstance(m, (RevisionMirror, ActivationMirror))
                }
                if (ordinal, digest) not in existing:
                    self.mirror.append(mirror)
        except Exception as exc:  # noqa: BLE001 — derived-side failure is data
            self._note_diagnostic(
                f"{CONDITION_PARITY_INCOMPLETE}: mirror publication failed for "
                f"ordinal {ordinal}: {type(exc).__name__}: {exc}"
            )

    def activations(self) -> list[Activation]:
        return derive_activations(self.entries())

    def head(self) -> str:
        """Tamper-evident head of the task ledger (count + prefix digest)."""
        return ledger_head(self.entries())

    def revisions(self) -> list[HarnessRevision]:
        """Mirrored revisions, in source order (derived; may lag the ledger)."""
        mirrors = [
            m for m in self.mirror.entries() if isinstance(m, RevisionMirror)
        ]
        return [m.revision for m in sorted(mirrors, key=lambda m: m.source.ordinal)]

    def revision_activations(self) -> list[RevisionActivation]:
        """Mirrored activations, in SOURCE activation order (never mirror
        append order)."""
        mirrors = [
            m for m in self.mirror.entries() if isinstance(m, ActivationMirror)
        ]
        return [m.activation for m in sorted(mirrors, key=lambda m: m.source.ordinal)]

    def active_activation(self) -> Activation | None:
        return derive_active_activation(self.entries())

    def active_generation(self) -> Generation | None:
        activation = self.active_activation()
        if activation is None:
            return None
        return self.generation(activation.generation_id)

    def rollback(self, *, expected_head: str | None = None) -> Generation:
        """Reactivate the parent of the currently active generation (journaled).
        ``expected_head`` refuses a rollback decided against a stale read."""
        active = self.active_generation()
        if active is None:
            raise StoreError("nothing to roll back: no active generation")
        if active.parent_id is None:
            raise StoreError(f"cannot roll back: {active.generation_id} has no parent")
        parent = self.generation(active.parent_id)
        self.activate(
            parent.generation_id,
            reason="rollback",
            policy="manual",
            expected_head=expected_head,
        )
        return parent

    def lineage(self) -> list[Generation]:
        return derive_lineage(self.entries())

    # -- cycles / interventions -----------------------------------------------------

    def cycles(self) -> list[CycleRecord]:
        return derive_cycles(self.entries())

    def cycle(self, run_id: str) -> CycleRecord:
        for record in self.cycles():
            if record.run_id == run_id:
                return record
        raise StoreError(f"unknown run for task {self.task_id!r}: {run_id}")

    def interventions(self) -> list[Intervention]:
        return derive_interventions(self.entries())

    def adaptation_frozen(self) -> Intervention | None:
        """The freeze in force, if any: last stall-freeze not followed by resume."""
        return derive_adaptation_frozen(self.entries())

    def activation_before(self, activation: Activation) -> Activation | None:
        """The activation entry immediately preceding the given one, if any."""
        return derive_activation_before(self.entries(), activation)

    def cycles_since_activation(self, activation: Activation) -> list[CycleRecord]:
        """Cycle records executed under the given activation (by time order)."""
        return derive_cycles_since_activation(self.entries(), activation)
