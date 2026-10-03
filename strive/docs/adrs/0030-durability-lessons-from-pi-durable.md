# ADR-0030: Four durability changes, learned from pi-durable

Status: accepted (2026-10-02). Changes 1, 3 and 4.1 are built; 2 and 4.2 aren't yet.

## Context

Pi 1.0 (2026-10-01) shipped `@earendil-works/pi-durable`, an experimental
TypeScript runtime that makes an agent run survive crashes. Its storage is
SQLite or JSONL. It records each tool call before and after it runs,
resumes cut-off model requests and tools, and lets several people steer
one session.

It is no foundation for strive. It runs the loop, tools, hooks and storage
in one trusted process. Its storage has no integrity checks, and it can
lose the newest commits on power failure. It keeps normalized messages,
not the bytes exchanged with the provider. It counts spend after the fact,
with no limits. Approvals and sandboxing are left to the application. Its
API "changes without notice". strive's daemon does all of this already,
and under a trust split pi-durable lacks.

But it handles four situations more deliberately than strive does. Each
section below says what pi-durable does, what strive does now, and what
strive should do.

## 1. Each tool says whether it is safe to run again

**pi-durable.** A tool declares `replay: "safe" | "unsafe"` (unsafe by
default). The intent is committed before the effect runs and the outcome
after. After a crash, a call with intent and no outcome runs again only
if both the recorded and the current policy are `safe`. Otherwise the
model is told "Tool X was interrupted and may have partially run".

**strive now.** The daemon closes every effect a crash cut off as
`interrupted` (`close_abandoned_calls` in `crates/strived/src/sessions.rs`).
The agent is told "the daemon stopped while this ran; whatever it changed
stays changed" (`packages/host/src/transcript.ts`). Nothing is ever run
again. That is the right default, but strive treats a cut-off `read` like a
cut-off `bash`. The agent then has to redo by hand reads and checks that
were always safe to repeat.

**Proposal.** The daemon, not the host, knows what each effect kind can
do, so the policy lives in the daemon, per kind:
- `read`, and a check that has no side effects, are **safe**;
- `write` is **safe**: the journal has the content's digest, and writing
  the same content again leaves the same file;
- `edit` is **safe when the file is unambiguous**. If its old text still
  appears once, the edit didn't land and reruns. If the new text appears
  and the old doesn't, it landed and is recorded as done. Anything else is
  interrupted, as now;
- `bash`, `mcp`, `extension` and any check are **unsafe**, as now.

**Built.** It runs again only an effect the journal shows was cleared:
`effectCleared` is journaled just before an effect runs, once the gate,
the hooks and any person have allowed it. So a crash caught while asking
a person never leads to a run no one approved.

Recovery still closes every cut-off effect as `interrupted`, because that
was true when the daemon reopened. Then, when the session's host next
registers (before it reads the journal), the daemon runs the safe ones
again and journals each outcome as `effectRerun`. The host gives the agent
that outcome in place of the interruption.

A rerun resolves and checks its path again, and a path that's now refused
stays interrupted. An edit is judged landed by its new text being there
(alone, or with the old text where the new text holds the old one), and
runs again only if the old text is there once and the new isn't. An edit
that deletes stays interrupted, since its landing leaves nothing to see. MCP
tools could later opt in through MCP's `idempotentHint` annotation, which
strive's client doesn't read today. That would only apply to a server
whose annotations a person trusts in settings, since a server's
description of itself is otherwise untrusted.

**Cost.** Small: one rule per kind, and a rerun path in recovery. The
tests: crash a read, a write, an edit that didn't land, an edit that did,
an edit whose file changed since, and a command. Resume each, and check
what reran and what was recorded as done or interrupted.

## 2. A reply cut off mid-stream isn't lost

**pi-durable.** While a reply streams, it commits the partial assistant
output at most every 100 ms. After a crash it keeps that partial reply as
an aborted entry, and the next request carries it.

**strive now.** It depends on what stopped.
- **The stream broke, or the host crashed, while the daemon ran.** The
  gateway stores every byte it received and journals the call as `broken`
  with that response (`crates/strived/src/gateway.rs`). But the host
  rebuilds the conversation on resume only from `assistantMessage`
  entries. A reply the host never recorded is dropped, though its bytes
  are in the content store and the call was paid for.
- **The daemon crashed mid-call.** The call is closed as broken with no
  response, and the bytes received are gone.

**Proposal.**
1. On resume, a model call with a stored response and no
   `assistantMessage` after it is decoded from those bytes. The gateway's
   `UsageMeter` already reads the stream's events for usage, so this
   extends it to collect the reply's text and tool calls.
2. The decoded text becomes an assistant message marked as cut off, so
   the next request carries what the model had said. Tool calls in a
   partial reply aren't run: their arguments may be incomplete. The agent
   is told they didn't run, as for `NOT_RUN` today.
3. For a daemon crash, the gateway appends the bytes received so far to
   the content store every 500 ms of streaming, in one growing blob per
   call. Recovery then has something to decode. That costs a write per
   half-second of streaming, and no fsync, since the journal's commit is
   what counts.

**Cost.** Moderate. Step 1 is most of the value and needs no new events.
Step 3 touches the gateway's hot path, so it gets a benchmark against
the 2 ms-per-chunk budget.

## 3. A hook's answer is recorded, and a rerun reuses it

**pi-durable.** `api.memo(key, fn)` runs `fn` once and records its result,
first writer wins. A hook or tool that reruns after a crash reads the
recorded value instead of deciding again. So a decision made before a
crash stays made after it.

**strive now.** Hooks (ADR-0028) run before each effect. Their answer is
recorded only through the effect it decided: the question asked, or the
refusal, which names the hook's extension. Which version of the hook
decided isn't recorded (ADR-0028, "Not decided here"). Nothing reruns, so
nothing needs a memo yet. But change 1 makes reruns real. A safe effect
rerun after a crash would run its hooks again, and the hook's code may
have changed since.

**Built.** It is a new journal event, `hookDecided {effect, extension,
digest, answer, reason}`. The daemon journals it for every hook that sees
an effect, including "nothing". When an effect reruns (change 1), no hook
runs again: the `effectCleared` that a rerun requires was journaled only
after every hook had answered. A
rerun is the same decision about the same call. A replay of the session
(the replay gate, if it returns) can check the recorded answers against
the hook's code at that digest. This settles ADR-0028's open item.

**Cost.** Small, and only worth doing with change 1. The journal grows by
one entry per hook per effect, and most effects have no hooks.

## 4. Several people work one session, and a retried prompt counts once

**pi-durable.** A client sends a submission with a `requestId`. The same
id twice is the same submission, so a retried send can't double-post.
Clients watch committed state (`watch()`, `viewState()`) rather than a
private stream. A conversation can be forked at any entry into a new one
that shares its history.

**strive now.** Any number of clients attach to a session (the TUI, the
desktop app, `strive acp`, `strive run` as an observer). Prompts and
approvals come from any of them, and the first answer to an approval wins.
Two things are missing:
- **A prompt is idempotent only by luck.** `session/prompt {id, text}`
  carries no key. A client that loses its connection after sending, then
  retries, journals the prompt twice, and the agent runs it twice.
- **There is no fork.** `/rewind` restores the workspace to a checkpoint,
  but the conversation stays one line. A person can't say "try this from
  entry 40 another way" and keep both.

**Proposal.**
1. `session/prompt` takes an optional `requestId`, and the journal keeps
   it on `userMessage`. A second prompt with an id already journaled in
   the session is answered with the first one's seq and journals nothing.
   The TUI, the desktop app and the ACP bridge (which has the editor's
   request) send one per prompt.

   **Built.** The writer checks for the id and journals the prompt in one
   step, so two copies sent at once journal one. The check reads the
   journal, so it holds across restarts. A prompt sent again takes no
   checkpoint. The TUI keeps a message's id when its saving isn't
   confirmed and it's sent again as it was. `strive run` sends its one
   prompt as `strive-run`. An id is 1 to 128 bytes.
2. `session/fork {id, at}` creates a new session whose journal starts
   with a `forkedFrom {session, seq, digest}` entry. Its conversation
   rebuilds from the parent's entries up to `at` (verified against the
   digest), and its workspace starts from the nearest checkpoint at or
   before `at`. The parent is untouched. Budgets: the fork gets a fresh
   limit, and the parent's spend isn't charged twice.
3. Shared editing of documents, pi-durable's `Chord`, isn't needed.
   strive's shared state is the journal, which every client already
   follows from any seq.

**Cost.** 1 is small. 2 is moderate: rebuild across two journals, and
checkpoints that a fork shares with its parent.

## Order

Change 1, then 3 (it depends on 1 to matter), then 4.1. Each of those is
small, and each closes a gap a crash or a flaky connection can hit today.
Change 2 step 1 is next: it recovers paid-for replies with no new events.
Then 4.2 (fork) and 2 step 3, each of which wants a short design pass of
its own.

## Consequences

- strive keeps its own durability core. These changes refine what the
  daemon already guarantees. Nothing moves into the untrusted host.
- After a crash, the agent loses less: safe work reruns, and paid-for
  replies come back.
- The journal records every hook's answer, so audits and any future replay
  can explain each gate decision.
