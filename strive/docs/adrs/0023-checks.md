# ADR-0023: Verification checks, the first declarative extension

Status: accepted (2026-09-30). The first of three declarative extensions;
slash commands and scoped rules follow under the same rules.

## Context

strive learns memory bullets and skills: advice the agent may or may not
follow. The eval (ADR-0021) found most of a learned rule's value is lost to
whether the agent acts on it, and the frontier agrees ("Harness updating is
not harness benefit", 2605.30621; Anthropic's harness posts: a way for the
agent "to verify its work" is the largest lever). Practitioners turn
corrections into checks that shape later work (OpenAI's harness
engineering), not only into prose.

bb, exo and Prime Agent let the agent extend its own harness, with a fast
loop and no containment: agent-written code runs with full trust, and
nothing tests it against tasks before it is live (NOTES, 2026-09-30). The
roadmap's extension stage starts with what needs no new way of running
code: declarative artifacts that go through the proposal pipeline strive
already has.

## Decision

### A check is a file

`.strive/checks/<name>.md`, one per check:

```markdown
---
name: host-tests
description: The host's tests pass after a change to it
run: bun test packages/host
paths: packages/host/**
---
Why: the host's tests catch protocol drift the type checker can't.
```

- `name`: 1 to 40 of `a-z`, `0-9` and `-`, the file's name.
- `description`: one line, what passing means.
- `run`: one line, the command. At most 500 characters.
- `paths` (optional): comma-separated globs, relative to the workspace
  (the session's directory, where `.strive/checks` is read and the command
  runs). The check applies when a changed file matches one; without
  `paths`, when any file changed.
- `timeout` (optional): seconds, 1 to 600, default 120.
- The body (optional) is shown to the agent when the check fails.

`.strive/checks` joins "What shapes a session" as learned: an agent's
write there asks a person in every mode, and it is loaded only when
reached without a symlink, as `.strive/skills` is.

### The daemon runs the command a person accepted

At the end of a turn that changed files, the host asks the daemon to run
each check that applies, by name: `effect/run` with `{kind: "check",
name}`. The daemon reads the check from disk under the same rules as
loading, and runs its `run` line as a command effect, journaled as a
`check` record with the exact command. The host never supplies the
command.

- A check runs without asking, in every mode, only in a form a person
  accepted: the content of an applied check proposal, or content a person
  allowed for the session when asked. A check in any other form asks,
  naming its command. "Allow" runs it that once; "allow for the session"
  covers this check as it is now, in this session only (a session
  allowance, journaled with the request), never full-auto; a change to the
  file asks again. Lasting acceptance is a proposal a person accepts. The
  file alone doesn't show a person wrote it: on Linux the sandbox makes
  `.strive/checks` read-only only where it exists, so a command could
  create one in a project without it. Without a sandbox a check asks, as
  any command does.
- A check that doesn't run (no one accepted it, or the daemon stopped)
  isn't the agent's to fix, so it isn't sent back.
- What applies is decided from the turn's changes against its checkpoint
  (`session/changes`), so a command's edits count as much as the agent's.

### A failed check goes back to the agent

When a check fails (a nonzero exit, or its time limit), the host tells the agent
which, with the end of its output and the check's body, and the turn goes
on. After 2 such rounds the turn ends as it is; the journal shows the
failed check. The host journals the report (`checksReported`) before the
agent sees it, and a resumed conversation has it where it was, so a host
that stops between the two resumes with the agent told.

### Checks are proposed like skills

`Change::Check {name, content}` replaces the whole file. The static gate
checks the frontmatter (each field above), the size (4 KiB), the `run`
line's form and the safeguard phrases, as for skills; the judge advises;
a person accepts; rollback restores the file as it was. The learner is told
when a check fits: a command the user says to run after a kind of change,
or one the agent ran to find its own mistake.

## Not decided here

- Slash commands (`.strive/commands/<name>.md`, the Claude Code format) and
  rules scoped by path (`.strive/rules/<name>.md`, `paths:` frontmatter) are
  next, each a `Change` kind under the same pipeline.
- Checks per bullet outcome: a check's pass or fail is the outcome signal
  per-bullet tracking needs; that is its own change.
- Code extensions (tools, hooks) run in a sandboxed worker, never the host
  or the daemon. That is the next milestone, and it gets its own ADR.

## Consequences

- A learned rule can become something the daemon enforces rather than
  advice, and the eval can measure the difference (a check arm).
- An agent can't weaken or plant a check: editing one asks a person, a
  form no person accepted asks before it runs, and the command run is the
  file's, not the host's.
- A turn that changes files costs the checks' run time. A slow check is
  the person's choice; its timeout bounds it.
