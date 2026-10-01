# ADR-0026: How each memory bullet fares in use

Status: accepted (2026-10-01).

## Context

A proposal carries evidence that a lesson is real and a prediction of what
it will change, but nothing says afterwards whether a bullet is used or
helps. The frontier calls this the main gap: most of a learned rule's value
is lost to whether the agent acts on it ("Harness updating is not harness
benefit", 2605.30621), and memory nobody uses still costs every session
tokens (1.12x turns on unrelated tasks in ADR-0021's eval). Codex keeps
memory by citation: replies cite the memory they used, and memory unused
for 30 days is dropped. strive already journals exactly what each session
was given (`contextLoaded`, each file's digest) and each bullet's source.

## Decision

- **Sessions see each sourced bullet labelled** `[mN]`, N its proposal, in
  place of the source comment they can't see, and memory's label asks the
  agent to write `[uses mN]` when a bullet shapes what it does. Hand-written
  bullets have no id and aren't tracked.
- **`memory/usage`** (a pure tally in `strive-learning`, read by the daemon
  over the project's latest 100 work sessions) gives each bullet:
  - `sessions`: how many were given it, from the memory their agent was told;
  - `cited`: turns whose replies cited it;
  - of those, `clean` and `trouble`: trouble is a correction in the next
    prompt, a rewind, a declined approval, a failed check, or a turn that
    didn't end done, before the next prompt; a turn cut off with the session
    counts as neither;
  - the latest few troubles, each with its session and entry.
- **It is shown where memory is**: `strive review --memory`, the desktop's
  "What every session reads now", and the learner's view of memory, whose
  prompt says what the counts suggest (never cited: maybe dead weight;
  trouble after cites: maybe wrong) and to read the noted entries first.

A cite is the agent's own word, so the counts are shown beside what strive
saw after it, never alone, and nothing is removed automatically: a person,
or a proposal a person accepts, does that.

## Consequences

- A bullet that does nothing, and one that keeps going wrong, become
  visible to a person and to the learner, with entries to check.
- Sessions spend a few tokens on labels and cites.
- The eval can measure what it couldn't: whether a learned bullet was acted
  on, apart from whether the task passed.
