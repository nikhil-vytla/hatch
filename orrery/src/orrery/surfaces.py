"""Surfaces: how actors perceive and act on the world (ADR-0005).

A Surface turns a filtered `WorldView` into an `Observation` (typed content
parts + the structured view) and can translate raw external output back into
intents. Rule-based policies read `observation.view`; model-backed policies
read `observation.parts`. New modalities (browser, voice, desktop) are new
Surface implementations — the kernel is unchanged.
"""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, Field

from orrery.content import ContentPart, flatten_text, parse_part, text
from orrery.events import Intent
from orrery.observe import WorldView


class Observation(BaseModel):
    actor_id: str
    time: float
    parts: list[ContentPart] = Field(default_factory=list)
    view: WorldView


class Surface(Protocol):
    def render(self, view: WorldView) -> Observation: ...

    def interpret(self, raw: Any) -> list[Intent]: ...


class TextSurface:
    """Renders the view as a plain-text situation report (transcript style)."""

    def render(self, view: WorldView) -> Observation:
        lines = [f"[t={view.time:.2f}] You are {view.actor_id}."]
        for event in view.events:
            if event.kind == "message.sent":
                body = flatten_text([parse_part(p) for p in event.payload.get("content", [])])
                lines.append(f"message from {event.payload.get('from')}: {body}")
            elif event.kind in ("tool.result", "tool.failed"):
                lines.append(f"{event.kind}: {event.payload}")
        return Observation(
            actor_id=view.actor_id, time=view.time, parts=[text("\n".join(lines))], view=view
        )

    def interpret(self, raw: Any) -> list[Intent]:
        # v0: raw output is already a list of intent dicts (T0 ingestion tier).
        return [Intent.model_validate(item) for item in raw]
