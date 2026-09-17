"""Strict JSON helpers for opaque benchmark data."""
import json
from ..errors import VerificationError


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def parse(data: bytes) -> object:
    def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise VerificationError("duplicate JSON field")
            result[key] = value
        return result
    try:
        value: object = json.loads(data, object_pairs_hook=unique, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        return value
    except (ValueError, RecursionError) as error:
        raise VerificationError("invalid benchmark JSON") from error


def obj(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(k, str) for k in value):
        raise VerificationError("JSON object required")
    return {str(k): v for k, v in value.items()}


def items(value: object) -> list[object]:
    if not isinstance(value, list):
        raise VerificationError("JSON array required")
    return list(value)


def string(value: object) -> str:
    if not isinstance(value, str):
        raise VerificationError("JSON string required")
    return value
