# ADR-0024: Slash commands, the second declarative extension

Status: accepted (2026-09-30). Follows ADR-0023 (checks); path-scoped
rules come next under the same rules.

## Context

A person who asks for the same multi-part thing again and again (the same
review steps, the same release checklist) retypes it, and says it a little
differently each time. Claude Code's answer is a prompt saved as a file,
run as `/name arguments` (`.claude/commands/<name>.md`, with `$ARGUMENTS`
and `$1`-`$9`), and projects already have them. A command is the learner's
natural output for "the user types this request every session", and, like a
check, it is declarative: it needs no new way of running code.

## Decision

### A command is a file, in Claude Code's format

`.strive/commands/<name>.md`: optional frontmatter (`description`,
`argument-hint`), then the prompt. `$ARGUMENTS` is what follows `/name`,
`$1` to `$9` its words; arguments a prompt doesn't place are added after
it, so none are lost. Expansion is one pass, so what the arguments say is
never expanded itself.

Commands are read from `.strive/commands` (reached without a symlink, and
read strictly: a frontmatter field strive doesn't read is a typo, so the
command isn't offered), then `.claude/commands` and `~/.strive/commands`
(read leniently: Claude Code's files have more fields). The first of a name
wins. `.strive/commands` and `.claude/commands` join "What shapes a
session": an agent's write there asks a person.

### The daemon expands it

`session/prompt` with `/name arguments`, where the session's project has a
command `name`, journals the prompt it stands for as the `userMessage`,
with `command: {name, arguments}`. Anything else, `/unknown` included, is
the prompt as typed. So every client (the TUI, the desktop app, `strive
run`, an editor later) runs commands the same way, and the journal holds
both what the person typed and what the agent was given. Clients show the
command as typed; the learner's pre-filter reads a correction in what was
typed (the arguments), not in the prompt.

`session/commands` lists a session's commands for a client to offer. The
TUI completes and lists them beside its own; its own win a name both have.

### Commands are proposed like skills

`Change::Command {name, content}` replaces the whole file. The static gate
reads it as strict loading does, checks its size (16 KiB) and the safeguard
phrases; the judge advises; a person accepts; rollback restores the file.
The learner is told to propose one for a multi-part request the user types
again and again.

## Consequences

- A request a person repeats becomes one they can run, and the learner can
  propose it from the sessions that show the repetition.
- A project's Claude Code commands work in strive unchanged.
- A command is a prompt, so it can't do anything the agent couldn't be
  asked to do; approvals and the sandbox apply to what follows.
