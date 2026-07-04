"""The world: entity store + mechanics + reducers (ADR-0001, ADR-0002).

- A **mechanic** validates an intent against current state and emits events.
  Mechanics may draw randomness only from the named stream they are handed.
- A **reducer** folds one event into the entity store. Reducers do no I/O and
  draw no randomness — they must be replayable folds.
- **Tools** are simulated capabilities (kind="tool" entities carry their
  availability state, so chaos perturbations propagate through ordinary world
  rules rather than special cases).
"""

from __future__ import annotations

import random
from collections.abc import Callable
from typing import Any

from orrery.entities import Entity, EntityStore
from orrery.events import Event, Intent
from orrery.ids import SeqCounter
from orrery.rng import RngRegistry

ToolFn = Callable[[EntityStore, dict[str, Any], random.Random], dict[str, Any]]
Mechanic = Callable[["World", str, Intent], list[Event]]
Reducer = Callable[[EntityStore, Event], None]


class ToolError(Exception):
    """Raised by a tool implementation to signal a domain-level failure."""


class World:
    def __init__(
        self,
        store: EntityStore,
        rng: RngRegistry,
        seq: SeqCounter,
        mechanics: dict[str, Mechanic],
        reducers: dict[str, Reducer],
        tools: dict[str, ToolFn],
    ) -> None:
        self.store = store
        self.rng = rng
        self.seq = seq
        self.mechanics = mechanics
        self.reducers = reducers
        self.tools = tools
        self.time: float = 0.0
        self.events: list[Event] = []

    # -- event construction ------------------------------------------------

    def new_event(
        self,
        kind: str,
        actor_id: str | None,
        payload: dict[str, Any],
        visibility: str = "public",
    ) -> Event:
        seq = self.seq.next()
        return Event(
            id=f"ev-{seq:06d}",
            seq=seq,
            time=self.time,
            kind=kind,
            actor_id=actor_id,
            visibility=visibility,
            payload=payload,
        )

    # -- the only write path ------------------------------------------------

    def submit(self, actor_id: str, intent: Intent) -> list[Event]:
        """Run the mechanic for an intent, then reduce its events into state."""
        mechanic = self.mechanics.get(intent.kind)
        if mechanic is None:
            events = [
                self.new_event(
                    "intent.rejected",
                    actor_id,
                    {"intent": intent.kind, "reason": "unknown mechanic"},
                    visibility="direct",
                )
            ]
        else:
            events = mechanic(self, actor_id, intent)
        for event in events:
            self.apply(event)
        return events

    def apply(self, event: Event) -> None:
        reducer = self.reducers.get(event.kind)
        if reducer is not None:
            reducer(self.store, event)
        self.events.append(event)


# ---------------------------------------------------------------------------
# Built-in mechanics
# ---------------------------------------------------------------------------


def mech_send_message(world: World, actor_id: str, intent: Intent) -> list[Event]:
    payload = {
        "from": actor_id,
        "to": intent.payload["to"],
        "content": intent.payload.get("content", []),
    }
    return [world.new_event("message.sent", actor_id, payload, visibility="direct")]


def mech_set_fact(world: World, actor_id: str, intent: Intent) -> list[Event]:
    entity_id = intent.payload["entity_id"]
    if world.store.maybe(entity_id) is None:
        return [
            world.new_event(
                "intent.rejected",
                actor_id,
                {"intent": "set_fact", "reason": f"no such entity {entity_id}"},
                visibility="direct",
            )
        ]
    payload = {
        "entity_id": entity_id,
        "attr": intent.payload["attr"],
        "value": intent.payload["value"],
    }
    return [world.new_event("fact.set", actor_id, payload, visibility="direct")]


def mech_call_tool(world: World, actor_id: str, intent: Intent) -> list[Event]:
    tool_name = intent.payload["tool"]
    args = intent.payload.get("args", {})
    called = world.new_event(
        "tool.called",
        actor_id,
        {"tool": tool_name, "args": args, "to": actor_id},
        visibility="direct",
    )
    tool_entity = world.store.maybe(f"tool:{tool_name}")
    if tool_entity is None:
        failed = world.new_event(
            "tool.failed",
            actor_id,
            {"tool": tool_name, "reason": "unknown tool", "to": actor_id},
            visibility="direct",
        )
        return [called, failed]
    if tool_entity.attrs.get("status", "up") != "up":
        failed = world.new_event(
            "tool.failed",
            actor_id,
            {"tool": tool_name, "reason": "unavailable", "to": actor_id},
            visibility="direct",
        )
        return [called, failed]
    tool_fn = world.tools.get(tool_name)
    if tool_fn is None:
        # Tools-as-data: an entity with a canned `response` attr is a fully
        # declarative simulated tool — adapted benchmarks need no Python.
        canned = tool_entity.attrs.get("response")
        if canned is None:
            failed = world.new_event(
                "tool.failed",
                actor_id,
                {"tool": tool_name, "reason": "no implementation or response", "to": actor_id},
                visibility="direct",
            )
            return [called, failed]
        result = canned
    else:
        try:
            result = tool_fn(world.store, args, world.rng.stream(f"tool:{tool_name}"))
        except ToolError as exc:
            failed = world.new_event(
                "tool.failed",
                actor_id,
                {"tool": tool_name, "reason": str(exc), "to": actor_id},
                visibility="direct",
            )
            return [called, failed]
    ok = world.new_event(
        "tool.result",
        actor_id,
        {"tool": tool_name, "result": result, "to": actor_id},
        visibility="direct",
    )
    return [called, ok]


def mech_spawn_entity(world: World, actor_id: str, intent: Intent) -> list[Event]:
    """Dynamic worlds: entities may appear mid-run (emergent tasks, new NPCs' props).

    The spawn is an ordinary event, so replay and verifiers see world growth
    like any other change.
    """
    data = intent.payload["entity"]
    if world.store.maybe(data["id"]) is not None:
        return [
            world.new_event(
                "intent.rejected",
                actor_id,
                {"intent": "spawn_entity", "reason": f"entity {data['id']} exists"},
                visibility="direct",
            )
        ]
    return [world.new_event("entity.spawned", actor_id, {"entity": data})]


def mech_despawn_entity(world: World, actor_id: str, intent: Intent) -> list[Event]:
    entity_id = intent.payload["entity_id"]
    if world.store.maybe(entity_id) is None:
        return [
            world.new_event(
                "intent.rejected",
                actor_id,
                {"intent": "despawn_entity", "reason": f"no such entity {entity_id}"},
                visibility="direct",
            )
        ]
    return [world.new_event("entity.despawned", actor_id, {"entity_id": entity_id})]


# ---------------------------------------------------------------------------
# Built-in reducers
# ---------------------------------------------------------------------------


def reduce_fact_set(store: EntityStore, event: Event) -> None:
    entity = store.get(event.payload["entity_id"])
    entity.attrs[event.payload["attr"]] = event.payload["value"]


def reduce_entity_spawned(store: EntityStore, event: Event) -> None:
    store.add(Entity.model_validate(event.payload["entity"]))


def reduce_entity_despawned(store: EntityStore, event: Event) -> None:
    store.remove(event.payload["entity_id"])


def register_builtin(registry: Any) -> None:
    """Populate a plugins.Registry with the built-in world rules."""
    registry.mechanics["send_message"] = mech_send_message
    registry.mechanics["set_fact"] = mech_set_fact
    registry.mechanics["call_tool"] = mech_call_tool
    registry.mechanics["spawn_entity"] = mech_spawn_entity
    registry.mechanics["despawn_entity"] = mech_despawn_entity
    registry.reducers["fact.set"] = reduce_fact_set
    registry.reducers["entity.spawned"] = reduce_entity_spawned
    registry.reducers["entity.despawned"] = reduce_entity_despawned
