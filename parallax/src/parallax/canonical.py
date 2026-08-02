from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import fields, is_dataclass
from enum import Enum
from typing import Any, Mapping, Sequence

_ID_NAMESPACE = re.compile(r"[a-z][a-z0-9.-]{0,63}\Z")
_ID = re.compile(r"px1:([a-z][a-z0-9.-]{0,63}):sha256:([0-9a-f]{64})\Z")
_MIN_INT = -(2**63)
_MAX_INT = 2**63 - 1


class CanonicalValueError(ValueError):
    """A value has no unambiguous Parallax canonical representation."""


def _normalize(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: _normalize(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Enum):
        return _normalize(value.value)
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if not _MIN_INT <= value <= _MAX_INT:
            raise CanonicalValueError("integer is outside signed 64-bit range")
        return value
    if isinstance(value, float):
        raise CanonicalValueError("floating-point values are forbidden")
    if isinstance(value, str):
        if unicodedata.normalize("NFC", value) != value:
            raise CanonicalValueError("strings must already be NFC-normalized")
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise CanonicalValueError("strings must contain valid Unicode scalars") from error
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalValueError("mapping keys must be strings")
            normalized_key = _normalize(key)
            if normalized_key in result:
                raise CanonicalValueError("mapping keys collide after validation")
            result[normalized_key] = _normalize(item)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_normalize(item) for item in value]
    raise CanonicalValueError(f"unsupported canonical type: {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    normalized = _normalize(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def content_id(namespace: str, value: Any) -> str:
    if not _ID_NAMESPACE.fullmatch(namespace):
        raise ValueError("invalid content ID namespace")
    preimage = b"parallax-content-id\x00v1\x00" + namespace.encode("ascii") + b"\x00" + canonical_bytes(value)
    return f"px1:{namespace}:sha256:{hashlib.sha256(preimage).hexdigest()}"


def validate_content_id(value: str, namespace: str | None = None) -> str:
    match = _ID.fullmatch(value)
    if match is None:
        raise ValueError("invalid Parallax content ID")
    if namespace is not None and match.group(1) != namespace:
        raise ValueError(f"expected {namespace!r} content ID")
    return value


def validate_digest(value: str) -> str:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("invalid SHA-256 digest")
    return value
