from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath
from typing import Mapping

from .canonical import content_id, validate_content_id, validate_digest


def _nonempty(value: str, field: str) -> str:
    if not value or value.strip() != value or "\x00" in value:
        raise ValueError(f"{field} must be non-empty, trimmed, and NUL-free")
    return value


def validate_relative_path(value: str) -> str:
    _nonempty(value, "path")
    path = PurePosixPath(value)
    if path.is_absolute() or value != path.as_posix() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("path must be a normalized relative POSIX path")
    return value


@dataclass(frozen=True)
class Provenance:
    origin: str
    revision: str
    license_id: str

    def __post_init__(self) -> None:
        _nonempty(self.origin, "origin")
        _nonempty(self.revision, "revision")
        _nonempty(self.license_id, "license_id")


@dataclass(frozen=True)
class DomainSourceIdentity:
    domain: str
    source_uri: str
    source_revision: str
    split: str
    record_id: str

    def __post_init__(self) -> None:
        if self.domain != "gsm8k":
            raise ValueError("this package currently admits only the gsm8k domain")
        for name in ("source_uri", "source_revision", "split", "record_id"):
            _nonempty(getattr(self, name), name)

    @property
    def id(self) -> str:
        return content_id("domain-source", self)


@dataclass(frozen=True)
class AssetEntry:
    name: str
    media_type: str
    byte_length: int
    digest: str
    provenance: Provenance

    def __post_init__(self) -> None:
        validate_relative_path(self.name)
        _nonempty(self.media_type, "media_type")
        if self.byte_length < 0:
            raise ValueError("byte_length cannot be negative")
        validate_digest(self.digest)


@dataclass(frozen=True)
class AssetManifest:
    assets: tuple[AssetEntry, ...]
    schema: str = "parallax.asset-manifest.v1"

    def __post_init__(self) -> None:
        if not self.assets:
            raise ValueError("asset manifest cannot be empty")
        names = tuple(asset.name for asset in self.assets)
        if names != tuple(sorted(names)) or len(set(names)) != len(names):
            raise ValueError("assets must be uniquely named and sorted")

    @property
    def id(self) -> str:
        return content_id("asset-manifest", self)

    def verify_bytes(self, available: Mapping[str, bytes]) -> None:
        from .canonical import sha256_digest

        expected = {asset.name for asset in self.assets}
        if set(available) != expected:
            raise AdmissionError("available assets do not exactly match the manifest")
        for asset in self.assets:
            data = available[asset.name]
            if len(data) != asset.byte_length or sha256_digest(data) != asset.digest:
                raise AdmissionError(f"asset commitment mismatch: {asset.name}")


@dataclass(frozen=True)
class ImplementationCommitment:
    role: str
    implementation_digest: str
    policy_id: str

    def __post_init__(self) -> None:
        _nonempty(self.role, "role")
        validate_digest(self.implementation_digest)
        validate_content_id(self.policy_id)


@dataclass(frozen=True)
class RuntimePolicy:
    implementation: str
    python_requirement: str
    dependencies: tuple[str, ...]
    network_allowed: bool = False
    schema: str = "parallax.runtime-policy.v1"

    def __post_init__(self) -> None:
        _nonempty(self.implementation, "implementation")
        _nonempty(self.python_requirement, "python_requirement")
        if self.dependencies != tuple(sorted(set(self.dependencies))):
            raise ValueError("dependencies must be unique and sorted")

    @property
    def id(self) -> str:
        return content_id("runtime-policy", self)


@dataclass(frozen=True)
class VerifierCommitment:
    evaluator: ImplementationCommitment
    parser: ImplementationCommitment
    answer_authority_digest: str
    asset_manifest_id: str
    runtime_policy: RuntimePolicy
    schema: str = "parallax.verifier-commitment.v1"

    def __post_init__(self) -> None:
        validate_digest(self.answer_authority_digest)
        validate_content_id(self.asset_manifest_id, "asset-manifest")

    @property
    def id(self) -> str:
        return content_id("verifier-commitment", self)


@dataclass(frozen=True)
class PublicTaskIdentity:
    source: DomainSourceIdentity
    prompt: str
    public_asset_manifest_id: str
    schema: str = "parallax.public-task.v1"

    def __post_init__(self) -> None:
        _nonempty(self.prompt, "prompt")
        validate_content_id(self.public_asset_manifest_id, "asset-manifest")

    @property
    def id(self) -> str:
        return content_id("public-task", self)

    def as_record(self) -> dict[str, object]:
        return {
            "schema": self.schema,
            "id": self.id,
            "source": {
                "domain": self.source.domain,
                "source_uri": self.source.source_uri,
                "source_revision": self.source.source_revision,
                "split": self.source.split,
                "record_id": self.source.record_id,
                "id": self.source.id,
            },
            "prompt": self.prompt,
            "public_asset_manifest_id": self.public_asset_manifest_id,
        }


@dataclass(frozen=True)
class SealedTaskIdentity:
    public_task_id: str
    verifier_commitment_id: str
    sealed_evaluator_data_digest: str
    schema: str = "parallax.sealed-task.v1"

    def __post_init__(self) -> None:
        validate_content_id(self.public_task_id, "public-task")
        validate_content_id(self.verifier_commitment_id, "verifier-commitment")
        validate_digest(self.sealed_evaluator_data_digest)

    @property
    def id(self) -> str:
        return content_id("sealed-task", self)


@dataclass(frozen=True)
class NativeTask:
    public: PublicTaskIdentity
    sealed: SealedTaskIdentity
    verifier: VerifierCommitment
    assets: AssetManifest
    answer_authority: str


class Verdict(str, Enum):
    PASS = "pass"
    TASK_FAILURE = "task_failure"
    INVALID_SUBMISSION = "invalid_submission"
    HARNESS_FAILURE = "harness_failure"
    VERIFIER_FAILURE = "verifier_failure"


@dataclass(frozen=True)
class GradeResult:
    verdict: Verdict
    reason: str
    evidence_id: str
    schema: str = "parallax.grade-result.v1"

    def __post_init__(self) -> None:
        _nonempty(self.reason, "reason")
        validate_content_id(self.evidence_id, "grade-evidence")


class AdmissionError(ValueError):
    """A task does not match its committed verifier or assets."""


class InvalidSubmission(ValueError):
    """Model output does not satisfy the committed parser policy."""
