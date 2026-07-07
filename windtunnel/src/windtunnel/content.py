"""Multimodal content parts (ADR-0005).

Observations and intents carry lists of typed parts, mirroring modern model
APIs. New modalities (video frames, pointer events, robot proprioception)
extend this union; the kernel never inspects part internals.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, TypeAdapter


class TextPart(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class ImagePart(BaseModel):
    kind: Literal["image"] = "image"
    media_type: str = "image/png"
    ref: str  # URI or trace-blob reference; payloads live outside the event log


class AudioPart(BaseModel):
    kind: Literal["audio"] = "audio"
    media_type: str = "audio/wav"
    ref: str


class StructuredPart(BaseModel):
    kind: Literal["structured"] = "structured"
    data: dict[str, Any]


class RefPart(BaseModel):
    """Reference to an entity or external artifact the recipient may act on."""

    kind: Literal["ref"] = "ref"
    uri: str


ContentPart = Annotated[
    TextPart | ImagePart | AudioPart | StructuredPart | RefPart,
    Field(discriminator="kind"),
]

_part_adapter: TypeAdapter[ContentPart] = TypeAdapter(ContentPart)


def text(value: str) -> TextPart:
    return TextPart(text=value)


def parse_part(data: Any) -> ContentPart:
    """Validate serialized part data (e.g. from an event payload) into a part."""
    if isinstance(data, dict):
        return _part_adapter.validate_python(data)
    return text(str(data))


def flatten_text(parts: list[ContentPart]) -> str:
    """Concatenate the textual projection of parts (for text surfaces and checks)."""
    chunks: list[str] = []
    for part in parts:
        if isinstance(part, TextPart):
            chunks.append(part.text)
        elif isinstance(part, StructuredPart):
            chunks.append(str(part.data))
    return "\n".join(chunks)
