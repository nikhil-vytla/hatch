"""Shared authored/resolved binding shapes; registry names remain open."""

from dataclasses import dataclass
from typing import Literal

from .primitives import ArtifactRef, IntegrationLevel, SeedSupport


@dataclass(frozen=True, slots=True)
class ModelBinding[Ref]:
    provider: str
    model: str
    request_options: Ref
    max_input_tokens: int
    max_output_tokens: int
    fallback: Literal["forbid"]
    harness: str | None = None

    def __post_init__(self) -> None:
        if not self.provider or not self.model:
            raise ValueError("provider and model must be explicit")
        if self.max_input_tokens <= 0 or self.max_output_tokens <= 0:
            raise ValueError("model token limits must be positive")
        if self.fallback != "forbid":
            raise ValueError("release 1 forbids model fallback")


@dataclass(frozen=True, slots=True)
class HarnessBinding[Ref]:
    interface: Literal["strive.harness/1"]
    backend: str
    adapter: Ref
    executable: Ref
    version: str
    level: IntegrationLevel
    launch_profile: Ref
    sandbox_profile: Ref
    model_transport: Literal["broker_gateway"]
    native_tools: Literal["none"]
    session_policy: Literal["fresh"]
    max_provider_requests: Literal[1]
    deadline_seconds: int

    def __post_init__(self) -> None:
        if self.interface != "strive.harness/1":
            raise ValueError("unsupported harness interface")
        if self.level is not IntegrationLevel.MODEL:
            raise ValueError("release 1 supports only harness-as-model")
        if (self.model_transport != "broker_gateway" or self.native_tools != "none"
                or self.session_policy != "fresh"
                or type(self.max_provider_requests) is not int
                or self.max_provider_requests != 1):
            raise ValueError("harness requires broker_gateway, no tools, fresh session, and one request")
        if not self.backend or not self.version or self.deadline_seconds <= 0:
            raise ValueError("harness backend, version, and positive deadline are required")


@dataclass(frozen=True, slots=True)
class ModelResolution:
    """Effective nonsecret provider settings retained before any dispatch."""

    provider_endpoint: str
    account_binding: str  # Opaque external credential binding; never credentials.
    protocol: str
    price_schedule: ArtifactRef
    bound_method: ArtifactRef
    effective_request_options: ArtifactRef
    harness_seed_support: SeedSupport | None  # None for direct provider adapter.
    provider_seed_support: SeedSupport
    harness_native_identifier: str | None
