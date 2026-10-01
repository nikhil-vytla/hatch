# ADR-0027: Code extensions: tools the agent writes, run in the command sandbox

Status: accepted and built (2026-10-01), but for safe mode. Hooks are ADR-0028. The extension plan's second milestone, after
the declarative extensions (ADR-0023 to ADR-0025).

## Context

bb, exo and Prime Agent let the agent extend its own harness, and that is
much of why they feel alive: ask for a tool and it exists a minute later.
All three run the agent's code with full trust, in the process that holds
keys and other plugins' state, and none tests a change against anything
before it is live (NOTES, 2026-09-30). strive's split already answers the
hard part: a command runs in a sandbox with no network, no Unix sockets (so
no route to the daemon's socket), writes only in the workspace, strive's
home hidden, and a process tree that dies with it.

## Decision

### An extension is a directory of TypeScript that declares its tools

```
.strive/extensions/<name>/
  extension.json   # {"name", "description", "tools": [{"name", "description", "parameters"}]}
  index.ts         # export const tools = { <tool>: async (args, ctx) => string }
  *.test.ts        # optional: bun tests the daemon runs before it's accepted
```

Tools are declared in `extension.json` (a JSON Schema per tool), so the
daemon and host know them without running anything. Code is TypeScript run
by Bun, the runtime strive's host already ships.

### A tool call is a sandboxed command

The agent calls an extension tool like any other (`ext__<name>__<tool>`).
The host asks the daemon (`effect/run {kind: "extension", name, tool,
arguments}`); the daemon reads the extension from disk, checks that the
tool is declared and its arguments are an object, and runs `bun -e` on a
fixed runner, inline, with the extension's directory, the tool's name and
the arguments as its arguments, in the same sandbox as any command, with
the same time limit and cancel. The tool's return value, on stdout, is the result; the call is
journaled as an `extension` effect with the extension's digest.

So extension code can do exactly what a sandboxed command can, and nothing
of strive's: it never runs in the daemon or the host, never sees keys,
another extension's state or the journal, and can't reach the daemon to
answer approvals or change anything about the session.

### It runs unasked only in a form a person accepted

As for checks (ADR-0023): an extension runs without asking only when its
directory's digest (every file, by path and content) is an applied
proposal's, or a person allowed it, as it is now, for the session. Any
other form asks, naming the tool and the extension. `.strive/extensions`
joins "What shapes a session", so an agent's write there asks a person, and
it is read only when reached without a symlink.

### It becomes live through a proposal, with its tests as a gate

`Change::Extension {name, files}` replaces the directory as a whole (at
most 64 KiB, `.ts`, `.json` and `.md` files only, no `node_modules`). Its
gates, in order:
1. the static gate: the manifest's form, tool names, schemas, the size and
   file rules, secrets and hidden text, as for any proposal;
2. a new **tests** gate: the daemon runs the extension's `*.test.ts` with
   `bun test` in the sandbox; a failure blocks, as the static gate does;
3. the judge, advising, as now.

A person accepts it; rollback restores the directory as it was. Review
shows the files' diff and each tool's schema and description in plain
words ("can read and change files in the workspace, like a command").

### A work session may propose one when a person asks for it

Until now only the learner proposes (ADR-0016): a work session's agent
changing what later sessions are given would skip review. An extension is
the exception the user's own request makes: "build me a tool that ...". A
work session gets a `propose_extension` tool that turns a draft directory
(`.strive/drafts/extensions/<name>`, not loaded, not guarded) into a
proposal, journaled in the project's learning session with the work
session as its origin. It goes through every gate, and nothing is live
until a person accepts it. The agent develops against the draft with `bun
test` as an ordinary command.

### Safe mode, and one that keeps failing

`strive --safe` (and a setting) loads no extensions. An extension whose
calls fail, time out or crash three times in a session is left out for the
rest of it, and the person is told, with rollback one step away.

## Not decided here

- Hooks (code run on `tool_call` or `turnEnd`) come next: they may only make
  things stricter (ask, deny, require a check), never allow or rewrite
  results. Slash-command handlers and UI widgets after that.
- Network for an extension is refused in v1; later it may be a declared
  capability through an egress proxy.
- The variant archive: each accepted version, with its parent and how it
  fared, is kept by the proposal history already; selecting among variants
  (HGM-style) waits for an eval that measures extensions.

## Consequences

- The agent can grow strive's tool set in a session, and a person keeps the
  decision: nothing it writes runs unasked until accepted, and what runs is
  confined like a command.
- A tool call costs a Bun process start (tens of milliseconds); a
  long-lived worker can come later if that matters.
- The eval gains a family to measure: tasks only a new tool solves.
