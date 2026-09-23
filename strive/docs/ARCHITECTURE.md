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
| `crates/proto` | Protocol: JSON-RPC envelopes, method and notification declarations, events, TS export |
| `crates/journal` | Authenticated session journals: format, verification, crash recovery |
| `crates/strived` | The `strive` binary: CLI, launcher, daemon, sessions |
| `packages/protocol` | Generated TS types + the typed socket client |
| `packages/tui` | The terminal client |
| `packages/testkit` | Test helpers: a scratch-home daemon and a virtual terminal |

## Daemon lifecycle

- **Ownership:** an exclusive lock on `run/strived.lock` decides which process
  is the daemon. A leftover socket from a crash is removed by the lock holder,
  so racing starts produce exactly one daemon. An exiting daemon unlinks its
  socket before releasing the lock. A successor that finds the lock held but
  the socket silent waits for it instead of standing down, and the launcher
  retries every outcome (a daemon exiting mid-handshake, a lost lock race)
  until its deadline.
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

## Sessions and the journal

Each session is a directory under `~/.strive/sessions/<ULID>/`:

- **`journal.jsonl`** holds one entry per line: `{"seq","tsMs","event","mac"}`.
  The MAC is HMAC-SHA256 over the previous entry's MAC and this line's exact
  bytes. The chain starts from a value derived from the session id, so an
  edit, deletion, reordering or move between sessions fails at the first
  affected entry.
- **`head.json`** records the last committed entry and is MAC'd itself. That
  catches entries removed from the end and heads forged from a readable line.
- **The key** is `~/.strive/keys/journal.key`: 32 random bytes, mode 0600,
  created on first start. From M3 the agent's sandbox denies it.

**Writes.** One writer thread per open session owns the journal. Appends
queued while it was busy are committed together: one `fsync` of the journal,
then an atomic replace of the head. Only then does the writer broadcast the
entries to attached clients.

**Attach.** Attaching goes through the same thread and re-verifies the file
on disk. A new subscriber's history and its live stream therefore never
overlap or leave a gap, and a journal edited while the daemon ran is refused
on resume.

**Crash recovery.** Opening repairs only what a crash can leave behind. A
torn last line is cut and recorded as a `recovered` entry, and a head
behind the synced entries catches up. An invalid journal is refused and
never modified.

**Format contract.** The first line's bytes are pinned by a golden test,
whose MAC was computed independently with openssl.
