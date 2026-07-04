"""The Trace: Orrery's single canonical artifact (ADR-0001).

A trace holds the run's provenance (spec hash, seed, version), every event,
and every recorded decision. Replay consumes decisions; verifiers consume
events (+ final state); dataset export consumes (observation, decision)
pairs. The event fingerprint is a hash chain, so bit-identical replay is a
one-line assertion.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field

from orrery.actors import Decision
from orrery.events import Event, fingerprint


class TraceMeta(BaseModel):
    spec_name: str
    spec_hash: str
    seed: int
    orrery_version: str


class DecisionRecord(BaseModel):
    actor_id: str
    activation: int  # per-actor activation index; replay key
    time: float
    decision: Decision


class Trace(BaseModel):
    meta: TraceMeta
    events: list[Event] = Field(default_factory=list)
    decisions: list[DecisionRecord] = Field(default_factory=list)
    final_state: dict = Field(default_factory=dict)

    @property
    def event_fingerprint(self) -> str:
        return fingerprint(self.events)

    def decision_map(self) -> dict[tuple[str, int], Decision]:
        return {(d.actor_id, d.activation): d.decision for d in self.decisions}

    # -- persistence (JSONL: one meta line, then event/decision/state lines) --

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as fh:
            fh.write(json.dumps({"type": "meta", "data": self.meta.model_dump(mode="json")}) + "\n")
            for event in self.events:
                fh.write(
                    json.dumps({"type": "event", "data": event.model_dump(mode="json")}) + "\n"
                )
            for record in self.decisions:
                fh.write(
                    json.dumps({"type": "decision", "data": record.model_dump(mode="json")}) + "\n"
                )
            fh.write(json.dumps({"type": "final_state", "data": self.final_state}) + "\n")

    @classmethod
    def read(cls, path: Path) -> Trace:
        meta: TraceMeta | None = None
        events: list[Event] = []
        decisions: list[DecisionRecord] = []
        final_state: dict = {}
        with path.open() as fh:
            for line in fh:
                record = json.loads(line)
                match record["type"]:
                    case "meta":
                        meta = TraceMeta.model_validate(record["data"])
                    case "event":
                        events.append(Event.model_validate(record["data"]))
                    case "decision":
                        decisions.append(DecisionRecord.model_validate(record["data"]))
                    case "final_state":
                        final_state = record["data"]
        if meta is None:
            raise ValueError(f"trace file {path} has no meta record")
        return cls(meta=meta, events=events, decisions=decisions, final_state=final_state)
