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
| `crates/learning` | Trusted learning's pure parts: where proposals write, the static gate's text checks, proposal status, the judge's rubric, memory's named paths, the triggers' pre-filter |
| `crates/strived` | The `strive` binary: CLI, launcher, daemon, sessions |
| `packages/protocol` | Generated TS types + the typed socket client |
| `packages/tui` | The terminal client; its binary also runs the agent host and the ACP bridge |
| `bench/harbor` | strive as a [Harbor](https://github.com/harbor-framework/harbor) agent, for Terminal-Bench 2.0 and Harbor's other benchmarks |
| `packages/acp` | The ACP bridge (`strive acp`): an editor's Agent Client Protocol to a daemon client |
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
  apply: regular files only, never from strive's home. Each sourced bullet
  is given as `[mN]`, and the agent is asked to cite one it acts on as
  `[uses mN]`; `memory/usage` tallies, per bullet, the sessions given it,
  the turns citing it, and the trouble after
  ([ADR-0026](adrs/0026-bullet-use.md)).
- **Checks** ([ADR-0023](adrs/0023-checks.md)): `.strive/checks/<name>.md`
  each, frontmatter naming the command (`run`) and the paths it covers. The
  host is given each check's name and paths, not its command. A file that
  doesn't read as a check is skipped, with why, in `skipped`.
- **Slash commands** ([ADR-0024](adrs/0024-slash-commands.md)):
  `.strive/commands`, then `.claude/commands` and `~/.strive/commands`, each
  `<name>.md`, a prompt `/name arguments` stands for. The daemon expands one
  in `session/prompt` and journals the prompt with `command: {name,
  arguments}`; `session/commands` lists them for clients.
- **Rules** ([ADR-0025](adrs/0025-path-rules.md)): `.strive/rules`, then
  `.claude/rules`, each `<name>.md` with optional `paths:` globs. One
  without paths joins the instruction files, before memory. One with paths
  comes with the output of the first read, write or edit in the session of
  a file they match, journaled as `ruleLoaded`.
- **Extensions** ([ADR-0027](adrs/0027-code-extensions.md)):
  `.strive/extensions/<name>/`, an `extension.json` declaring tools (a JSON
  Schema each) and the TypeScript that runs them. A work host is given
  each tool, which the agent calls as `ext__<extension>__<tool>`. The
  daemon reads the extension fresh for each call and runs a fixed runner,
  `bun -e`, on it as a command in the sandbox, journaled as an `extension`
  effect with the digest of its files. It runs unasked only in a form a
  person accepted: an applied extension proposal's files, or an allowance
  `extension:<name>:<digest>` for the session. One that fails three times
  in a session is left out for the rest of it.
  - **Proposed** by a work session when a person asks for a tool:
    `propose_extension` (`host/proposeExtension`) turns the draft in
    `.strive/drafts/extensions/<name>` into a whole-directory
    `Change::Extension`, citing the person's latest prompt. Before it's
    recorded, the daemon runs its `*.test.ts` with `bun test` in the
    sandbox, in a directory of its own: the `tests` gate, which fails the
    proposal as the static gate does. Accept and rollback replace the
    directory as one value (its files, by path).
  - **Hooks** ([ADR-0028](adrs/0028-hooks.md)): an extension's manifest
    may declare `hooks: [{"event": "tool_call", "tools": [kinds]}]`. For
    each effect a work session asks for, after the approval gate, the
    daemon runs each accepted extension's `hooks.tool_call` that sees its
    kind, in the sandbox for at most 10 s, on the request as the protocol
    has it. A hook answers `deny` (refused), `ask` (a person is asked,
    even in full-auto) or nothing; it can't allow or rewrite. A hook that
    fails asks, every time, so an agent can't turn one off by making it fail.
  - **Safe mode:** a session created with `safe` (`strive --safe`, or
    `"extensions": false` in settings) records it in `sessionStarted`. Its
    host is given no extensions (`contextLoaded` notes the ones left out),
    an `extension` effect is refused, and no hook runs.
- **Imports:** a line `@path` in an instruction file, outside a code
  block, inlines that file if its real path is in the project (under its
  root, not in strive's home), up to five imports deep, and not as a
  cycle. One outside the project, or a symlink leading out of it, stays as
  text. Each import in the project is guarded as the file that imports it
  (see "What shapes a session").
- **Only what is on the list:** every other file above is read only if
  its real path is on "What shapes a session" (below). A symlinked
  `AGENTS.md` leading to `docs/x.md` is skipped, and so is a skill linked
  in from elsewhere. `CLAUDE.md` linked to `AGENTS.md` loads, since both
  ends are guarded. Memory, `.strive/skills` and `.strive/checks` must
  also be reached without any symlink.
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
- `contextLoaded` journals what was loaded and how each server started,
  and, in `skipped`, each import not loaded (a cycle aside) as a line for
  a person: "@docs/x.md in AGENTS.md was not loaded: it's outside the
  project" (or "it links outside the project", "there's no such file",
  "it isn't a file", "it's more than 5 imports deep"). The TUI, the
  desktop app and `strive log` show each line.
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
- Live reply text travels as `session/delta` and is not journaled. A reply
  the host never recorded (it stopped mid-turn) is still in the gateway's
  response bytes. On resume it's decoded and given to the agent as a note
  that quotes it (ADR-0030).
- Only people, never hosts, can answer approvals.
- A prompt may carry a `requestId` (ADR-0030). One sent again with an id
  the session already holds is answered with the first one's seq, and
  nothing is journaled.
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
  to a learning session are refused. The daemon's own triggers journal it
  too, with a `trigger` (below). A person's request that names sessions
  carries their `signals` not yet dealt with, found as a trigger's are.

**What its host may do.** Its `host/register` returns `kind: learning`,
no MCP tools, and `learnedFiles`: the project's memory and skills, each
whole and exactly as on disk, memory also as `items` (each bullet with its
source, and the other lines). Files a proposal couldn't change are left
out: not regular, reached through a symlink, in strive's home, or over
64 KiB. `contextLoaded.learned` journals their digests.
- A host lives on between runs, and the files change under it: an
  accepted proposal, a hand edit. So each run starts, after its
  `turnStarted`, with `host/context` (its own host only): the daemon
  reads the instructions, skills and learned files again, journals them as
  a new `contextLoaded`, and returns them. The host rebuilds the learner's
  system prompt from them, and `read_artifact` shows them. So the journal
  records what each run saw, and that run's proposals take `before` from
  it. If the call fails, the turn ends failed rather than run on old
  files.
- It records turns, messages, summaries and `proposalMade`. Nothing else:
  no gates, decisions or layouts, and no effects.
- A work session's host can't record `proposalMade`.

**The learner.** A learning session's host (`AgentConfig.kind` is
`learning`, [ADR-0016](adrs/0016-trusted-learning.md)) runs the learner
with the same turn machinery: a `learnRequested` entry is a turn's
prompt, as `userMessage` is for the coding agent.
- Its tools read, and nothing else: `list_sessions` (`session/list`),
  `read_session` (`session/read` and `blob/get`, rendered in pages within
  a token budget), `read_artifact` (memory and skills as the run started)
  and `propose_change`, which records `proposalMade`. It has no effect
  tools and no MCP tools.
- A proposal's result is its id and the daemon's static check, or the
  daemon's refusal. At most three are recorded a turn.
- Read tools' output isn't journaled, so on resume their calls say to
  call them again.

**Memory as bullets** ([ADR-0022](adrs/0022-bullet-proposals.md)).
`.strive/memory.md` stays plain markdown. A bullet the learner wrote ends
with `<!-- strive:#42 -->`, the proposal that last wrote it; one a person
wrote has none. `strive_learning::memory` reads it line by line (a bullet:
an indent, `-`, `*` or `+`, a space, text; not inside a code fence) and
writes it back byte for byte. Work sessions are given it without the
source comments; the learner is shown `[#42]` or `[hand-written]` before
each bullet.

**A proposal** changes one thing (`Proposal.change`): a memory operation
(`add {text, after?}`, `change {bullet, text}`, `remove {bullet}`, a
bullet named `#42` or, if hand-written, by its exact text) or a skill's
whole `content`. On `proposalMade` the daemon, holding the project's lock:
1. takes `before`, the file as the learner was last shown it (none if it
   wasn't there), from the latest `contextLoaded`. A host can't supply it;
2. runs the static gate, a memory operation against `before`;
3. journals the proposal and every gate's `gateFinished` that is decided at
   once (the static gate's, and the judge's skip) in one commit.
   The proposal's id is its entry's seq.

**The static gate** (`strive-learning` for the text, the daemon for the
machine). Every finding is listed in the gate's detail:
- **Path:** a skill name is 1 to 40 of `a-z0-9-`. The file resolves
  inside the project's `.strive/` with no symlink on the way, is a regular
  file if it exists, and isn't in strive's home (a project at `~`).
- **Size:** a bullet ≤ 500 characters, and memory with the operation
  applied ≤ 16 KiB; a skill ≤ 32 KiB.
- **Form:** a bullet is one line of text, without its `- `; a skill's
  frontmatter names it and describes it; the summary is one line; there is
  a rationale and a prediction.
- **Bullet:** a change or remove names one bullet the learner was shown
  (and a change changes it), an add's `after` does too, and an add doesn't
  repeat a bullet (compared with runs of whitespace as one).
- **Secrets**, in the bullet or content, summary and rationale: key shapes (`sk-`,
  GitHub, Slack, Google, AWS, private keys) and the stored API keys by
  value. The detail never repeats the secret.
- **Weakening strive:** phrases that bypass approvals, weaken the sandbox,
  touch strive's own state or settings (its home, the journal, memory and
  skills themselves), or tell the agent to ignore the user; piping a
  download to a shell. The lists are broad on purpose: a false alarm
  costs a look.
- **Evidence:** one to five sessions (`CITED_SESSIONS`), each citing at
  least one entry. Each is a work session of this project whose journal
  verifies, and each cited seq is one of its entries. The cap matters
  because cited sessions are left out of the judge's held-out sessions.

**The judge** ([ADR-0017](adrs/0017-judge-gate.md)): advice beside the
diff, not a gate a person must pass. The daemon's own model call, through its gateway with the learning session's token, so
it is admitted, held, journaled and charged like any call of that session.
- **What it's shown**, as one JSON document the system prompt calls data:
  the proposal, the file it changes (and as the change would leave it)
  and the other memory and skills as the learner was shown them, earlier
  proposals for the same file that a person rolled back, the cited sessions (cited entries kept
  first), and up to three held-out sessions: the project's newest work
  sessions the proposal doesn't cite, begun before it, with a prompt and a
  journal that verifies. Nothing of the learning session's own goes in.
  The system prompt says a person reads the verdict beside the change.
- **The rubric** (`strive_learning::judge::RUBRIC`): supported, generalizes,
  novel, safe, checkable. The model must answer with one forced
  `record_verdict` call. It passes only if every criterion and the verdict
  say pass. An answer that can't be read strictly fails.
- **Skipped**, with the reason, and journaled with the proposal: after a
  static failure, with no Anthropic key, no price for the model, or no
  session to hold out. Skipped later if the learning session's budget
  can't pay, or if the provider is rate-limited or overloaded (429, 529):
  that says nothing about the proposal. Failed if the provider refuses
  otherwise or the call breaks.
- **Advice:** a fail doesn't block. `strive review` says "second opinion
  advises against it" and the first failed criterion's reason in its
  one-line verdict, marks the list line, and says accept writes the file
  anyway; the desktop shows the same with the failed criteria's reasons at
  the top of the proposal.
- **Named for people:** what a person reads calls the static gate the
  "safety checks" and the judge the "second opinion" (`strive review`,
  `strive log`, the Learned pane, the daemon's refusals and skip reasons);
  the code, the protocol (`static`, `judge`) and the rubric keep their
  names.
- **In the background:** otherwise the proposal stays `checking` while the
  call runs, without the project's lock. The verdict is journaled under the
  lock, and only if there isn't one. A set of running judges keeps a list
  from starting a second. After a crash, the next list or decision judges
  again.
- The model is `judgeModel` in settings, else `model`.

**Status**, folded from the learning journal:

| Status | When |
| --- | --- |
| `checking` | a gate has no verdict yet |
| `failed` | the static gate failed |
| `ready` | the static gate passed and the judge finished: pass, fail or skip |
| `rejected` | a person rejected it |
| `applied` | accepted and written (`proposalApplied`) |
| `stale` | accepted, but its bullet (memory) or file (a skill) wasn't as the learner saw it, so nothing was written |
| `rolledBack` | an applied one, undone |

People read `stale` as "file changed" in a list and "not written: the file
changed since this was proposed" on its own. Two more facts ride with an
`applied` one:
- `replacedBy`: a later applied proposal changed what it wrote. For
  memory, a later change or remove of its bullet (the bullet's source
  names it); a proposal for another bullet never does, and rolling that
  one back clears it. For a skill, a later proposal for the same skill
  (cleared if that one is rolled back to this one's content). It shows as
  "replaced by #N" instead of `applied`.
- `canRollBack`: `proposal/list` applies the rollback rule below to the
  file now. Roll back is offered (the CLI's hint, the desktop's button)
  only when it's true, since the daemon would refuse otherwise; `strive
  review ID rollback` says why before asking.
- `bullet`: a memory proposal's one-bullet diff, as applied, or else as it
  applies to the file the learner saw.

Each proposal also carries `trigger` (an automatic run's) or `offered`
(the signs of a person's yes to the offer), so review can say where its
run came from.

Gates a crash cut short (a proposal with no verdicts) are run again on the
next `proposal/list` or decision.

**Stale memory:** `proposal/list`'s `mayBeStale` lists memory lines that
name a relative project path, in backticks, that no longer exists
(`strive_learning::stale`); `strive review` prints each.

**Deciding.** `proposal/decide` and `proposal/rollback` are people only,
as approvals are. Both hold the file (as an agent's write does) and the
project's directory against rewinds.
- **Accept** works only on a `ready` proposal, and writes with a pinned
  write, journaling `proposalDecided` and `proposalApplied {before, after,
  bullet?}` together (the file's digests, and for memory what it did to
  its bullet). Otherwise it journals the accept alone: `stale`.
  - Memory: the operation is applied to the file as it is now. A change or
    remove needs its bullet to read as the learner saw it; edits elsewhere
    don't matter. An add goes after `after` (or the last bullet), with the
    new bullet's source; it's stale if the file now has that bullet, or if
    the file would pass 16 KiB.
  - A skill: written only if its file's digest is still `before`.
- **Reject** journals `proposalDecided`, for one not yet decided.
- **Rollback** works on an `applied` proposal no later one replaced, then
  journals `proposalRolledBack`. Memory: it removes the bullet an add
  wrote, gives a changed bullet its old line, or puts a removed one back
  after the line it followed (or at the end if that's gone), in any order;
  refused only if that bullet changed since. A skill: its file must still
  be `after`; `before` is written back, or a file that didn't exist removed.
- The file is written before its record. A crash between leaves the file
  changed and nothing recorded. Accepting again finds the change already
  there (the bullet reads as the operation leaves it, or the skill holds
  the content) and journals the accept and the apply, writing nothing;
  rolling back again finds it already undone and journals the rollback.

**What shapes a session.** One list, `context::SHAPING`, names every file
or directory whose contents a session is given when it starts, or which
decides how strive runs it. The loader reads nothing in a project that
isn't on it or imported by a file on it, and the approval gate and the
sandbox guard all of it:
- **The list**, by last components at any depth under the project's root
  (the repository's, or the workspace outside one), since a later session
  may start in any directory:
  - `AGENTS.md` and `CLAUDE.md`;
  - `.claude/skills`, `.claude/commands` and `.claude/rules`;
  - `.strive/memory.md`, `.strive/skills`, `.strive/checks`,
    `.strive/commands`, `.strive/rules` and `.strive/extensions`, the
    learned files;
  - `.strive/settings.json`.

  strive's home adds `~/.strive/AGENTS.md` and `~/.strive/skills`, and the
  agent can't write anything in it. MCP servers come from
  `~/.strive/settings.json` only; a project's `.mcp.json` is Claude Code's,
  and is guarded as a file that runs code (see "The sandbox").
- **Imports** join the list for their project: each path an instruction
  file imports inside the project, inlined or not (one not written yet
  too). Only guarded files import, so the set changes only as a person
  allows; the daemon reads it again for each effect.
- **Agent writes:** a work session's `write` or `edit` that reaches a
  listed path asks a person in every approval mode, `fullAuto` included.
  The path is matched after symlinks and `..` are resolved, and without
  regard to case.
  The request says why: learned files, that the change reaches every future
  session without review, naming `strive learn` and `strive review`;
  instruction files and skills, that it "changes what every future session
  in this project is told"; imports, that "it's imported by AGENTS.md"
  (naming the file); settings, that it changes strive's settings for
  every future session. Unattended, it's refused.
- **Allowing for the session** covers one instruction file (`AGENTS.md`,
  `CLAUDE.md`) or import at a time: the request names it
  (`approvalRequested.sessionFile`), and once a person answers
  `allowSession`, later changes to that real path in that session don't
  ask. The mode stays as it was. Rebuilt from the journal on restart, from
  those two entries. Skills, settings, learned files and files that run
  code have no `sessionFile`, so each change asks (`allowSession` there
  switches to full-auto as for any request, which they ignore).
- **Commands:** the macOS sandbox denies writes to every listed path by
  pattern, in any case, anywhere under the project's root, and to
  `.strive` and `.claude` themselves, so neither can be made elsewhere and
  moved into place or moved aside. Their other files stay writable, and
  reads are allowed. Each import is denied by its path, in any case, and
  so is each directory between it and the project's root, so none can be
  moved aside, moved into place or swapped for a symlink. On Linux,
  bubblewrap binds the listed paths in the workspace itself, and the
  imports, read-only where they exist: a command can still create a
  missing one, or change a nested one (`pkg/AGENTS.md`). With
  `"sandbox": "off"` none of this applies to commands.
- **Symlinks:** the loader skips a listed path whose real path isn't
  listed (see "Context"), so a plain edit of the file a link names can't
  change what sessions are told. An import is guarded where it is written
  and where it leads, so one that links elsewhere in the project guards
  both.
- **The daemon's own write** on accept and rollback is not an agent effect,
  so none of this applies to it.
- **MCP servers can write anything.** They run unsandboxed, as the user,
  in the session's directory, so a server can write any of these with no
  approval and no sandbox rule in the way. They are configured by the user
  and trusted as the user is.
- **Changed outside review**, for learned files only. An editor or git can
  still change any of these; a person editing `AGENTS.md` is normal, so
  only learned files are flagged. `proposal/list` returns
  `changedOutsideReview`: memory when a bullet names a source that isn't
  an applied proposal which left it reading so (hand-written bullets are a
  person's and never count; `memory` marks each such bullet), and a skill
  that isn't what an accepted proposal last left there (after an apply its
  content, after a rollback what it replaced, and with no applied proposal
  any file that exists). `strive review` prints a line for each, per
  bullet for memory. A command a work
  session runs can change the file between the compare and the write.
  Writes and edits the agent asks for can't: they wait for the file.

**The offer to learn** ([ADR-0020](adrs/0020-learning-triggers.md)) is how
learning usually starts. As the TUI quits, or once a desktop session has
been idle a minute after its turn ended (no prompt since), or when the
window switches away from it or is closed, the client asks
`learning/signals {cwd, session}`: no model, nothing journaled, no learning
session created. It returns the session's signs past the watermark (below),
a counted `summary` ("2 corrections and a command that failed, then
passed"), `ask`, and `estimateUsdMicros`: what a run (its checks included)
has cost in this project on average, or before the first the learner
model's price for other projects' average run tokens (a typical run's,
`triggers::TYPICAL_RUN`, if none has run). `ask` is true
when there are signs, the learner's provider has a key, and
`learning.ask` (default true) isn't false; it doesn't depend on `mode`.
- **Yes** is `learning/run {sessions: [it], offer: true}`, whose
  `learnRequested` carries the signs and `offer`; the client exits or goes
  on without waiting. The TUI draws its "Asked the learner…" line before
  it exits.
- **No** (the TUI: any key but y; the desktop: Dismiss) is
  `learning/dismiss {cwd, session, through}` (people only), journaling
  `learnDismissed {session, through}` in the learning session.
- **Once:** the TUI asks at most once a process, the desktop at most twice
  a session a window (again only for signs after the first answer). Across
  clients and restarts the watermark keeps the same signs from being
  offered again. `strive run` never offers.
- **Closing the desktop window** is held once (`close` is prevented, the
  page is sent `strive:closing`) so the page can offer; it calls
  `strive:close` when there's nothing to offer or once it's answered. A
  second close, or quitting the app (`before-quit`), isn't held.
- **Proposals waiting:** a TUI session says "2 proposals are waiting:
  `strive review`" as it opens, and the desktop's Learned button shows the
  count of `ready` proposals, both from `proposal/list`.

**Triggers** ([ADR-0020](adrs/0020-learning-triggers.md)): the learner
also runs without being asked, behind `learning` in settings: `mode` (`off`,
the default, or `suggest`; any other is refused on load), `idleSeconds`
(600), `everyTurns` (0: off) and `dailyRuns` (3). A project's
`.strive/settings.json` may hold only `{"learning": {"mode"}}`, and the mode
in effect is the lower of the two; one that can't be read turns automatic
learning off there.
- **When:** each work `turnEnded` (a host's, or one the daemon records for
  a host that left) starts a wait of `idleSeconds`; if no prompt came in
  that session meanwhile, it is scanned. With `everyTurns`, a session whose
  ended turns reach a multiple of it is scanned at once. Once a learner's
  turn or a proposal's checks end and nothing is going, sessions whose last
  scan was skipped for being busy are scanned again. Waits live in the
  daemon's memory; one a restart cuts is dropped.
- **The pre-filter** (`strive_learning::signals`): one pass over the work
  journal, no model. Signs: a correction (the first prompt after a turn,
  by a fixed list of openers and phrases in its first 200 characters), an
  interrupted turn, a declined approval, a command that failed then passed
  (in the same turn, then later with exit 0), a failed or timed-out turn. Each is anchored at
  the entry that completes it; at most 20, each with a 120-character
  excerpt. Only signs past that session's watermark count: the highest
  seq a request (automatic or a person's) named or a dismissal reached
  (`triggers::acted_on`). So signs a person declined start no automatic run. None: nothing is journaled (the log says the
  session was scanned).
- **Limits,** under the project's lock: no request a turn hasn't finished
  and no proposal `checking`; fewer than `dailyRuns` automatic requests in
  the last 24 hours; a key and a price for the learner's model; and room in
  the learning session's ledger for one worst-case learner call. Failing
  one journals `learnSkipped {trigger, reason}`; passing all journals
  `learnRequested {sessions: [the session], trigger: {kind, signals}}` and
  starts the host. The learner's prompt lists the signs. Proposals a crash
  left `checking` are settled first, and an unfinished request starts the
  learning session's host, whose resume ends a turn a crash cut off.
- **Shown:** `proposal/list` gives each proposal its `trigger`, and
  `skipped`, the latest skip with no automatic request since. `strive
  review` marks `[automatic run]`, prints the trigger and its signs in the
  detail, and the skip under the list; `strive log` describes both
  entries. A person decides on every proposal, whoever asked for the run.

`strive learn` requests a run, says "studying 1 session…", follows the
learning journal quietly (`strive log` has the steps), then lists what was
proposed, waiting for second opinions still out. `strive review` lists
proposals and accepts, rejects or rolls one back. `strive review ID` shows,
in order, the summary and status, where its run came from ("you said yes
to the end-of-session offer: a correction in \"run the tests\"", "asked
with `strive learn`", "automatic, …"), the diff (one bullet for memory,
against `before` for a skill), the checks in one line, and what to do
next; `strive review --memory` shows the memory as every session reads it
now (`proposal/list`'s `memory`), each bullet with its source (`#42`) or
"hand-written", as the desktop's "What every session reads now" does; `--full` adds why, the
prediction, the evidence, the signs the run was given and each check's
detail. Sessions are named by their titles, not their ids.

## Editors (ACP)

`strive acp` ([ADR-0029](adrs/0029-acp-server.md)) starts the daemon and
execs `strive-tui acp`, which speaks the Agent Client Protocol on stdio
(`@agentclientprotocol/sdk`) and is an ordinary client of the daemon,
attached as a person's. The agent loop stays in the host the daemon starts.
- **Sessions:** `session/new` creates a strive session in the editor's
  `cwd`; `session/load` attaches to one and replays it (prompts, replies,
  tool calls). Approval modes are its ACP modes (`session/set_mode`).
- **Prompts:** text, with embedded resources inlined under their URI and
  links named; images are refused. A prompt answers when the turn that
  took it ends (`throughSeq`, or a turn journaled after it): `end_turn`,
  or `cancelled` when `session/cancel` interrupted it.
- **Updates:** deltas become `agent_message_chunk`s (only what's new),
  effects `tool_call`s and `tool_call_update`s (with the output, read by
  digest with `blob/get`, in journal order), and an approval a
  `session/request_permission`, withdrawn if another client answers first.
- **Not taken:** the editor's file system and terminal (effects run in the
  daemon's sandbox, on disk) and its MCP servers (the first reply says so).

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
  - `proposal/list`, `proposal/decide`, `proposal/rollback`,
    `learning/run`, `learning/signals` and `learning/dismiss` get the
    window's project directory from the main process, whatever the page
    sends; the daemon refuses a named session outside that project.
  - A proposal's "before" comes through `proposalBefore(id)`, looked up
    among the project's proposals; `blob/get` stays limited to digests the
    shown session names.
  - The main process follows the project's learning session on a
    connection of its own, as an observer, from startup if the session
    exists and from the first run if not. Its entries reach the page
    (`onLearning`), which shows a run's progress; `learning()` reads the
    journal whole (`session/read`). A run that ends with proposals
    notifies a person who isn't looking.
  - Review aids, all from existing reads: `changedOutsideReview` shows as a
    notice; `cited(session, seqs)` reads cited entries (with the other half
    of a cited effect and its output) from one of the project's sessions
    only, and a cited seq scrolls the conversation to it; the judge's
    detail is read by criterion when it has the daemon's line shape, else
    shown as is; the other proposals for the same file come from
    `proposal/list`.
  - A judge fail shows at the top of the proposal as "The second opinion
    advises against it", with the failed criteria's reasons; Accept stays
    available. The judge's detail names held-out sessions by title.
  - The Learned button counts the `ready` proposals. The window lists
    proposals again when it gets focus, so a run from `strive learn` in a
    terminal shows in the count on return.
  - Automatic learning: a proposal from an automatic run has an "Automatic"
    badge, and its detail names the trigger and each sign; the latest
    skipped run shows as a notice. `proposal/list` also starts following a learning session that an
    automatic run created after the window opened.

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

**After a crash** ([ADR-0030](adrs/0030-durability-lessons-from-pi-durable.md)):
- **Journaled while running.** Each hook's answer is journaled as
  `hookDecided`: the extension, its files' digest, and what it said. Once
  the gate, the hooks and any person allow an effect, `effectCleared` is
  journaled just before it runs.
- **On reopening.** Recovery closes every effect a crash cut off as
  `interrupted`.
- **When the session's host next registers.** The daemon runs again each
  effect the journal shows was cleared and is safe to repeat, and journals
  how it ended as `effectRerun`. The host gives the agent that outcome, not
  the interruption. The safe ones:
  - a read;
  - a write, since the same content again leaves the same file;
  - an edit whose file shows whether it landed. If the old text is there
    once and the new text isn't, it runs. If the new text is there, it
    counts as done.
- **On the recorded decisions.** A rerun asks nothing again and runs no
  hook again. Its path is resolved and checked again, and a path that's
  now refused stays interrupted.
- **Never repeated:** commands, MCP calls, extensions and checks, which
  may have done their work, or half of it.

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
- **Files that run code outside the sandbox** (after sandbox-runtime's
  list): `.git/hooks` and `.git/config` (in nested repositories too),
  `.vscode`, `.idea`, `.claude/commands` and `.claude/agents`, and rc and
  config files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`,
  `.gitmodules`, `.ripgreprc`, `.mcp.json`) anywhere in the project. Git or a
  shell runs them later for the person, unsandboxed. Other agents' settings,
  hooks and MCP config are on it too, each an attack route in a published
  incident: `.claude/settings.json`, `.claude/settings.local.json` and
  `.claude/hooks` (Claude Code, CVE-2025-59536), `.codex` and `.agents`
  (Codex, CVE-2025-61260), `.cursor` (CurXecute, MCPoison,
  CVE-2025-59944) and `.gemini`; so are `.envrc`, `.husky`,
  `.devcontainer`, `.npmrc`, `.pre-commit-config.yaml` and `lefthook.yml`. Commands can't write
  them, and the agent's write and edit ask a person in every approval
  mode. The rest of `.git` stays writable, so git works in the sandbox;
  `git config` doesn't. On Linux, bubblewrap binds read-only only those at
  the project root that exist, so a command can still create a missing one
  (a new `.vscode/tasks.json`) or change a nested repository's hooks.
- **macOS (Seatbelt):**
  - Commands may write only in the workspace and temp directories, and not
    to anything on "What shapes a session" or the files above, matched by
    pattern in any case.
  - strive's home is hidden.
  - There is no network, and that includes Unix sockets.
  - Without PID namespaces, a background job that leaves the command's
    process group and detaches can outlive a command that exits normally.
    Timeouts and cancels kill the whole tree.
- **Linux (bubblewrap):**
  - Commands get their own PID namespace, so every process dies with the
    command.
  - The listed files that exist in the workspace itself, and imports that
    exist, are bound read-only.
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

In every mode, writes outside the workspace, writes to anything on "What
shapes a session" or to files that run code outside the sandbox, and
commands without a sandbox ask, and strive's own state is refused. With no one attached,
the refusal suggests full-auto only when full-auto would have allowed it. An approval request is a journal
entry, so every attached client sees it and the first answer wins. With no
one attached, the request is refused at once. Allowing for the session
switches to full-auto, except for an instruction file, where it allows
that file (see "What shapes a session").

**Checks** ([ADR-0023](adrs/0023-checks.md)) run at the end of a turn that
changed files: the host names each check whose paths match a file changed
since the turn's checkpoint, and the daemon reads its command from its file
and runs it, journaled as a `check` effect with that command. A check
runs without asking, in any mode, only in a form a person accepted: an
applied check proposal's content, or content a person allowed for the
session (a session allowance `check:<name>:<digest>`, never full-auto).
Any other form asks, as does any check without a sandbox. A failed check
goes back to the agent, at most twice a turn, as a report the host
journals (`checksReported`) before the agent sees it, so a resumed session
is told what a running one was.

**Checkpoints** snapshot the workspace before each prompt, into a shadow
git repository in the session's directory. The user's own repository,
config and hooks never take part.
- **What they skip:** ignored files and nested repositories. A rewind that
  would overwrite either is refused, with names compared without case. A
  rewind leaves nested repositories alone and reports them.
- **Undo:** a rewind first saves the current files as a checkpoint, and
  journals it before restoring. Even a restore that fails partway can be
  undone with `/rewind N`.
