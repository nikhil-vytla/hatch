"""Small, strict data helpers for non-authority workflow artifacts."""
from dataclasses import fields, is_dataclass
from decimal import Decimal
from enum import Enum
import base64
import json
from pathlib import Path
import re
import tomllib

from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..store.cas import atomic_file, durable_directory


def plain(value: object) -> object:
    if isinstance(value, ArtifactRef):
        return value.digest
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode()}
    if is_dataclass(value) and not isinstance(value, type):
        return {f.name: plain(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = sorted(value, key=str) if isinstance(value, (set, frozenset)) else value
        return [plain(v) for v in items]
    return value


def json_bytes(value: object) -> bytes:
    return json.dumps(plain(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(k, str) for k in value):
        raise VerificationError("expected a string-keyed table")
    return {str(k): v for k, v in value.items()}


def read_json(data: bytes) -> dict[str, object]:
    return mapping(json.loads(data))


def string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise VerificationError("expected nonempty string")
    return value


def integer(value: object, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise VerificationError(f"expected integer >= {minimum}")
    return value


def sequence(value: object) -> list[object]:
    if not isinstance(value, list):
        raise VerificationError("expected array")
    return value


def keys(table: dict[str, object], required: str, optional: str = "") -> None:
    if set(required.split()) - table.keys() or table.keys() - set((required + " " + optional).split()):
        raise VerificationError(f"invalid keys: expected {required}; optional {optional}")


def local_id(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is None:
        raise VerificationError("invalid local identity")
    return value


def write_json(path: Path, value: object, *, replace: bool = False) -> None:
    durable_directory(path.parent)
    atomic_file(path, json_bytes(value), replace=replace)


def toml(data: dict[str, object]) -> str:
    """Render the authored subset; no expressions, merges or executable values."""
    lines: list[str] = []
    def scalar(value: object) -> str:
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, list):
            return "[" + ", ".join(scalar(v) for v in value) + "]"
        if type(value) not in (str, bool, int, float):
            raise VerificationError("unsupported TOML value")
        return json.dumps(value, allow_nan=False)
    def visit(table: dict[str, object], path: tuple[str, ...]) -> None:
        if path:
            lines.append("[" + ".".join(json.dumps(p) for p in path) + "]")
        for k, v in table.items():
            if not isinstance(v, dict):
                lines.append(json.dumps(k) + " = " + scalar(v))
        for k, v in table.items():
            if isinstance(v, dict):
                visit(mapping(v), (*path, k))
    visit(data, ())
    result = "\n".join(lines) + "\n"
    tomllib.loads(result)
    return result
