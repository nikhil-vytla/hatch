---
name: unknowns-discovery
description: Surface the gap between what the user has specified (the map) and what the codebase/task actually requires (the territory) before it becomes an expensive mid- or post-implementation surprise. Use at the start of unfamiliar work, when a spec feels underspecified, or before merging a long agentic session.
---

# Unknowns discovery

Implements the technique catalog from Thariq Shihipar's "A Field Guide
to Fable: Finding Your Unknowns" (Anthropic). The core idea: agentic
coding quality is bottlenecked less by the model and more by how well the
user's unknowns get surfaced before the model has to guess at them.
Unknowns come in four flavors:

- **Known knowns** — already in the prompt.
- **Known unknowns** — gaps the user knows they have.
- **Unknown knowns** — things the user would recognize but can't specify
  up front (e.g. visual taste).
- **Unknown unknowns** — gaps the user isn't aware of at all.

Over-specifying makes the agent follow orders past the point a pivot
would help; under-specifying makes it fall back to generic best
practices that may not fit. The fix is context about the user's actual
starting point (what they know, where they are in their thinking), not
more or fewer rules.

## Pre-implementation

- **Blind spot pass** — when starting in an unfamiliar codebase area or
  domain, explicitly surface the user's likely unknown unknowns before
  writing code, given context on what they already know.

  ```text
  Do a blind spot pass: given what I've told you about my familiarity
  with [area], identify what I probably don't know I don't know yet,
  and explain it before we start.
  ```

- **Brainstorm / prototype** — for unknown-knowns-heavy work (design,
  UX), produce several divergent, cheap-to-throw-away options before
  wiring up real functionality.

  ```text
  Before wiring anything up, give me [N] wildly different approaches to
  [thing] as a disposable prototype/mockup so I can react to them.
  ```

- **Interview** — ask the user targeted questions about ambiguity,
  prioritized by which answers would actually change the architecture.

  ```text
  Interview me one question at a time about anything ambiguous here,
  prioritizing questions where my answer would change the architecture.
  ```

- **Reference** — when a behavior is too complex or unfamiliar to
  describe in words, point at an existing implementation instead.

  ```text
  [path/to/reference] implements the behavior I want. Read it and
  reimplement the same semantics here, even though the target is a
  different language/stack.
  ```

- **Implementation plan** — ask for a plan that foregrounds the
  decisions most likely to change and buries mechanical work.

  ```text
  Write an implementation plan that leads with what I'm most likely to
  want to tweak (data model, type interfaces, user-facing behavior).
  Put mechanical/refactoring work at the bottom.
  ```

## During implementation

- **Implementation notes** — keep a running log of any deviations
  forced by edge cases discovered mid-work, defaulting to the
  conservative choice when a deviation is required.

  ```text
  Keep an implementation-notes.md file. If you hit an edge case that
  forces a deviation from the plan, take the conservative option, log
  it under "Deviations," and keep going.
  ```

## Post-implementation

- **Pitch / explainer** — package the prototype, spec, and
  implementation notes into a single document for review/buy-in.

  ```text
  Package the prototype, spec, and implementation notes into a single
  doc I can share for buy-in. Lead with the outcome/demo.
  ```

- **Quiz** — before merging, have the agent quiz the user on what
  actually changed and why, since reading a diff alone under-represents
  the behavioral surface area of a change.

  ```text
  Quiz me on what changed in this session and why, with enough context
  that I can answer without re-reading the diff. I want to actually
  understand this before I merge it.
  ```

## When to skip this

Not every task has meaningful unknowns worth surfacing — a well-scoped,
familiar, small change doesn't need a blind spot pass or an interview.
Use judgement about which of the above phases actually apply; running
all of them on a trivial task adds overhead without reducing risk.
