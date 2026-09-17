"""Versioned policy data behind artifact references, never authority records."""
from dataclasses import dataclass, fields, is_dataclass
from typing import TypeVar, get_type_hints

from ..codec import decode, encode, _matches
from ..contracts.primitives import AccessScope, ArtifactRef, RevisionId
from ..errors import VerificationError


@dataclass(frozen=True)
class Origin:
    reference: ArtifactRef
    scope: AccessScope
    pool: str


@dataclass(frozen=True)
class FileVersion:
    content: ArtifactRef
    scope: AccessScope
    origins: tuple[Origin, ...]
    previous: ArtifactRef | None = None


@dataclass(frozen=True)
class Dependency:
    name: str
    source: ArtifactRef


@dataclass(frozen=True)
class Bundle:
    files: tuple[tuple[str, ArtifactRef], ...]
    dependencies: tuple[Dependency, ...] = ()
    capabilities: tuple[str, ...] = ()
    interface: str = "step/1"


@dataclass(frozen=True)
class Edit:
    path: str
    content: bytes | None
    imported_version: ArtifactRef | None = None


@dataclass(frozen=True)
class Proposal:
    expected_revision: RevisionId
    decision: str
    edits: tuple[Edit, ...] = ()
    dependencies: tuple[Dependency, ...] | None = None
    capabilities: tuple[str, ...] | None = None
    controller_state: bytes | None = None
    restore: ArtifactRef | None = None
    rationale: str = ""
    compare: bool = False


_TYPES: dict[str, type[object]] = {c.__name__: c for c in (Origin, FileVersion, Dependency, Bundle, Edit, Proposal)}
T = TypeVar("T")


def _pack(value: object) -> object:
    if type(value) in _TYPES.values() and is_dataclass(value) and not isinstance(value, type):
        return ("policy-value/1", type(value).__name__, tuple(_pack(getattr(value, f.name)) for f in fields(value)))
    if isinstance(value, tuple):
        return tuple(_pack(v) for v in value)
    return value


def _unpack(value: object) -> object:
    if isinstance(value, tuple):
        if len(value) == 3 and value[0] == "policy-value/1":
            name, values = value[1:]
            if not isinstance(name, str) or name not in _TYPES or not isinstance(values, tuple):
                raise VerificationError("unknown policy payload")
            cls = _TYPES[name]
            assert is_dataclass(cls)
            if len(values) != len(fields(cls)):
                raise VerificationError("malformed policy payload")
            decoded = {f.name: _unpack(v) for f, v in zip(fields(cls), values, strict=True)}
            hints = get_type_hints(cls)
            if any(not _matches(v, hints[k]) for k, v in decoded.items()):
                raise VerificationError("invalid policy field type")
            return cls(**decoded)
        return tuple(_unpack(v) for v in value)
    return value


def dumps(value: object) -> bytes:
    return encode(("strive.policy/1", _pack(value)))


def loads(data: bytes, expected: type[T]) -> T:
    raw = decode(data)
    if not isinstance(raw, tuple) or len(raw) != 2 or raw[0] != "strive.policy/1":
        raise VerificationError("policy payload version required")
    value = _unpack(raw[1])
    if not isinstance(value, expected) or dumps(value) != data:
        raise VerificationError("unexpected/noncanonical policy payload")
    return value
