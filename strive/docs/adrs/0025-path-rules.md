# ADR-0025: Rules scoped by path, the third declarative extension

Status: accepted (2026-09-30). Follows ADR-0023 (checks) and ADR-0024
(slash commands); together they are the extension plan's first milestone.

## Context

Memory goes to every session. The eval (ADR-0021) measured the cost: on
generic tasks, where no learned rule applies, memory took 1.12x the turns.
Much of what a project's agent should know holds for only part of it: the
API handlers validate their input, the migrations are never edited after
release. Told to every session, that is noise for most of them. Claude
Code's answer is rules scoped by path (`.claude/rules/<name>.md` with
`paths:` globs), loaded when the agent works on a file they match; Cursor's
rules do the same.

## Decision

### A rule is a file, in Claude Code's format

`.strive/rules/<name>.md`: optional frontmatter (`description`, `paths`),
then the guidance. `paths` is comma-separated on its line, or a YAML list
on the lines after it, as Claude Code writes it. Globs are relative to the
workspace: `*` and `?` stay in a path component, `**` crosses them,
`{a,b}` is either (globset, with a literal separator).

Rules are read from `.strive/rules` (reached without a symlink, read
strictly), then `.claude/rules` (read leniently); the first of a name wins.
Both join "What shapes a session": an agent's write there asks a person.

### A rule with paths comes with the first file it covers

When a read, write or edit in the workspace succeeds on a file a rule's
paths match, the daemon gives the agent the rule with that effect's
output, the first time in the session, and journals `ruleLoaded {effect,
name, file, digest}`. The session's writer keeps the rules given, by name
and digest, and checks and journals in one step, so two effects at once
don't both bring a rule; a rule changed since is given again. The rule's
text is part of the effect's output as journaled, so a resumed
conversation has it where it was.

A rule without paths is for every session: it joins the instruction files,
after `AGENTS.md` and before memory.

### Rules are proposed like skills

`Change::Rule {name, content}` replaces the whole file, gated on its file
as strict loading reads it, at most 16 KiB. The learner is told to prefer a
rule to a memory bullet when a lesson holds for only some files.

## Consequences

- A lesson for one part of a project reaches only the sessions that work
  there, which the eval's generic-task overhead says matters.
- A project's Claude Code rules work in strive unchanged.
- Delivery rides on an effect the agent asked for, so a rule can't arrive
  unprompted, and the host has nothing to do: the rule is in the result it
  already rebuilds from the journal.
