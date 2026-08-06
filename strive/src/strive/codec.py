"""One shared serialization codec for every persisted contract.

Every record on disk is a JSON object carrying a ``"schema": "<kind>@<version>"``
field. The same registered dataclasses are used in memory and on disk, so there
is exactly one source of truth for each contract's shape (HANDOFF decision:
eliminate dict drift between `types` and persisted records).

Decoding is strict and loud (D9): unknown kinds, unsupported versions, missing
fields, unexpected fields, and wrong types all raise ``SchemaError`` with a
precise message. There is no silent fallback.
"""

from __future__ import annotations

import dataclasses
import json
import types as _types
import typing
from typing import Any, TypeVar

T = TypeVar("T")


class SchemaError(Exception):
    """A record failed schema identification or validation."""


_BY_KIND: dict[str, tuple[type[Any], int]] = {}
_BY_TYPE: dict[type[Any], tuple[str, int]] = {}


def register(kind: str, version: int) -> Any:
    """Class decorator registering a frozen dataclass as a persisted contract."""

    def decorate(cls: type[T]) -> type[T]:
        if kind in _BY_KIND:
            raise ValueError(f"schema kind already registered: {kind}")
        _BY_KIND[kind] = (cls, version)
        _BY_TYPE[cls] = (kind, version)
        return cls

    return decorate


def schema_of(cls: type[Any]) -> str:
    kind, version = _BY_TYPE[cls]
    return f"{kind}@{version}"


def encode(obj: Any) -> dict[str, Any]:
    """Encode a registered contract instance to a JSON-safe dict with schema tag."""
    cls = type(obj)
    if cls not in _BY_TYPE:
        raise SchemaError(f"type not registered with codec: {cls.__name__}")
    kind, version = _BY_TYPE[cls]
    data = {
        field.name: _encode_value(getattr(obj, field.name))
        for field in dataclasses.fields(obj)
    }
    data["schema"] = f"{kind}@{version}"
    return data


def _encode_value(value: Any) -> Any:
    if type(value) in _BY_TYPE:
        return encode(value)
    if isinstance(value, (tuple, list)):
        return [_encode_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _encode_value(val) for key, val in value.items()}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise SchemaError(f"unencodable value of type {type(value).__name__}")


def dumps(obj: Any) -> str:
    """Encode to a single canonical JSON line (no trailing newline)."""
    return json.dumps(encode(obj), sort_keys=True, separators=(",", ":"))


def decode(record: Any, expect: type[T] | None = None) -> T:
    """Decode a dict into its registered contract, validating strictly."""
    if not isinstance(record, dict):
        raise SchemaError(f"record is not an object: {type(record).__name__}")
    schema = record.get("schema")
    if not isinstance(schema, str) or "@" not in schema:
        raise SchemaError(f"missing or malformed schema field: {schema!r}")
    kind, _, version_text = schema.partition("@")
    if kind not in _BY_KIND:
        raise SchemaError(f"unknown schema kind: {kind!r}")
    cls, current_version = _BY_KIND[kind]
    try:
        version = int(version_text)
    except ValueError:
        raise SchemaError(f"malformed schema version: {schema!r}") from None
    if version != current_version:
        raise SchemaError(
            f"unsupported {kind} version {version} (this build supports "
            f"{current_version}); refusing to guess"
        )
    if expect is not None and cls is not expect:
        raise SchemaError(f"expected {schema_of(expect)}, found {schema}")
    body = {key: value for key, value in record.items() if key != "schema"}
    return typing.cast(T, _decode_as(cls, body, kind))


def loads(line: str, expect: type[T] | None = None) -> T:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError as exc:
        raise SchemaError(f"invalid JSON: {exc}") from None
    return decode(raw, expect)


def _decode_as(cls: type[Any], body: dict[str, Any], kind: str) -> Any:
    hints = typing.get_type_hints(cls)
    field_names = {field.name for field in dataclasses.fields(cls)}
    missing = field_names - body.keys()
    if missing:
        raise SchemaError(f"{kind}: missing fields {sorted(missing)}")
    extra = body.keys() - field_names
    if extra:
        raise SchemaError(f"{kind}: unexpected fields {sorted(extra)}")
    kwargs = {
        name: _decode_value(hints[name], body[name], f"{kind}.{name}")
        for name in field_names
    }
    return cls(**kwargs)


def _decode_value(hint: Any, value: Any, where: str) -> Any:
    origin = typing.get_origin(hint)
    if origin in (typing.Union, _types.UnionType):
        args = [arg for arg in typing.get_args(hint) if arg is not type(None)]
        if value is None:
            if len(args) == len(typing.get_args(hint)):
                raise SchemaError(f"{where}: null not permitted")
            return None
        if len(args) != 1:
            raise SchemaError(f"{where}: unsupported union {hint}")
        return _decode_value(args[0], value, where)
    if origin is tuple:
        item_hint = typing.get_args(hint)[0]
        if not isinstance(value, list):
            raise SchemaError(f"{where}: expected array, got {type(value).__name__}")
        return tuple(
            _decode_value(item_hint, item, f"{where}[{i}]")
            for i, item in enumerate(value)
        )
    if origin is dict:
        _, value_hint = typing.get_args(hint)
        if not isinstance(value, dict):
            raise SchemaError(f"{where}: expected object, got {type(value).__name__}")
        return {
            key: _decode_value(value_hint, val, f"{where}.{key}")
            for key, val in value.items()
        }
    if hint in _BY_TYPE:
        decoded: Any = decode(value)
        if type(decoded) is not hint:
            raise SchemaError(f"{where}: expected {schema_of(hint)}")
        return decoded
    if hint is float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SchemaError(f"{where}: expected number, got {type(value).__name__}")
        return float(value)
    if hint is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise SchemaError(f"{where}: expected integer, got {type(value).__name__}")
        return value
    if hint is bool:
        if not isinstance(value, bool):
            raise SchemaError(f"{where}: expected boolean, got {type(value).__name__}")
        return value
    if hint is str:
        if not isinstance(value, str):
            raise SchemaError(f"{where}: expected string, got {type(value).__name__}")
        return value
    if hint in (Any, object):
        return value
    raise SchemaError(f"{where}: unsupported field type {hint!r}")
