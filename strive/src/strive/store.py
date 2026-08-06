"""Durable, append-only store for generations, activations, and lineage.

Layout under the artifacts root:

    ledger/ledger.jsonl      append-only journal of generation + activation entries
    strategies/<gen id>.py   full source of every generation, accepted or not
    runs/<run id>/events.jsonl   structured events per loop cycle

The active generation is *derived* from the last activation entry rather than
stored in a mutable pointer file, so restart persistence is inherent and
rollback is simply a new activation entry naming an older generation. Nothing
is ever mutated or deleted; the full history stays auditable.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strive.types import Decision, GenerationRecord


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.ledger_path = root / "ledger" / "ledger.jsonl"
        self.strategies_dir = root / "strategies"
        self.runs_dir = root / "runs"
        for directory in (self.ledger_path.parent, self.strategies_dir, self.runs_dir):
            directory.mkdir(parents=True, exist_ok=True)

    # -- journal -------------------------------------------------------------

    def _append(self, entry: dict[str, Any]) -> None:
        with self.ledger_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    def entries(self) -> list[dict[str, Any]]:
        if not self.ledger_path.exists():
            return []
        with self.ledger_path.open(encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    # -- generations -----------------------------------------------------------

    def generations(self) -> dict[str, GenerationRecord]:
        records: dict[str, GenerationRecord] = {}
        for entry in self.entries():
            if entry["kind"] == "generation":
                record = GenerationRecord(
                    generation_id=entry["generation_id"],
                    parent_id=entry["parent_id"],
                    origin=entry["origin"],
                    surface=entry["surface"],
                    weakness_id=entry["weakness_id"],
                    created_at=entry["created_at"],
                    strategy_file=entry["strategy_file"],
                    decision=entry["decision"],
                )
                records[record.generation_id] = record
        return records

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
        activate: bool,
    ) -> GenerationRecord:
        generation_id = self._next_generation_id()
        strategy_file = f"{generation_id}.py"
        (self.strategies_dir / strategy_file).write_text(source, encoding="utf-8")
        record = GenerationRecord(
            generation_id=generation_id,
            parent_id=parent_id,
            origin=origin,
            surface=surface,
            weakness_id=weakness_id,
            created_at=_now(),
            strategy_file=strategy_file,
            decision=(
                {
                    "accepted": decision.accepted,
                    "reason": decision.reason,
                    "baseline_score": decision.baseline_score,
                    "candidate_score": decision.candidate_score,
                    "regressed_case_ids": list(decision.regressed_case_ids),
                }
                if decision is not None
                else {}
            ),
        )
        self._append(
            {
                "kind": "generation",
                "generation_id": record.generation_id,
                "parent_id": record.parent_id,
                "origin": record.origin,
                "surface": record.surface,
                "weakness_id": record.weakness_id,
                "created_at": record.created_at,
                "strategy_file": record.strategy_file,
                "decision": record.decision,
            }
        )
        if activate:
            self._activate(record.generation_id, reason=origin)
        return record

    # -- activation ------------------------------------------------------------

    def _activate(self, generation_id: str, reason: str) -> None:
        self._append(
            {
                "kind": "activation",
                "generation_id": generation_id,
                "reason": reason,
                "at": _now(),
            }
        )

    def active_generation(self) -> GenerationRecord | None:
        active_id: str | None = None
        for entry in self.entries():
            if entry["kind"] == "activation":
                active_id = entry["generation_id"]
        if active_id is None:
            return None
        return self.generations()[active_id]

    def strategy_path(self, record: GenerationRecord) -> Path:
        return self.strategies_dir / record.strategy_file

    def strategy_source(self, record: GenerationRecord) -> str:
        return self.strategy_path(record).read_text(encoding="utf-8")

    def rollback(self) -> GenerationRecord:
        """Reactivate the parent of the currently active generation."""
        active = self.active_generation()
        if active is None:
            raise RuntimeError("nothing to roll back: no active generation")
        if active.parent_id is None:
            raise RuntimeError(
                f"cannot roll back: {active.generation_id} has no parent"
            )
        parent = self.generations()[active.parent_id]
        self._activate(parent.generation_id, reason="rollback")
        return parent

    def lineage(self) -> list[GenerationRecord]:
        """Chain of generations from the active one back to the seed."""
        generations = self.generations()
        chain: list[GenerationRecord] = []
        current = self.active_generation()
        while current is not None:
            chain.append(current)
            current = (
                generations[current.parent_id] if current.parent_id is not None else None
            )
        return chain
