"""Runs inside the unchanged Linux jail; this file has only stdlib dependencies."""
import json
import os
from pathlib import Path
import subprocess
import sys


def main() -> None:
    payload = json.loads(sys.stdin.buffer.readline(1048576))
    executable, provider = sys.argv[1:]
    root = Path.cwd()
    reply_fd = os.dup(0)
    config = {
        "enabled_providers": ["strive"], "autoupdate": False, "share": "disabled", "plugin": [], "mcp": {}, "instructions": [],
        "permission": {"*": "deny"}, "compaction": {"auto": False, "prune": False},
        "agent": {"strive": {"mode": "primary", "tools": {"*": False},
                             "prompt": "Follow the supplied telecom protocol. Return only the requested JSON."},
                  "title": {"disable": True}, "summary": {"disable": True}, "compaction": {"disable": True}},
        "provider": {"strive": {"npm": Path(provider).as_uri(), "name": "Strive budget gateway",
            "models": {"gpt-5.6-luna": {"name": "Luna", "limit": {"context": 32768, "output": payload["max_output_tokens"]},
                "toolcall": False}}, "options": {"apiKey": "effect-scoped-pipe", "maxRetries": 0}}}}
    config_path = root / "opencode.json"
    config_path.write_text(json.dumps(config))
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root), "NO_COLOR": "1",
        "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
        "XDG_STATE_HOME": str(root / "state"), "OPENCODE_CONFIG": str(config_path),
        "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true", "OPENCODE_DISABLE_MODELS_FETCH": "true",
        "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
        "OPENCODE_DISABLE_CLAUDE_CODE": "true", "STRIVE_REPLY_FD": str(reply_fd),
        "STRIVE_GATEWAY_TOKEN": payload["token"], "STRIVE_OUTPUT_TOKENS": str(payload["max_output_tokens"])}
    try:
        result = subprocess.run([executable, "run", "--format", "json", "--title", "strive", "--agent", "strive",
            "--model", "strive/gpt-5.6-luna", payload["input"]], env=environment, stdin=subprocess.DEVNULL, pass_fds=(reply_fd,))
    finally:
        os.close(reply_fd)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
