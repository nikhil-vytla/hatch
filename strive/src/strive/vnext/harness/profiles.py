"""Launch configuration is retained data. Native profiles remain unqualified
until an outer OS process-tree jail passes its own admission/escape tests.
"""
from dataclasses import dataclass
from pathlib import Path

from ..codec import encode
from ..contracts.primitives import ArtifactRef
from ..store.cas import CAS

DISABLED = ("tools", "mcp", "hooks", "plugins", "skills", "memory", "subagents",
            "session-sharing", "instructions-discovery", "retry", "compaction", "title")
NATIVE_RESIDUAL = ("Native CLI qualification requires a tested OS process-tree jail with per-process "
                   "gateway-only network, filesystem and keychain denial, hard memory and aggregate "
                   "storage limits; this host rejects Seatbelt sandbox_apply: Operation not permitted")


@dataclass(frozen=True)
class LaunchProfile:
    backend: str
    version: str
    executable: Path
    arguments: tuple[str, ...]
    configuration: bytes
    sandbox: bytes
    fixture_script: Path | None = None
    output_limit: int = 262144
    deadline_seconds: int = 10

    def references(self, objects: CAS) -> tuple[ArtifactRef, ArtifactRef, ArtifactRef]:
        executable = objects.publish(self.executable.read_bytes())
        config = objects.publish(self.configuration)
        sandbox = objects.publish(self.sandbox)
        return executable, config, sandbox

    def retained(self, objects: CAS) -> ArtifactRef:
        return objects.publish(encode((self.backend, self.version, self.arguments, self.references(objects),
                                       self.output_limit, self.deadline_seconds,
                                       objects.publish(self.fixture_script.read_bytes()) if self.fixture_script else None)))


def native_profile(backend: str, version: str, executable: Path, model: str, gateway_url: str) -> LaunchProfile:
    # These are proposals for qualification, not a claim that CLI flags create
    # an outer jail. Network endpoint and exact settings are operator-pinned.
    args: tuple[str, ...]
    config: dict[str, object]
    if backend == "opencode":
        args = ("run", "--pure", "--format", "json", "--title", "strive", "--agent", "strive", "--model", model)
        config = {"permission": {"*": "deny"}, "mcp": {}, "plugin": [], "instructions": [],
                  "share": "disabled", "compaction": {"auto": False, "prune": False},
                  "agent": {"strive": {"mode": "primary", "tools": {"*": False}},
                            "title": {"disable": True}, "summary": {"disable": True},
                            "compaction": {"disable": True}},
                  "provider": {"openai": {"options": {"baseURL": gateway_url, "maxRetries": 0}}}}
    elif backend == "codex":
        args = ("exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
                "--sandbox", "read-only", "--model", model, "-")
        config = {"model_provider": "strive", "model_providers.strive.base_url": gateway_url,
                  "model_providers.strive.wire_api": "responses", "model_providers.strive.env_key": "STRIVE_GATEWAY_TOKEN",
                  "model_providers.strive.request_max_retries": 0, "model_providers.strive.stream_max_retries": 0,
                  "mcp_servers": {}, "project_doc_max_bytes": 0, "web_search": "disabled",
                  "features": {"shell_tool": False, "multi_agent": False, "memories": False, "apps": False}}
    elif backend == "claude-code":
        args = ("--print", "--bare", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--disable-slash-commands", "--setting-sources", "", "--no-session-persistence", "--output-format", "json", "--model", model)
        config = {"ANTHROPIC_BASE_URL": gateway_url, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                  "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "MAX_THINKING_TOKENS": "0"}
    else:
        raise ValueError("no built-in profile for registry key")
    import json
    return LaunchProfile(backend, version, executable, args, json.dumps(config, sort_keys=True).encode(),
                         encode(("native-unqualified/1", DISABLED, NATIVE_RESIDUAL)))


def fixture_profile(backend: str, executable: Path, script: Path) -> LaunchProfile:
    """Exact Deno entry argv, separate from the outer rlimit exec wrapper."""
    arguments = ("run", "--quiet", "--no-prompt", "--no-config", "--no-lock", "--no-npm", "--cached-only",
                 "--no-code-cache", "--deny-read", "--deny-write", "--deny-env", "--deny-run", "--deny-ffi",
                 "--deny-sys", "--deny-import", "--deny-net", "--v8-flags=--max-old-space-size=64", str(script.resolve()))
    return LaunchProfile(backend, "fixture/1", executable.resolve(), arguments, b'{"native_features":"disabled"}',
        encode(("deno-permissions/1", "no-network: inherited gateway pipe only", "no-read-write-env-run-ffi-import",
                "hard OS memory/storage deferred")), script.resolve())
