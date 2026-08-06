"""Durable, append-only store: ledger journal + content-addressed objects.

Layout under the artifacts root:

    ledger/ledger.jsonl    append-only journal (generation/activation/cycle/intervention)
    objects/<aa>/<sha256>  content-addressed strategy sources and large outputs
    runs/<run_id>/events.jsonl

Durability and atomicity model:
- every append is a single ``write()`` of one complete line followed by fsync;
- the active generation is *derived* from the last activation entry, so
  promotion is atomic-by-construction: it becomes real exactly when its one
  activation line is durably appended, and a crash before that line leaves the
  previous activation in force;
- a torn final line (crash mid-append) is tolerated on read and surfaced as a
  diagnostic — it is the expected crash artifact of an append-only journal;
- any *interior* corruption or schema mismatch is a loud ``LedgerError``:
  history is append-only and validated, never guessed at;
- nothing is ever deleted: rollback, expiry-revert, and freeze are entries.
"""

from __future__ import annotations

import os
from pathlib import Path

from strive import codec
from strive.cas import ObjectStore
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


class StoreError(Exception):
    """A store-level failure the CLI can render as a clean diagnostic."""


class LedgerError(StoreError):
    """Interior ledger corruption or schema mismatch (loud, non-recoverable)."""


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.ledger_path = root / "ledger" / "ledger.jsonl"
        self.runs_dir = root / "runs"
        self.objects = ObjectStore(root / "objects")
        for directory in (self.ledger_path.parent, self.runs_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self.diagnostics: list[str] = []

    # -- journal ---------------------------------------------------------------

    def append(self, entry: LedgerEntry) -> None:
        line = (codec.dumps(entry) + "\n").encode("utf-8")
        with self.ledger_path.open("ab") as handle:
            handle.write(line)  # one complete line per write
            handle.flush()
            os.fsync(handle.fileno())

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
            entries.append(decoded)
        return entries

    def _note_diagnostic(self, message: str) -> None:
        if message not in self.diagnostics:
            self.diagnostics.append(message)

    # -- generations -------------------------------------------------------------

    def generations(self) -> dict[str, Generation]:
        return {
            entry.generation_id: entry
            for entry in self.entries()
            if isinstance(entry, Generation)
        }

    def generation(self, generation_id: str) -> Generation:
        generations = self.generations()
        if generation_id not in generations:
            raise StoreError(f"unknown generation: {generation_id}")
        return generations[generation_id]

    def _next_generation_id(self) -> str:
        return f"gen-{len(self.generations()):04d}"

    def add_generation(
        self,
        source: str,
        *,
        parent_id: str | None,
        origin: str,
        surface: str,
        weakness_id: str | None,
        decision: Decision | None,
    ) -> Generation:
        record = Generation(
            generation_id=self._next_generation_id(),
            parent_id=parent_id,
            origin=origin,
            surface=surface,
            weakness_id=weakness_id,
            created_at=now_iso(),
            source_ref=self.objects.put_text(source),
            decision=decision,
        )
        self.append(record)
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
    ) -> Activation:
        self.generation(generation_id)  # must exist before activation
        activation = Activation(
            generation_id=generation_id,
            reason=reason,
            mode=mode,
            at=now_iso(),
            policy=policy,
            expires_after_cycles=expires_after_cycles,
            baseline_score=baseline_score,
        )
        self.append(activation)
        return activation

    def active_activation(self) -> Activation | None:
        activation: Activation | None = None
        for entry in self.entries():
            if isinstance(entry, Activation):
                activation = entry
        return activation

    def active_generation(self) -> Generation | None:
        activation = self.active_activation()
        if activation is None:
            return None
        return self.generation(activation.generation_id)

    def rollback(self) -> Generation:
        """Reactivate the parent of the currently active generation (journaled)."""
        active = self.active_generation()
        if active is None:
            raise StoreError("nothing to roll back: no active generation")
        if active.parent_id is None:
            raise StoreError(f"cannot roll back: {active.generation_id} has no parent")
        parent = self.generation(active.parent_id)
        self.activate(parent.generation_id, reason="rollback", policy="manual")
        return parent

    def lineage(self) -> list[Generation]:
        generations = self.generations()
        chain: list[Generation] = []
        current = self.active_generation()
        while current is not None:
            chain.append(current)
            current = (
                generations[current.parent_id]
                if current.parent_id is not None
                else None
            )
        return chain

    # -- cycles / interventions -----------------------------------------------------

    def cycles(self) -> list[CycleRecord]:
        return [e for e in self.entries() if isinstance(e, CycleRecord)]

    def cycle(self, run_id: str) -> CycleRecord:
        for record in self.cycles():
            if record.run_id == run_id:
                return record
        raise StoreError(f"unknown run: {run_id}")

    def interventions(self) -> list[Intervention]:
        return [e for e in self.entries() if isinstance(e, Intervention)]

    def adaptation_frozen(self) -> Intervention | None:
        """The freeze in force, if any: last stall-freeze not followed by resume."""
        current: Intervention | None = None
        for entry in self.interventions():
            if entry.kind == INTERVENTION_STALL_FREEZE:
                current = entry
            elif entry.kind == INTERVENTION_RESUME:
                current = None
        return current

    def activation_before(self, activation: Activation) -> Activation | None:
        """The activation entry immediately preceding the given one, if any."""
        previous: Activation | None = None
        for entry in self.entries():
            if isinstance(entry, Activation):
                if (
                    entry.at == activation.at
                    and entry.generation_id == activation.generation_id
                    and entry.mode == activation.mode
                ):
                    return previous
                previous = entry
        return None

    def cycles_since_activation(self, activation: Activation) -> list[CycleRecord]:
        """Cycle records executed under the given activation (by time order)."""
        result: list[CycleRecord] = []
        seen_activation = False
        for entry in self.entries():
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
