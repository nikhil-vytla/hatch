"""Events and intents: the only way the world changes (ADR-0001).

An Intent is what an actor *wants* to do; mechanics validate it against world
state and emit zero or more Events; reducers fold Events into the entity
store. Events are canonically serializable and hash-chained so a whole run can
be fingerprinted and compared bit-for-bit on replay.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel, Field


class Intent(BaseModel):
    """An actor's requested action. `kind` selects the mechanic that handles it."""

    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ScheduledIntent(BaseModel):
    """An intent to be submitted at a future virtual time (e.g. chaos windows)."""

    at_time: float
    intent: Intent
    actor_id: str


class Event(BaseModel):
    """A fact: something that happened in the world.

    `actor_id` attributes causality (None for the kernel/timeline itself).
    `visibility` is the default audience gate used by observation policies:
    "public", or "direct" (only actors named in payload["to"]/payload["from"]).
    """

    id: str
    seq: int
    time: float
    kind: str
    actor_id: str | None = None
    visibility: str = "public"
    payload: dict[str, Any] = Field(default_factory=dict)

    def canonical(self) -> str:
        return json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))


def chain_hash(previous: str, event: Event) -> str:
    """Extend the run fingerprint with one event."""
    return hashlib.sha256((previous + event.canonical()).encode()).hexdigest()


GENESIS_HASH = hashlib.sha256(b"orrery-genesis").hexdigest()


def fingerprint(events: list[Event]) -> str:
    """Hash-chain an entire event log."""
    acc = GENESIS_HASH
    for event in events:
        acc = chain_hash(acc, event)
    return acc
