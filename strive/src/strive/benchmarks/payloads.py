"""Versioned benchmark payloads encoded behind ArtifactRef, not wire records."""
from dataclasses import fields, is_dataclass
from typing import TypeVar, get_type_hints

from ..codec import decode, encode, _matches
from ..errors import VerificationError
from . import api

# Static allowlist. No class names from disk are imported or registered in codec.
_TYPES: dict[str, type[object]] = {cls.__name__: cls for cls in (
    api.TaskSpec, api.SplitSpec, api.OperationSpec, api.BenchmarkDescriptor,
    api.EpisodeSnapshot, api.OperationContext, api.ToolInvocation, api.CapturedGeneration,
    api.UserTurnPlan, api.OperationReceipt, api.FoundOperation, api.ProvenAbsent,
    api.UnknownOperation, api.ScoringInput, api.Metric, api.RewardResult,
)}
T = TypeVar("T")


def _pack(value: object) -> object:
    if type(value) in _TYPES.values() and is_dataclass(value) and not isinstance(value, type):
        return ("benchmark-value/1", type(value).__name__, tuple(_pack(getattr(value, f.name)) for f in fields(value)))
    if isinstance(value, tuple):
        return tuple(_pack(v) for v in value)
    return value


def _unpack(value: object) -> object:
    if isinstance(value, tuple):
        if len(value) == 3 and value[0] == "benchmark-value/1":
            name, values = value[1:]
            if not isinstance(name, str) or name not in _TYPES or not isinstance(values, tuple):
                raise VerificationError("unknown benchmark payload")
            cls = _TYPES[name]
            assert is_dataclass(cls)
            if len(values) != len(fields(cls)):
                raise VerificationError("malformed benchmark payload")
            decoded = {f.name: _unpack(v) for f, v in zip(fields(cls), values, strict=True)}
            hints = get_type_hints(cls)
            if any(not _matches(v, hints[k]) for k, v in decoded.items()):
                raise VerificationError("invalid benchmark field type")
            return cls(**decoded)
        return tuple(_unpack(v) for v in value)
    return value


def dumps(value: object) -> bytes:
    return encode(("strive.benchmark/1", _pack(value)))


def loads(data: bytes, expected: type[T]) -> T:
    raw = decode(data)
    if not isinstance(raw, tuple) or len(raw) != 2 or raw[0] != "strive.benchmark/1":
        raise VerificationError("benchmark payload version required")
    value = _unpack(raw[1])
    if not isinstance(value, expected) or dumps(value) != data:
        raise VerificationError("unexpected/noncanonical benchmark payload")
    return value
