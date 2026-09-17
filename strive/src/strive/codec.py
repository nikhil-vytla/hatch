"""Canonical, closed serialization of the existing contracts, with no data imports.

Tags select only statically imported dataclasses/enums. Field types are checked
as well as constructors: dataclass annotations alone do not validate JSON.
Annotation payloads are the deliberate exception, retained as opaque bytes.
"""

import base64
from dataclasses import fields, is_dataclass
from decimal import Decimal
from enum import Enum
import hashlib
import json
from types import UnionType
from typing import Literal, NewType, TypeAliasType, TypeVar, Union, get_args, get_origin, get_type_hints

from .contracts import annotations, bindings, commands, feedback, harness, lifecycle, manifest, primitives, records
from .contracts.annotations import Annotation, MAX_ANNOTATION_BYTES
from .contracts.primitives import ArtifactRef
from .errors import VerificationError

_MODULES = (annotations, bindings, commands, feedback, harness, lifecycle, manifest, primitives, records)
_TYPES: dict[str, type[object]] = {
    value.__name__: value
    for module in _MODULES
    for value in vars(module).values()
    if isinstance(value, type) and value.__module__ == module.__name__
    and (is_dataclass(value) or issubclass(value, Enum))
}


def opaque_annotation(namespace: str, payload: bytes) -> Annotation:
    """Reuse the frozen type without interpreting diagnostic content on read."""
    if not isinstance(namespace, str) or "." not in namespace or any(not p for p in namespace.split(".")):
        raise VerificationError("invalid annotation namespace")
    if type(payload) is not bytes or len(payload) > MAX_ANNOTATION_BYTES:
        raise VerificationError("annotation exceeds byte quota or is not bytes")
    result = object.__new__(Annotation)
    object.__setattr__(result, "namespace", namespace)
    object.__setattr__(result, "payload", payload)
    return result


def content_ref(data: bytes) -> ArtifactRef:
    return ArtifactRef("sha256:" + hashlib.sha256(data).hexdigest())


def _encode(value: object) -> object:
    if isinstance(value, Enum):
        return {"enum": type(value).__name__, "value": value.value}
    if value is None or type(value) in (str, int, bool):
        return value
    if isinstance(value, bytes):
        return {"bytes": base64.b64encode(value).decode("ascii")}
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise VerificationError("nonfinite decimal")
        return {"decimal": str(value)}
    if isinstance(value, (tuple, frozenset)):
        items = [_encode(item) for item in value]
        if isinstance(value, frozenset):
            items.sort(key=lambda item: json.dumps(item, sort_keys=True))
        return {"set" if isinstance(value, frozenset) else "tuple": items}
    if is_dataclass(value) and not isinstance(value, type) and type(value) in _TYPES.values():
        return {"type": type(value).__name__, "fields": {f.name: _encode(getattr(value, f.name)) for f in fields(value)}}
    raise VerificationError(f"unsupported wire value: {type(value).__name__}")


def encode(value: object) -> bytes:
    try:
        return json.dumps(_encode(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    except (ValueError, TypeError, RecursionError) as error:
        raise VerificationError("cannot encode contract") from error


def _matches(value: object, expected: object) -> bool:
    if isinstance(expected, TypeAliasType):
        return _matches(value, expected.__value__)
    if isinstance(expected, TypeVar):
        # All serialized Ref parameters are resolved artifact references.
        return isinstance(value, ArtifactRef)
    if isinstance(expected, NewType):
        return type(value) is str and bool(value)
    origin, args = get_origin(expected), get_args(expected)
    if origin in (UnionType, Union):
        return any(_matches(value, arg) for arg in args)
    if origin is Literal:
        return any(type(value) is type(arg) and value == arg for arg in args)
    if origin in (tuple, frozenset):
        if not isinstance(value, origin):
            return False
        if origin is frozenset or len(args) == 2 and args[1] is Ellipsis:
            return all(_matches(item, args[0]) for item in value)
        return len(value) == len(args) and all(_matches(item, arg) for item, arg in zip(value, args))
    if isinstance(origin, type):
        return type(value) is origin
    return isinstance(expected, type) and type(value) is expected


def _decode(value: object) -> object:
    if value is None or type(value) in (str, int, bool):
        return value
    if not isinstance(value, dict):
        raise VerificationError("invalid wire object")
    if set(value) == {"bytes"} and isinstance(value["bytes"], str):
        return base64.b64decode(value["bytes"], validate=True)
    if set(value) == {"decimal"} and isinstance(value["decimal"], str):
        result = Decimal(value["decimal"])
        if not result.is_finite():
            raise VerificationError("nonfinite decimal")
        return result
    for tag in ("tuple", "set"):
        if set(value) == {tag} and isinstance(value[tag], list):
            items = tuple(_decode(item) for item in value[tag])
            if tag == "tuple":
                return items
            if len(frozenset(items)) != len(items):
                raise VerificationError("duplicate set member")
            return frozenset(items)
    if set(value) == {"enum", "value"} and isinstance(value["enum"], str):
        enum_type = _TYPES.get(value["enum"])
        if enum_type is not None and issubclass(enum_type, Enum):
            return enum_type(value["value"])
    if set(value) == {"type", "fields"} and isinstance(value["type"], str):
        cls = _TYPES.get(value["type"])
        raw = value["fields"]
        if cls is None or not is_dataclass(cls) or not isinstance(raw, dict):
            raise VerificationError("unknown contract type")
        if set(raw) != {f.name for f in fields(cls)}:
            raise VerificationError("unknown or missing contract fields")
        decoded = {key: _decode(item) for key, item in raw.items()}
        hints = get_type_hints(cls)
        if any(not _matches(item, hints[key]) for key, item in decoded.items()):
            raise VerificationError(f"invalid field type in {cls.__name__}")
        if cls is Annotation:
            namespace, payload = decoded["namespace"], decoded["payload"]
            assert isinstance(namespace, str) and isinstance(payload, bytes)
            return opaque_annotation(namespace, payload)
        return cls(**decoded)
    raise VerificationError("invalid wire tags")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("duplicate JSON field")
        result[key] = value
    return result


def decode(data: bytes) -> object:
    try:
        value = _decode(json.loads(data, object_pairs_hook=_unique_object))
        if encode(value) != data:
            raise VerificationError("noncanonical contract bytes")
        return value
    except (ValueError, TypeError, KeyError, ArithmeticError, RecursionError) as error:
        raise VerificationError(f"malformed contract: {error}") from error


def references(value: object) -> frozenset[ArtifactRef]:
    """Walk typed references, never strings or annotation content."""
    if isinstance(value, ArtifactRef):
        return frozenset({value})
    if isinstance(value, Annotation):
        return frozenset()
    if is_dataclass(value) and not isinstance(value, type):
        return frozenset(ref for field in fields(value) for ref in references(getattr(value, field.name)))
    if isinstance(value, (tuple, frozenset)):
        return frozenset(ref for item in value for ref in references(item))
    return frozenset()
