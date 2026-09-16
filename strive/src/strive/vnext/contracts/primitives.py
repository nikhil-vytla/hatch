"""Shared values. Construction validates shape, never producer authenticity."""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
import re
from typing import NewType

RunId = NewType("RunId", str)
RecordId = NewType("RecordId", str)
CommandId = NewType("CommandId", str)
InvocationId = NewType("InvocationId", str)
EffectId = NewType("EffectId", str)
RevisionId = NewType("RevisionId", str)
LineageId = NewType("LineageId", str)
EnvironmentId = NewType("EnvironmentId", str)
EpisodeId = NewType("EpisodeId", str)
TrajectoryId = NewType("TrajectoryId", str)


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    """Retained content identity, distinct from every execution identity."""

    digest: str

    def __post_init__(self) -> None:
        if re.fullmatch(r"sha256:[0-9a-f]{64}", self.digest) is None:
            raise ValueError("artifact reference must be sha256:<64 lowercase hex digits>")


@dataclass(frozen=True, slots=True)
class Usd:
    """Exact fixed units: one nanodollar is 10^-9 USD."""

    nanodollars: int

    def __post_init__(self) -> None:
        if type(self.nanodollars) is not int or self.nanodollars < 0:
            raise ValueError("nanodollars must be a nonnegative integer")

    @classmethod
    def from_decimal(cls, value: Decimal) -> "Usd":
        if not value.is_finite() or value < 0:
            raise ValueError("USD must be finite and nonnegative")
        # Decimal tuple arithmetic avoids rounding under the caller's context.
        sign, digits, exponent = value.as_tuple()
        assert isinstance(exponent, int)
        coefficient = int("".join(str(digit) for digit in digits))
        shift = exponent + 9
        if shift < 0:
            divisor = 10 ** -shift
            if coefficient % divisor:
                raise ValueError("USD must be exactly representable in nanodollars")
            coefficient //= divisor
        else:
            coefficient *= 10 ** shift
        return cls(coefficient)


class TrustMode(StrEnum):
    TRUSTED = "trusted"
    RESEARCH = "research"


class ModelRole(StrEnum):
    ACTOR = "actor"
    REFINER = "refiner"
    USER = "user"


class Resource(StrEnum):
    USD_NANODOLLARS = "usd_nanodollars"
    TOKENS = "tokens"
    INPUT_TOKENS = "input_tokens"
    OUTPUT_TOKENS = "output_tokens"
    MODEL_CALLS = "model_calls"
    WALL_MILLISECONDS = "wall_milliseconds"


@dataclass(frozen=True, slots=True)
class ResourceQuantity:
    resource: Resource
    quantity: int

    def __post_init__(self) -> None:
        if type(self.quantity) is not int or self.quantity < 0:
            raise ValueError("resource quantity must be a nonnegative integer")


@dataclass(frozen=True, slots=True)
class Reservation:
    components: tuple[ResourceQuantity, ...]
    bound_method: ArtifactRef

    def __post_init__(self) -> None:
        if len({item.resource for item in self.components}) != len(self.components):
            raise ValueError("reservation components must be unique")


@dataclass(frozen=True, slots=True)
class AccessScope:
    run_id: RunId
    lineage_id: LineageId
    grant: ArtifactRef


@dataclass(frozen=True, slots=True)
class ScopedArtifact:
    reference: ArtifactRef
    access_scope: AccessScope


class ExecutionStatus(StrEnum):
    CONTINUE = "continue"
    SUSPENDED = "suspended"
    FINISHED = "finished"  # Completion does not certify workload success.


@dataclass(frozen=True, slots=True)
class ResultCursor:
    effect_id: EffectId
    return_record_id: RecordId


class IntegrationLevel(StrEnum):
    MODEL = "model"
    EXECUTOR = "executor"  # Reserved; rejected by release-1 manifest validation.


class SeedSupport(StrEnum):
    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class RequestedModelIdentity:
    provider: str
    model: str
    harness_native_identifier: str | None


@dataclass(frozen=True, slots=True)
class WireModelIdentity:
    provider_endpoint: str
    model: str


@dataclass(frozen=True, slots=True)
class ObservedModelIdentity:
    """Absent provider identity is represented by None at the containing field."""

    model: str
    revision: str | None
    original_field: str
    provenance: ArtifactRef
