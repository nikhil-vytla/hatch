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
| `crates/learning` | Trusted learning's pure parts: where proposals write, the static gate's text checks, proposal status |
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
agent config (model, gateway URL, limits, project context, MCP tools), then
attaches to the session. Hosts don't count as clients for idle exit.
- **The model** is the session's own if a person chose one with
  `session/model` (journaled as `modelSet`), else settings'. It can be
  chosen only before the first prompt, since a host may start on it then;
  `model/list` lists the priced models to choose from.
- One host per session: registration is exclusive.
- A host must register before it attaches.
- Only the session's host may record turns or stream text for it.
- A host can't answer approvals, change approval modes or budgets, rewind,
  ask the learner to run, or decide on or roll back a proposal.

**Trust.** The daemon enforces what the agent may *ask* for: every file
change, command and model call goes through it. The host itself still
runs as the user, unsandboxed. The host-only restrictions above guard
against the agent loop's mistakes. They don't stop a hostile host (say, a
compromised dependency), which could act without the daemon. It could, for
instance, open a second connection and approve its own effects there.
Confining the host process to the daemon's socket and gateway is planned.

**Context.** Registration loads the project's context:
- **Instructions:** `AGENTS.md` (or `CLAUDE.md`) from the repository root
  down to the workspace, after `~/.strive/AGENTS.md`.
- **Skills:** SKILL.md files from `.strive/skills`, `.claude/skills` and
  `~/.strive/skills`.
- **Memory:** `.strive/memory.md`, the last instruction file, labeled as
  memory a person reviewed. Its `@` lines stay text. The same rules
  apply: regular files only, never from strive's home.
- **MCP servers:** the stdio servers in `mcpServers` in settings.
  - They are started for the session in its directory, without strive's
    variables or provider keys.
    - Servers are user-configured programs and run unsandboxed, as in other
    agents.
    - A server's process group is killed when the daemon stops (even
    mid-startup), when a write to it stalls or its queue fills, when its
    output ends, and when it doesn't answer a cancelled call within 2s.
    A call fails only once its server has exited, so nothing it does lands
    after the effect ends. A killed server restarts on its next call.
  - MCP lets a server stay silent about a cancelled call. strive still
    stops one that does: silence can't show that a file-changing tool has
    stopped, and the workspace must be free for a rewind. Other calls to
    that server fail when it is stopped.
  - A process that leaves the group (`setsid`) is out of reach.
- `contextLoaded` journals what was loaded and how each server started.
- Before a turn, a conversation past `compactAtTokens` is summarized. The
  summary is journaled as `compacted` and replaces what it covers on
  resume.

**The loop.** The host runs pi-agent-core with read, write, edit and bash,
plus each MCP tool as `mcp__server__tool`.
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
- `turnStarted` records the last prompt the turn took (`throughSeq`). A
  prompt sent while a turn runs is rebuilt after that turn's reply, and
  still runs if the host restarts first.
- Interrupting a turn (Esc, or its time limit) cancels its effects with
  `effect/cancel`.
- If a host's connection closes mid-turn, the daemon ends that turn as
  failed, so anyone waiting on it (`strive run`) finds out.

## Trusted learning

Why: [ADR-0016](adrs/0016-trusted-learning.md). The learner proposes; the
daemon checks; a person decides; the daemon writes.

**The learning session.** Each project directory has one, found or created
by `learning/open`. Its `sessionStarted` says `kind: learning`.
- Lists people pick from leave it out: `session/list` returns work
  sessions unless asked for `kind: learning`, so `strive sessions`,
  continue and the desktop's sidebar never offer it. `strive verify --all`
  asks for both, since the learning journal records who accepted what.
- `learning/run` (people only) journals `learnRequested`, naming work
  sessions of the project or none, and starts the session's host. Prompts
  to a learning session are refused.

**What its host may do.** Its `host/register` returns `kind: learning`,
no MCP tools, and `learnedFiles`: the project's memory and skills, each
whole and exactly as on disk. Files a proposal couldn't replace are left
out: not regular, reached through a symlink, in strive's home, or over
64 KiB. `contextLoaded.learned` journals their digests.
- It records turns, messages, summaries and `proposalMade`. Nothing else:
  no gates, decisions or layouts, and no effects.
- A work session's host can't record `proposalMade`.

**The learner.** A learning session's host (`AgentConfig.kind` is
`learning`, [ADR-0016](adrs/0016-trusted-learning.md)) runs the learner
with the same turn machinery: a `learnRequested` entry is a turn's
prompt, as `userMessage` is for the coding agent.
- Its tools read, and nothing else: `list_sessions` (`session/list`),
  `read_session` (`session/read` and `blob/get`, rendered in pages within
  a token budget), `read_artifact` (memory and skills from its config)
  and `propose_change`, which records `proposalMade`. It has no effect
  tools and no MCP tools.
- A proposal's result is its id and the daemon's static check, or the
  daemon's refusal. At most three are recorded a turn.
- Read tools' output isn't journaled, so on resume their calls say to
  call them again.

**A proposal.** On `proposalMade` the daemon, holding the project's lock:
1. runs the static gate;
2. takes `before`, the file as the learner was last shown it (none if it
   wasn't there), from the latest `contextLoaded`. A host can't supply it;
3. journals the proposal and every gate's `gateFinished` in one commit.
   The proposal's id is its entry's seq.

**The static gate** (`strive-learning` for the text, the daemon for the
machine). Every finding is listed in the gate's detail:
- **Path:** a skill name is 1 to 40 of `a-z0-9-`. The file resolves
  inside the project's `.strive/` with no symlink on the way, is a regular
  file if it exists, and isn't in strive's home (a project at `~`).
- **Size:** memory ≤ 16 KiB, a skill ≤ 32 KiB.
- **Form:** a skill's frontmatter names it and describes it; the summary
  is one line; there is a rationale and a prediction.
- **Secrets**, in the content, summary and rationale: key shapes (`sk-`,
  GitHub, Slack, Google, AWS, private keys) and the stored API keys by
  value. The detail never repeats the secret.
- **Weakening strive:** phrases that bypass approvals, weaken the sandbox,
  touch strive's own state or settings (its home, the journal, memory and
  skills themselves), or tell the agent to ignore the user; piping a
  download to a shell. The lists are broad on purpose: a false alarm
  costs a look.
- **Evidence:** at least one session. Each is a work session of this
  project whose journal verifies, and each cited seq is one of its entries.

**The judge gate** ([ADR-0017](adrs/0017-judge-gate.md)): the daemon's
own model call, through its gateway with the learning session's token, so
it is admitted, held, journaled and charged like any call of that session.
- **What it's shown**, as one JSON document the system prompt calls data:
  the proposal, the file it replaces and the other memory and skills as
  the learner was shown them, the cited sessions (cited entries kept
  first), and up to three held-out sessions: the project's newest work
  sessions the proposal doesn't cite, begun before it, with a prompt and a
  journal that verifies. Nothing of the learning session's own goes in.
- **The rubric** (`strive_learning::judge::RUBRIC`): supported, generalizes,
  novel, safe, checkable. The model must answer with one forced
  `record_verdict` call. It passes only if every criterion and the verdict
  say pass. An answer that can't be read strictly fails.
- **Skipped**, with the reason, and journaled with the proposal: after a
  static failure, with no Anthropic key, no price for the model, or no
  session to hold out. Skipped later if the learning session's budget
  can't pay. Failed if the provider refuses or the call breaks.
- **In the background:** otherwise the proposal stays `checking` while the
  call runs, without the project's lock. The verdict is journaled under the
  lock, and only if there isn't one. A set of running judges keeps a list
  from starting a second. After a crash, the next list or decision judges
  again.
- The model is `judgeModel` in settings, else `model`.

The replay gate (M10) is journaled as skipped, saying it isn't built yet,
or that the static check failed.

**Status**, folded from the learning journal:

| Status | When |
| --- | --- |
| `checking` | a gate has no verdict yet |
| `failed` | a gate failed |
| `ready` | every gate passed or was skipped |
| `rejected` | a person rejected it |
| `applied` | accepted and written (`proposalApplied`) |
| `stale` | accepted, but the file wasn't as the learner saw it, so nothing was written |
| `rolledBack` | an applied one, undone |

Gates a crash cut short (a proposal with no verdicts) are run again on the
next `proposal/list` or decision.

**Deciding.** `proposal/decide` and `proposal/rollback` are people only,
as approvals are. Both hold the file (as an agent's write does) and the
project's directory against rewinds.
- **Accept** works only on a `ready` proposal. If the file's digest is
  still `before`, the daemon writes the content with a pinned write and
  journals `proposalDecided` and `proposalApplied {before, after}`
  together. Otherwise it journals the accept alone: `stale`.
- **Reject** journals `proposalDecided`, for one not yet decided.
- **Rollback** works on an `applied` proposal whose file is still `after`:
  it writes `before` back, or removes a file that didn't exist, then
  journals `proposalRolledBack`.
- The file is written before its record. A crash between leaves the file
  changed and the proposal `ready`; accepting it again finds the file
  isn't `before` and marks it stale, so nothing is written twice.

**Learned files outside review.** The daemon's own write on accept and
rollback is not an agent effect, so the checks below don't apply to it.
- **Loading:** memory and `.strive/skills` are loaded only when really
  there, reached without a symlink, as the learner already reads them. The
  checks below guard real paths; a skill linked to `docs/x` would otherwise
  change with any edit of `docs/x`.
- **Out of scope:** `AGENTS.md`/`CLAUDE.md` and `.claude/skills` are the
  project's own files. The agent edits them as it edits any file, visible in
  diffs and checkpoints; only what strive learns is review-gated.
- **Agent writes:** a work session's `write` or `edit` that reaches
  `.strive/memory.md` or anything under `.strive/skills` asks a person in
  every approval mode, `fullAuto` included, and "allow for the session"
  doesn't cover the next one. The path is matched after symlinks and `..`
  are resolved, and without regard to case. A file that the project's memory
  path or skills directory leads to through a symlink is matched too. The
  request says the change reaches every future session and names `strive
  learn` and `strive review`. Unattended, it's refused.
- **Commands:** the macOS sandbox denies writes to `.strive` itself (so it
  can't be moved aside or created), `.strive/memory.md`, `.strive/skills`,
  and wherever a symlink takes those. Other files in `.strive` stay
  writable, and reads are allowed. On Linux, bubblewrap binds the memory
  file and skills directory read-only where they exist, so a command can
  still create a missing one there. With `"sandbox": "off"` none of this
  applies to commands.
- **Anything else** (an editor, git) can still change them. `proposal/list`
  returns `changedOutsideReview`: learned files that aren't what an
  accepted proposal last left there. After an apply that's its content,
  after a rollback what it replaced, and with no applied proposal, any
  file that exists counts. `strive review` prints a line for each.
- A command a work session runs can change the file between the compare
  and the write. Writes and edits the agent asks for can't: they wait for
  the file.

`strive learn` requests a run and follows the learning journal as
`strive run` follows a turn, then lists what was proposed. `strive review`
lists proposals, shows one (its diff against `before`, evidence,
prediction and checks) and accepts, rejects or rolls it back.

## The desktop app

`strive app` opens an Electron app on the session (`apps/desktop`).
- **Main process:** connects as a person's client. It forwards only a
  whitelist of person-level requests from the renderer, after checking the
  sender frame.
- **Requests:** the main process puts the window's own session id on every
  request, so the window can't act on another session.
- **Renderer:** sandboxed, with no Node and a strict CSP. `will-navigate`
  blocks navigating the main frame, new windows are denied, and HTTP(S)
  requests are cancelled.
- **Layout:** the renderer lays out the workspace document
  (`@strive/workspace`), a history of ID-addressed edits to a base. Dragging
  a panel records a person's edit.
- **Agent proposals:** the agent's `propose_layout` tool journals a
  proposal, which the app offers with Accept, Reject and, once applied,
  Undo.
- **Agent widgets:** `html` panels are iframes sandboxed to scripts only,
  served from a `strive-widget:` scheme with their own CSP. WebRTC is
  removed from their page before their code runs, since CSP doesn't cover
  it. They reach neither the app nor the network.
- **Several windows:** they share one layout file. Decided proposals merge
  on save; the layout itself is the last saver's.
- **The Learned pane** (⌘L) is `strive review` in the window: the
  project's proposals, each with its whole-file diff, reasons, evidence and
  checks, and Accept, Reject or Roll back.
  - `proposal/list`, `proposal/decide`, `proposal/rollback` and
    `learning/run` get the window's project directory from the main
    process, whatever the page sends.
  - A proposal's "before" comes through `proposalBefore(id)`, looked up
    among the project's proposals; `blob/get` stays limited to digests the
    shown session names.
  - The main process follows the project's learning session on a
    connection of its own, as an observer, from startup if the session
    exists and from the first run if not. Its entries reach the page
    (`onLearning`), which shows a run's progress; `learning()` reads the
    journal whole (`session/read`). A run that ends with proposals
    notifies a person who isn't looking.

## Effects

**Exact paths.** The gate checks a file effect's path with every symlink
resolved, and the effect acts on that path. It walks the path one
component at a time with `openat(O_NOFOLLOW)` (`pinned.rs`), so a
directory swapped for a symlink mid-effect fails it rather than
redirecting it. Reads open only regular files and stream what they return.
Writes replace files atomically, each through its own temporary file.

**Cancelling.** `effect/cancel` stops an effect by the agent's call id:
- one waiting for approval is refused, and approving it later does nothing;
- a running command's process tree is frozen with SIGSTOP, rescanned until
  no new process appears, then killed;
- an MCP call is cancelled at the server too;
- one not yet running doesn't run.

Shutdown refuses new effects and rewinds, cancels running effects, and
waits for their ends to be journaled. Only then does it stop the session
writers and release ownership. If work hasn't settled within 10s, the
daemon exits instead of releasing ownership, so a successor never
overlaps work that may still be running.

**Workspaces.** Effects and rewinds are coordinated by directory across
sessions: sessions sharing a directory, or nesting one in another, share
its files. An effect holds its session's directory, and also its
destination when it writes outside it (with approval). A rewind is refused
while an effect holding an overlapping path runs, and effects wait for a
rewind to finish. MCP tools' own file changes are known only to the
server, so they are coordinated by the session's directory alone.

**The sandbox.**
- **macOS (Seatbelt):**
  - Commands may write only in the workspace and temp directories, and not
    to the project's learned files (see "Learned files outside review").
  - strive's home is hidden.
  - There is no network, and that includes Unix sockets.
  - Without PID namespaces, a background job that leaves the command's
    process group and detaches can outlive a command that exits normally.
    Timeouts and cancels kill the whole tree.
- **Linux (bubblewrap):**
  - Commands get their own PID namespace, so every process dies with the
    command.
  - The learned files that exist are bound read-only.
  - `/tmp` and `/run` are private, which keeps the user's D-Bus, systemd,
    X11 and Docker sockets out of reach.
  - There is no network.
    - A seccomp filter refuses `socket(AF_UNIX)`, matching macOS. It also
    refuses datagram Unix `socketpair`, `io_uring_setup`, and (on x86-64)
    every x32 syscall. The x32 part is untested here: the local Linux VM
    is aarch64.
  - `scripts/test-linux.sh` runs these tests in a container.
  - Where there is no sandbox, every command asks first.
  - `"sandbox": "off"` runs commands unconfined, for a disposable container
    that is itself the sandbox (a Harbor task). The container protects the
    machine, not strive: inside it, a command can reach the daemon's socket
    and environment, other sessions, and the network outside the gateway's
    budget.

## Approvals and checkpoints

**Approval modes** are journaled per session:
- `ask`: every change and command asks.
- `autoEdit` (the default): changes in the workspace are free; commands ask.
- `fullAuto`: everything inside the workspace and sandbox is free.

In every mode, writes outside the workspace, writes to the project's
learned files (`.strive/memory.md`, `.strive/skills`) and commands without
a sandbox ask, and strive's own state is refused. With no one attached,
the refusal suggests full-auto only when full-auto would have allowed it. An approval request is a journal
entry, so every attached client sees it and the first answer wins. With no
one attached, the request is refused at once.

**Checkpoints** snapshot the workspace before each prompt, into a shadow
git repository in the session's directory. The user's own repository,
config and hooks never take part.
- **What they skip:** ignored files and nested repositories. A rewind that
  would overwrite either is refused, with names compared without case. A
  rewind leaves nested repositories alone and reports them.
- **Undo:** a rewind first saves the current files as a checkpoint, and
  journals it before restoring. Even a restore that fails partway can be
  undone with `/rewind N`.
