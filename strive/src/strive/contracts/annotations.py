"""Open diagnostics. Payload keys are opaque claims, never authority fields."""

from dataclasses import dataclass
import json
from typing import Final

MAX_ANNOTATION_BYTES: Final = 65_536


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-JSON numeric constant: {value}")


@dataclass(frozen=True, slots=True)
class Annotation:
    namespace: str
    payload: bytes

    def __post_init__(self) -> None:
        if "." not in self.namespace or any(not part for part in self.namespace.split(".")):
            raise ValueError("annotation namespace must have nonempty dotted components")
        if len(self.payload) > MAX_ANNOTATION_BYTES:
            raise ValueError("annotation exceeds per-record byte quota")
        try:
            json.loads(self.payload.decode("utf-8"), parse_constant=_reject_constant)
        except (ValueError, RecursionError) as error:
            raise ValueError("annotation payload must be bounded UTF-8 JSON") from error
