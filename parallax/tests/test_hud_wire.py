"""Replay of every wire payload that has destroyed a paid episode.

Each test here is the offline, $0 version of a defect that was originally
diagnosed from a failed screening or experiment round.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from pydantic import field_validator

from parallax.delivery import CompleteDeliveryReceiptV1
from parallax.hud_wire import (
    ASYNCIO_DEFAULT_FRAME_LIMIT,
    FRAME_LIMIT_BYTES,
    WireFormatError,
    applied_frame_limit,
    parse_wire,
    raise_stream_frame_limit,
    strip_json_fence,
    wire_tuple,
)
from parallax.provider import ProviderResponse
from parallax.swebench import SweConstruction
from parallax.types import StrictModel

FIXTURES = Path(__file__).parent / "fixtures" / "wire"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_strict_tuple_fields_accept_the_json_arrays_they_arrive_as() -> None:
    payload = json.loads(fixture("delivery-receipt-json-arrays.json"))
    assert isinstance(payload["phases"], list)

    receipt = parse_wire(CompleteDeliveryReceiptV1, payload)

    assert isinstance(receipt.phases, tuple)
    assert receipt.turn_count == 2
    assert tuple(phase.advance_trigger for phase in receipt.phases) == (
        "budget_exhaustion",
        "terminal_budget_exhaustion",
    )


def test_strict_python_mode_is_what_rejected_that_receipt() -> None:
    payload = json.loads(fixture("delivery-receipt-json-arrays.json"))

    with pytest.raises(ValueError):
        CompleteDeliveryReceiptV1.model_validate(payload)


def test_null_tool_calls_parse_as_no_tool_calls() -> None:
    response = parse_wire(
        ProviderResponse,
        json.loads(fixture("provider-null-tool-calls.json")),
    )

    assert response.choices[0].message.tool_calls == ()
    assert response.usage is not None
    assert response.usage.prompt_tokens == 731


def test_fenced_and_bare_construction_json_parse_identically() -> None:
    fenced = parse_wire(SweConstruction, fixture("construction-fenced-json.txt"))
    bare = parse_wire(SweConstruction, fixture("construction-bare-json.txt"))

    assert fenced == bare
    assert fenced.source.function == "reject_invalid_unit_string"


@pytest.mark.parametrize(
    "text",
    [
        '```json\n{"a": 1}\n```',
        '```\n{"a": 1}\n```',
        '  ```json\n{"a": 1}\n```  \n',
    ],
)
def test_fence_stripping_tolerates_fence_spelling(text: str) -> None:
    assert json.loads(strip_json_fence(text)) == {"a": 1}


def test_fence_stripping_leaves_unfenced_text_alone() -> None:
    assert strip_json_fence('{"a": 1}') == '{"a": 1}'


def test_missing_payload_is_a_wire_format_error() -> None:
    with pytest.raises(WireFormatError):
        parse_wire(CompleteDeliveryReceiptV1, None)


def test_null_normalizing_a_tuple_field_still_accepts_ordinary_arrays() -> None:
    """Guards the trap in wire_tuple's docstring.

    Attaching a before-validator to a strict tuple field moves the rest of
    that field's validation into python mode, so a validator that only mapped
    null to () would fix one payload and reject every normal one.
    """

    class Wire(StrictModel):
        items: tuple[int, ...] = ()

        _items = field_validator("items", mode="before")(staticmethod(wire_tuple))

    assert Wire.model_validate_json('{"items": [1, 2]}').items == (1, 2)
    assert Wire.model_validate_json('{"items": null}').items == ()
    assert Wire.model_validate({"items": [1, 2]}).items == (1, 2)


def test_frame_limit_is_raised_idempotently_above_the_default() -> None:
    raise_stream_frame_limit()
    patched = asyncio.open_connection
    raise_stream_frame_limit()

    assert asyncio.open_connection is patched
    assert applied_frame_limit() == FRAME_LIMIT_BYTES
    assert FRAME_LIMIT_BYTES > ASYNCIO_DEFAULT_FRAME_LIMIT


def test_the_raised_limit_reaches_the_connection_asyncio_opens(monkeypatch) -> None:
    """The 64 KiB default is what truncated a grade frame mid-experiment."""
    seen: dict[str, object] = {}

    async def record(host=None, port=None, **kwargs):
        seen.update(kwargs)
        return "reader", "writer"

    monkeypatch.setattr(asyncio, "open_connection", record)
    raise_stream_frame_limit(FRAME_LIMIT_BYTES // 2)

    asyncio.run(asyncio.open_connection("localhost", 1))

    assert seen["limit"] == FRAME_LIMIT_BYTES // 2
    assert seen["limit"] > ASYNCIO_DEFAULT_FRAME_LIMIT
