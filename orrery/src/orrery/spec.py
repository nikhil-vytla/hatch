"""WorldSpec: the declarative IR every run executes (ADR-0006).

Specs are Pydantic models, loadable from TOML, and content-hashed — a run is
citable as (spec hash, seed, orrery version). Generators (procedural today,
LLM-backed tomorrow) emit WorldSpecs; the kernel never executes prose.
"""

from __future__ import annotations

import hashlib
import json
import tomllib
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from orrery.entities import Entity
from orrery.observe import ObservationScope


class PolicySpec(BaseModel):
    type: str  # registry key, e.g. "scripted", "support.agent", "chaos.tool_outage"
    params: dict[str, Any] = Field(default_factory=dict)


class ActorSpec(BaseModel):
    id: str
    role: str = "npc"  # system_under_test | population | adversary | chaos | npc
    policy: PolicySpec
    scope: ObservationScope = Field(default_factory=ObservationScope)
    priority: int = 0  # lower runs first among simultaneous activations
    activate_at: list[float] = Field(default_factory=list)  # initial wake-ups


class TimelineEntry(BaseModel):
    """A world event injected by the spec itself at a fixed virtual time."""

    at: float
    intent: str
    payload: dict[str, Any] = Field(default_factory=dict)
    as_actor: str = "timeline"


class ReactionRule(BaseModel):
    """Event-driven activation: 'when X happens, wake actor Y after delay'."""

    on_kind: str
    activate: str
    delay: float = 0.1
    only_if_addressed: bool = True  # require event payload["to"] == activate
    priority: int = 0


class ContractItem(BaseModel):
    name: str
    kind: Literal["invariant", "objective"] = "invariant"
    verifier: str  # verifier factory registry key
    params: dict[str, Any] = Field(default_factory=dict)


class WorldSpec(BaseModel):
    name: str
    description: str = ""
    uses: list[str] = Field(default_factory=list)  # modules registering domain rules
    horizon: float = 100.0  # virtual end time
    max_activations: int = 1000  # runaway guard
    entities: list[Entity] = Field(default_factory=list)
    actors: list[ActorSpec] = Field(default_factory=list)
    timeline: list[TimelineEntry] = Field(default_factory=list)
    reactions: list[ReactionRule] = Field(default_factory=list)
    contract: list[ContractItem] = Field(default_factory=list)

    def spec_hash(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()

    @classmethod
    def from_toml(cls, path: Path) -> WorldSpec:
        with path.open("rb") as fh:
            return cls.model_validate(tomllib.load(fh))
