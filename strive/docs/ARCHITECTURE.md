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
| `crates/budget` | Prices, costs, reservations and the ledger rebuilt from journal events |
| `crates/gateway` | Provider wire formats: which API, what a request asks for, usage from bodies and streams |
| `crates/strived` | The `strive` binary: CLI, launcher, daemon, sessions |
| `packages/protocol` | Generated TS types + the typed socket client |
| `packages/tui` | The terminal client; its binary also runs the agent host |
| `packages/host` | The agent host: pi-agent-core loop, tools as daemon effects |
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

**Creation and failure.**
- Creating a session is atomic. The journal and head are built in a staging
  directory and renamed into place, so a session is listable only once it
  can be opened.
- After any failed write, the writer stops and the journal refuses further
  appends. The next request reopens it, which repairs the tail.
- A prompt whose write failed may still be in the journal. Its line can be
  synced before the head write fails, so an error means "not confirmed",
  not "not saved".
- On shutdown the daemon joins every writer before releasing its ownership
  lock.
- Temp files are created exclusively and never follow symlinks.

**What the journal does not catch.** Someone who can write the user's files,
and who kept an older copy of a session's `head.json`, can restore that head
and truncate the journal to match. The result verifies. Detecting this
rollback needs a counter the attacker can't roll back, which a local file
can't provide. The agent's sandbox denies `~/.strive` entirely, so an agent
can't do this. A person with the user's file access can.

## The model gateway

Model calls go through a loopback HTTP proxy in the daemon, never straight
to a provider. `session/gateway` (or `strive gateway`) returns base URLs
holding a secret token for one session, so any Anthropic or OpenAI SDK works
by changing its base URL.

**Per call:**
1. **Admit.** The gateway refuses a call before sending anything when:
   - the token is unknown;
   - the API or model isn't supported, or the model has no known price;
   - there is no key;
   - its worst-case cost doesn't fit what the session has left.

   The worst case bounds input by the request's bytes and the context
   window, and output by the request's cap or the model's maximum, all at
   full input price. Refusals come back in the calling SDK's own error
   format.
2. **Record the start.** The exact request bytes go into the content
   store. The reservation and a `modelCallStarted` entry are then written in
   one step on the session's writer.
3. **Forward.** The provider key comes from `~/.strive/credentials.json`
   (0600, set by `strive auth`) or the daemon's environment at start. The
   agent's own credential headers are dropped.
4. **Stream back and meter.** Bytes pass through unchanged while usage is
   read from the body or stream. For streaming Chat Completions, the
   gateway asks for usage.
5. **Record the end.** The exact response bytes are stored and
   `modelCallFinished` is written. Only then does the client's response
   end, so a finished response implies a journaled cost.

**What each outcome costs:**

| Outcome | Charged |
| --- | --- |
| Complete | Its usage at the model's prices |
| Rejected (a provider error status) | Nothing |
| Broken (stream cut, client gone, request failed after sending) | The full reservation |
| Started but never finished (daemon crash) | The full reservation, closed explicitly as broken on the next open |

**Budget records.** A session's limits are a `budgetSet` entry written at
creation from settings, $5 by default, and changed with `session/budget`
(`/budget` in the TUI). Editing settings later never changes an existing
session's budget.

## The agent

**Hosts.** When a prompt arrives and no host is registered for the
session, the daemon starts one: `strive-tui host --session ID`, one binary
with one runtime. A host registers with `host/register`, which returns the
agent config (model, gateway URL, limits), then attaches to the session.
Hosts don't count as clients for idle exit.

**The loop.** The host runs pi-agent-core with four tools: read, write,
edit and bash.
- Every tool call is an `effect/run` performed by the daemon, in the
  sandbox and subject to approvals.
- Every model call goes through the session's gateway, with a placeholder
  key.
- The host therefore holds no keys and touches no files.

**The journal is the conversation.** The host records `turnStarted`,
`assistantMessage` and `turnEnded`. `assistantMessage` carries the display
text, the tool calls, and the exact message fed back on resume. Tool
results are rebuilt from the daemon's effect records, never from the host,
and a tool call that never ran gets an explicit result.
- A restarted host resumes the whole conversation.
- A turn cut off by a host crash is closed as failed.
- Live reply text travels as `session/delta` and is not journaled.
- Only people, never hosts, can answer approvals.

## Approvals and checkpoints

**Approval modes** are journaled per session:
- `ask`: every change and command asks.
- `autoEdit` (the default): changes in the workspace are free; commands ask.
- `fullAuto`: everything inside the workspace and sandbox is free.

In every mode, writes outside the workspace and commands without a sandbox
ask, and strive's own state is refused. An approval request is a journal
entry, so every attached client sees it and the first answer wins. With no
one attached, the request is refused at once.

**Checkpoints** snapshot the workspace before each prompt, into a shadow
git repository in the session's directory. The user's own repository,
config and hooks never take part. A rewind first saves the current files,
so it can be undone.
