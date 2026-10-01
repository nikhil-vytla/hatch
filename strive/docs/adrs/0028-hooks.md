# ADR-0028: Hooks: an extension's code before a tool call, which may only make it stricter

Status: accepted (2026-10-01). Follows ADR-0027, which left hooks for next.

## Context

An extension (ADR-0027) adds tools the agent chooses to call. A person
often wants the opposite: code that looks at every call the agent makes
and stops some ("never touch `migrations/`", "ask before any `git push`").
Claude Code's PreToolUse hooks do this, and may also allow a call or
rewrite its input. A hook that can allow is a way around the approval
mode, and one that rewrites makes the journal's record of the request
differ from what ran.

## Decision

### An extension declares its hooks, and exports them

```json
{"name": "guard", "description": "...", "tools": [],
 "hooks": [{"event": "tool_call", "tools": ["bash", "write", "edit"]}]}
```

```ts
export const hooks = {
  tool_call: async (call, ctx) =>
    call.kind === "bash" && call.command.includes("git push")
      ? { decision: "ask", reason: "pushing leaves this machine" }
      : undefined,
};
```

`tool_call` is the only event. `tools` lists the effect kinds it sees
(`read`, `write`, `edit`, `bash`, `mcp`, `check`, `extension`); without it,
every kind. An extension may have hooks and no tools.

### The daemon runs them, after the gate and before the effect

For every effect a work session asks for, the daemon runs each matching
hook after the approval gate and before anything is performed. A hook gets
the request as the protocol has it (`{"kind": "bash", "command": ...}`;
a write's or edit's text and a tool's arguments are left out if together
they pass 32 KiB, with `"truncated": true`). It runs like an extension's
tool: `bun -e` on a fixed runner, in the command sandbox, for at most 10
seconds.

A hook answers `ask`, `deny`, or nothing:
- `deny` refuses the call, with the hook's reason, whatever the gate said;
- `ask` turns an allowed call into one a person is asked about, and adds
  its reason to one already asked about;
- nothing leaves the gate's decision as it is.

There is no `allow` and no rewrite. A hook can only make a call stricter,
so a hook can't widen what the approval mode lets through, and the request
the journal records is the one that runs.

### A hook that fails asks

A hook that crashes, runs past its time or answers anything else counts as
`ask`, with what went wrong, every time: a broken guard doesn't stop
guarding. Leaving out a hook after repeated failures (as an extension's
tool is, ADR-0027) would let an agent that can make it fail, with a call
it chokes on, turn it off. A person who wants a broken hook gone rolls its
extension back, as the question says.

### Only an accepted form runs

As for an extension's tools, a hook runs only when its extension's
directory is in a form a person accepted: an applied proposal's, or one a
person allowed for the session. A changed extension's hooks don't run
until it is accepted again. Changing `.strive/extensions` asks a person,
so the agent can't stop a hook without one.

## Not decided here

- Hooks at turn end. Checks (ADR-0023) already run when a turn ends and
  report to the agent.
- A hook's decision is journaled only through the effect it decided:
  the question asked, or the refusal, names the hook's extension. Recording
  the hook's digest with it can come with replay of hooks.
- A long-lived worker per extension, if a Bun start per hooked call (tens
  of milliseconds) turns out to matter.

## Consequences

- A person can guard a project with code, and trust that the guard can
  only tighten what strive already does.
- Every hooked call costs a sandboxed Bun start. Declaring `tools` keeps
  reads, which are the most frequent, unhooked unless asked for.
