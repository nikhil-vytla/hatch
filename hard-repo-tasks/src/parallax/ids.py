from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from typing import TypeAlias

CanonicalValue: TypeAlias = (
    bool | int | float | str | Sequence["CanonicalValue"] | Mapping[str, "CanonicalValue"] | None
)


def canonical_bytes(value: CanonicalValue) -> bytes:
    normalized = _normalize(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def digest_value(value: CanonicalValue) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def task_id_for(public_digest: str, sealed_digest: str) -> str:
    return digest_value(
        {
            "public_digest": public_digest,
            "sealed_digest": sealed_digest,
        }
    )


def _normalize(value: CanonicalValue) -> object:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("canonical values must not contain NaN or infinity")
        return value
    if isinstance(value, Mapping):
        normalized: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("canonical mappings require string keys")
            normalized[key] = _normalize(item)
        return normalized
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_normalize(item) for item in value]
    raise TypeError(f"unsupported canonical value: {type(value).__name__}")
