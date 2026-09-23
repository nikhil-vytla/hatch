# MCP servers

Servers named in `mcpServers` in the run's `settings.json` start when the session's agent first registers, in the session's directory. The agent sees each tool as `mcp__server__tool`. A call is an effect: it asks first unless approvals are full-auto, and it is journaled with its arguments. A server that fails to start is shown in the TUI.

## Sub-features

- `mcp-tools` the agent is given every tool, across `tools/list` pages.
- `mcp-call` a call asks `Allow the agent to use SERVER's TOOL tool?`, then returns the tool's text to the model.
- `mcp-failed` a server that doesn't start shows `MCP server NAME didn't start: WHY`.
- `mcp-log` `strive log` shows `mcp: SERVER's TOOL` and how each server started (`agent context: ...; MCP ...`).

## How to get to it (user POV)

Add a server to `~/.strive/settings.json` (`{"mcpServers": {"name": {"command": "...", "args": [...]}}}`), open `strive`, and ask for something the tool does.

## Driving it with strive-verify

1. `cargo build --examples` builds `target/debug/examples/fake_mcp` (tools: `echo`, `fail`, `slow`, `where`).
2. Before `start`, write `/tmp/strv-verify-NAME/settings.json` with `{"model": "claude-haiku-4-5", "budget": {"usd": 0.5}, "mcpServers": {"fake": {"command": "ABSOLUTE/PATH/target/debug/examples/fake_mcp"}}}`. `start` keeps an existing home.
3. `send NAME "Use the fake MCP server's echo tool to echo the word strive."`, then `wait NAME "Allow the agent to use fake's echo tool?" 90` and `type NAME y`.
4. Confirm from a second view: `cli NAME log` shows `mcp: fake's echo`. The effect's output blob in `/tmp/strv-verify-NAME/cas/sha256/` reads `echo: strive`.
5. For `mcp-failed`, name a server whose `command` doesn't exist. The line appears once the agent registers, which happens on the first prompt.

## Gotchas

- Settings are read when the daemon starts. After editing them, `cli NAME stop` and send again.
- A real model call costs money. Use Haiku and a small budget, as above.
- The server's stderr goes to `sessions/ID/mcp-NAME.log` in the run's home.
