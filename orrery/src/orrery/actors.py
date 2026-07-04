"""Actors and policies (ADR-0002): one abstraction for every participant.

An Actor is identity + role + Policy + observation scope + RNG stream. The
agent-under-test, NPC personas, adversarial auditors, and chaos daemons are
all actors; roles are metadata for verifiers and reports, not kernel branches.

A Policy decides asynchronously. Live runs record decisions into the trace;
replays substitute them (ADR-0001) — so policies may do arbitrary I/O (e.g.
LLM calls) without breaking world determinism.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel, Field

from orrery.content import text
from orrery.events import Intent
from orrery.observe import ObservationScope
from orrery.surfaces import Observation, Surface, TextSurface


class ScheduledIntentDraft(BaseModel):
    """A future action the deciding actor commits to now (e.g. a retry)."""

    at_time: float
    intent: Intent


class Decision(BaseModel):
    """Everything a policy returns. Recorded verbatim in the trace for replay."""

    intents: list[Intent] = Field(default_factory=list)
    scheduled: list[ScheduledIntentDraft] = Field(default_factory=list)


@dataclass
class DecisionContext:
    rng: random.Random
    memory: dict[str, Any]  # actor-private scratch; live-run only, never world state


class Policy(Protocol):
    async def decide(self, obs: Observation, ctx: DecisionContext) -> Decision: ...


@dataclass
class Actor:
    id: str
    role: str  # system_under_test | population | adversary | chaos | npc
    policy: Policy
    scope: ObservationScope = field(default_factory=ObservationScope)
    surface: Surface = field(default_factory=TextSurface)
    priority: int = 0
    memory: dict[str, Any] = field(default_factory=dict)
    event_cursor: int = 0  # index into world.events: first event not yet observed
    activation_count: int = 0


# ---------------------------------------------------------------------------
# Built-in policies
# ---------------------------------------------------------------------------


class ScriptedPolicy:
    """Plays a fixed list of decisions, one per activation, then goes quiet."""

    def __init__(self, steps: list[list[dict[str, Any]]]) -> None:
        self._steps = steps

    async def decide(self, obs: Observation, ctx: DecisionContext) -> Decision:
        index = ctx.memory.setdefault("step", 0)
        if index >= len(self._steps):
            return Decision()
        ctx.memory["step"] = index + 1
        return Decision(intents=[Intent.model_validate(i) for i in self._steps[index]])


class EchoPolicy:
    """Replies to every incoming message. Useful for wiring tests."""

    def __init__(self, reply: str = "ack") -> None:
        self._reply = reply

    async def decide(self, obs: Observation, ctx: DecisionContext) -> Decision:
        intents = [
            Intent(
                kind="send_message",
                payload={
                    "to": event.payload["from"],
                    "content": [text(self._reply).model_dump()],
                },
            )
            for event in obs.view.events
            if event.kind == "message.sent"
        ]
        return Decision(intents=intents)


def register_builtin_policies(registry: Any) -> None:
    registry.policies["scripted"] = lambda params: ScriptedPolicy(params["steps"])
    registry.policies["echo"] = lambda params: EchoPolicy(params.get("reply", "ack"))
