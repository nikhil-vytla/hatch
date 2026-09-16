"""Open backend registry; these keys are not core enums."""
from collections.abc import Mapping

from ...contracts.bindings import ModelBinding
from ...contracts.manifest import NamedHarness
from ...contracts.primitives import ArtifactRef
from ...errors import VerificationError
from ...store.cas import CAS
from ..profiles import LaunchProfile
from ..provider import ProviderContract
from .base import TextHarnessAdapter
from .opencode import OpenCodeAdapter
from .codex import CodexAdapter
from .claude_code import ClaudeCodeAdapter

REGISTRY: Mapping[str, type[TextHarnessAdapter]] = {
    "opencode": OpenCodeAdapter, "codex": CodexAdapter, "claude-code": ClaudeCodeAdapter,
}


def resolve(model: ModelBinding[ArtifactRef], harnesses: tuple[NamedHarness[ArtifactRef], ...],
            objects: CAS, profiles: Mapping[ArtifactRef, LaunchProfile], provider: ProviderContract,
            registry: Mapping[str, type[TextHarnessAdapter]] = REGISTRY) -> TextHarnessAdapter:
    matches = [item.binding for item in harnesses if item.name == model.harness]
    if len(matches) != 1:
        raise VerificationError("manifest harness registry binding unavailable")
    binding = matches[0]
    profile = profiles.get(binding.launch_profile)
    implementation = registry.get(binding.backend)
    if profile is None or implementation is None or profile.backend != binding.backend:
        raise VerificationError("retained launch profile or registry implementation unavailable")
    adapter = implementation(objects, profile, provider)
    executable, _, sandbox = profile.references(objects)
    if (adapter.identity != binding.adapter or executable != binding.executable or sandbox != binding.sandbox_profile
            or profile.version != binding.version or profile.retained(objects) != binding.launch_profile
            or profile.deadline_seconds != binding.deadline_seconds):
        raise VerificationError("manifest executable/configuration/adapter closure changed")
    return adapter
