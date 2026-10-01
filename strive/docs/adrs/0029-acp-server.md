# ADR-0029: `strive acp`: editors drive a strive session over the Agent Client Protocol

Status: accepted (2026-10-01). Stage 3, "Reach".

## Context

Zed, JetBrains IDEs, Neovim and others talk to coding agents over the Agent
Client Protocol (ACP): JSON-RPC on an agent's stdio, with the editor
showing the conversation, tool calls and permission prompts. Claude Code
and Codex reach editors through adapters (`claude-code-acp`, `codex-acp`)
that wrap their own clients. strive already has a protocol that any number
of clients attach to (the TUI, the desktop app, `strive run`).

## Decision

### The bridge is one more client

`strive acp` starts the daemon if it isn't running and runs a bridge that
speaks ACP on stdio and is an ordinary client of the daemon. It is not a
host: the agent loop still runs in the host the daemon starts, every
effect is still the daemon's, and the editor watches and approves like
the TUI does. A session started in an editor is a strive session: it can
be continued in the TUI or the desktop app, and the learner studies it.

The bridge uses `@agentclientprotocol/sdk`, pinned, and ships in the
`strive-tui` binary (`strive-tui acp`), which already carries the runtime.

### What maps to what

- `session/new` creates a session in the editor's `cwd`; `session/load`
  attaches to any strive session and replays it as updates.
- `session/prompt` sends the prompt's text. An embedded resource's text is
  inlined under its URI, a resource link is named, and images are refused
  (the prompt capabilities say so). It answers when that turn ends:
  `end_turn`, or `cancelled` if it was interrupted. A turn that failed or
  ran out of time ends with `end_turn` after a message saying why.
- `session/cancel` interrupts the turn.
- The reply streams as `agent_message_chunk`s. Each effect is a
  `tool_call` with its kind (`read`, `edit`, `execute`, `other`) and the
  file it touches, and a `tool_call_update` when it finishes.
- An approval is a `session/request_permission` with allow once, allow
  for the session (when the daemon offers it), and reject. An editor
  that cancels the prompt declines.
- Approval modes are ACP session modes (`ask`, `auto-edit`,
  `full-auto`), changed with `session/set_mode`.

### What the editor offers that strive doesn't take

- The editor's file system and terminal (`fs/*`, `terminal/*`): effects
  run in the daemon's sandbox, against the files on disk, so unsaved
  buffers aren't seen.
- MCP servers the editor passes to `session/new`: strive's come from its
  settings and run in the daemon. The bridge says so in the session once
  when an editor passes some.

## Consequences

- strive works in any ACP editor with one line of the editor's settings
  (Zed: `"type": "custom", "command": "strive", "args": ["acp"]`).
- The journal, budgets, sandbox and learning are the same for an editor's
  session as for any other.
- An editor sees what strive's protocol carries. A tool call's output
  isn't in the journal, so the editor is told how it ended (its exit code,
  or why it was refused), not its full text.
