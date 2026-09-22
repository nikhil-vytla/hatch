# Architecture

```
strive (CLI) ── starts or attaches ──► strived (daemon, one per user)
                                          journal + CAS · budget ledger · model gateway
                                          fs/shell effects in the sandbox · checkpoints
        JSON-RPC 2.0, NDJSON, Unix socket │ ~/.strive/run/strived.sock (0600)
   ┌──────────────┬───────────────────────┼───────────────────┐
agent host      TUI (pi-tui)          desktop (Electron)   headless / ACP
(pi-agent-core)
```

The daemon owns everything that must be trusted. Clients render and forward
intent. The agent host is a client too: its tools are daemon RPCs and its model
calls go through the daemon's gateway. Why: [ADR-0015](adrs/0015-rebuild-daemon-and-host.md).

## Layout

| Path | What |
| --- | --- |
| `crates/proto` | Protocol: JSON-RPC envelopes, method declarations, TS export |
| `crates/strived` | The `strive` binary: CLI, launcher, daemon |
| `packages/protocol` | Generated TS types + the typed socket client |
| `packages/tui` | The terminal client |

## Daemon lifecycle

- **Ownership:** an exclusive lock on `run/strived.lock` decides which process
  is the daemon. A leftover socket from a crash is removed by the lock holder,
  so racing starts produce exactly one daemon.
- **Staleness:** `initialize` returns a build id (version plus the binary's
  inode, size and mtime). When it differs from the caller's own, the caller
  asks the old daemon to shut down and starts a new one.
- **Idle exit:** after `STRIVE_IDLE_SECS` (default 900) with no clients.
- **State:** everything lives under `~/.strive`, or `STRIVE_HOME`. Directories
  are 0700 and the socket is 0600.

## Protocol

JSON-RPC 2.0, one message per line. `initialize` must come first and the
protocol versions must match exactly. Error codes: `-32002` not initialized,
`-32003` protocol mismatch, plus the standard JSON-RPC codes. Methods are
declared once in `crates/proto/src/lib.rs`. `cargo test` regenerates
`packages/protocol/src/generated/`, and `scripts/check.sh` fails if the
committed copy differs.
