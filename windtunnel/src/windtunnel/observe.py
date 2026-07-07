"""Observation policies: partial observability enforced at render time (ADR-0005).

Hidden state is not a separate store — it is world state outside an actor's
scope. The same world yields different `WorldView`s for the agent-under-test,
an NPC, and a judge; "the agent saw X" is therefore a provable trace statement.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from windtunnel.entities import Entity, EntityStore
from windtunnel.events import Event


class ObservationScope(BaseModel):
    """Declarative filter over entities and events for one actor.

    - `entity_kinds`: kinds this actor may perceive (None = all kinds).
    - Secret attributes (Entity.secret_attrs) are visible only if the actor is
      listed in the entity's `visible_to`.
    - Events with visibility "direct" are visible only to their sender and the
      actors named in payload["to"].
    """

    entity_kinds: list[str] | None = None
    omniscient: bool = False  # judges/verifiers: bypass all filtering


class EntityView(BaseModel):
    id: str
    kind: str
    attrs: dict[str, Any] = Field(default_factory=dict)


class WorldView(BaseModel):
    """What one actor can perceive right now: filtered state + filtered events."""

    actor_id: str
    time: float
    entities: list[EntityView]
    events: list[Event]  # visible events since the actor's previous activation


def _visible_attrs(entity: Entity, actor_id: str, omniscient: bool) -> dict[str, Any]:
    if omniscient or actor_id in entity.visible_to:
        return dict(entity.attrs)
    return {k: v for k, v in entity.attrs.items() if k not in entity.secret_attrs}


def event_visible_to(event: Event, actor_id: str, omniscient: bool = False) -> bool:
    if omniscient or event.visibility == "public":
        return True
    if event.visibility == "direct":
        addressed = event.payload.get("to")
        targets = addressed if isinstance(addressed, list) else [addressed]
        return actor_id in targets or event.actor_id == actor_id
    return False


def render_view(
    store: EntityStore,
    events: list[Event],
    actor_id: str,
    scope: ObservationScope,
    time: float,
) -> WorldView:
    visible_entities = [
        EntityView(
            id=e.id,
            kind=e.kind,
            attrs=_visible_attrs(e, actor_id, scope.omniscient),
        )
        for e in sorted(store.entities.values(), key=lambda e: e.id)
        if scope.omniscient or scope.entity_kinds is None or e.kind in scope.entity_kinds
    ]
    visible_events = [ev for ev in events if event_visible_to(ev, actor_id, scope.omniscient)]
    return WorldView(actor_id=actor_id, time=time, entities=visible_entities, events=visible_events)
