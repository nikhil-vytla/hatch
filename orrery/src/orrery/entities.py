"""Typed entity store: the world's state (ADR-0001, U4).

Entities are the ground truth that observation policies filter (hidden state)
and reducers mutate (only in response to events). `secret_attrs` marks
attributes that only actors listed in `visible_to` may observe — the
enforcement lives in `observe.py`, the ground truth lives here, and verifiers
always see everything.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Entity(BaseModel):
    id: str
    kind: str
    attrs: dict[str, Any] = Field(default_factory=dict)
    # Actors allowed to see secret_attrs. Non-secret attrs are visible to
    # anyone whose observation scope includes this entity kind.
    visible_to: list[str] = Field(default_factory=list)
    secret_attrs: list[str] = Field(default_factory=list)


class EntityStore(BaseModel):
    entities: dict[str, Entity] = Field(default_factory=dict)

    def add(self, entity: Entity) -> None:
        if entity.id in self.entities:
            raise ValueError(f"duplicate entity id: {entity.id}")
        self.entities[entity.id] = entity

    def get(self, entity_id: str) -> Entity:
        return self.entities[entity_id]

    def maybe(self, entity_id: str) -> Entity | None:
        return self.entities.get(entity_id)

    def by_kind(self, kind: str) -> list[Entity]:
        return [e for e in self.entities.values() if e.kind == kind]

    def snapshot(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
