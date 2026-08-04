"""The single boundary where HUD and provider payloads become domain models.

Everything here exists because a paid episode was destroyed by it. The rule at
this boundary is: tolerant about how a value arrives, strict about what we then
consume. Every quirk is covered by a recorded fixture in
`tests/fixtures/wire/`, so the next instance of this defect class costs $0 in a
test run instead of a screening round.

Quirks encoded here:

- Tuple fields arrive as JSON arrays. Our models are `strict=True`, which
  rejects a `list` for a `tuple[...]` in Python mode, so a receipt that took a
  real episode to produce was thrown away by validation. Wire payloads are
  therefore always validated in JSON mode.
- `tool_calls` arrives as `null` where a list is declared.
- Model output arrives wrapped in a Markdown JSON code fence.
- HUD 0.6.12 reads control-channel frames with `StreamReader.readline()` on
  connections opened at asyncio's default 64 KiB limit, so one long tool result
  or a grade frame carrying the candidate patch raises `LimitOverrunError` and
  loses a complete episode.
"""

from __future__ import annotations

import asyncio
import functools
import json
import re
from typing import TypeVar

from pydantic import ValidationError

from .types import StrictModel

WireModelT = TypeVar("WireModelT", bound=StrictModel)

FRAME_LIMIT_BYTES = 16 * 1024 * 1024
ASYNCIO_DEFAULT_FRAME_LIMIT = 64 * 1024
_FENCE = re.compile(r"\A\s*```(?:json)?\s*\n(?P<body>.*?)\n?\s*```\s*\Z", re.DOTALL)
_applied_frame_limit: int | None = None


class WireFormatError(ValueError):
    pass


def strip_json_fence(text: str) -> str:
    """Return `text` without an enclosing Markdown code fence, if present."""
    match = _FENCE.match(text)
    return match.group("body") if match else text


def wire_tuple(value: object) -> object:
    """Normalize a null-or-array wire field into a tuple.

    Use as a `mode="before"` validator on strict tuple fields whose provider
    sends `null` for "none of these".

    The list branch is not redundant. Attaching any `mode="before"` validator
    to a strict tuple field moves the rest of that field's validation into
    python mode, where a `list` is no longer accepted for a `tuple[...]`. A
    validator that only handled `null` would therefore fix the null case and
    break every ordinary JSON array.
    """
    if value is None:
        return ()
    if isinstance(value, list):
        return tuple(value)
    return value


def parse_wire(model: type[WireModelT], payload: object) -> WireModelT:
    """Validate a payload that crossed a wire into a strict domain model.

    `payload` may be decoded JSON (dicts and lists), raw JSON `bytes`/`str`, or
    a fence-wrapped JSON string. Validation always runs in JSON mode so that
    strict tuple fields accept the arrays they legitimately arrive as.
    """
    if isinstance(payload, bytes | bytearray):
        document = bytes(payload)
    elif isinstance(payload, str):
        document = strip_json_fence(payload).encode()
    else:
        try:
            document = json.dumps(payload, allow_nan=False).encode()
        except (TypeError, ValueError) as error:
            raise WireFormatError(
                f"{model.__name__} payload is not JSON-serializable: {error}"
            ) from error
    try:
        return model.model_validate_json(document)
    except ValidationError as error:
        detail = error.errors(include_url=False)[0]["msg"]
        raise WireFormatError(f"invalid {model.__name__} payload: {detail}") from error


def applied_frame_limit() -> int | None:
    """Return the frame limit currently installed, or None if untouched."""
    return _applied_frame_limit


def raise_stream_frame_limit(limit: int = FRAME_LIMIT_BYTES) -> None:
    """Open every asyncio connection with a frame limit large enough for HUD.

    Idempotent, and process-wide because the limit has to be in place before
    the HUD client opens its control channel.
    """
    global _applied_frame_limit
    if _applied_frame_limit == limit:
        return
    original = asyncio.open_connection

    @functools.wraps(original)
    async def patched(host=None, port=None, **kwargs):
        kwargs.setdefault("limit", limit)
        return await original(host, port, **kwargs)

    setattr(asyncio, "open_connection", patched)  # noqa: B010
    _applied_frame_limit = limit
