# Thariq Shihipar (@trq212) — "A Field Guide to Fable: Finding Your Unknowns"

- Author: Thariq Shihipar, Anthropic (Claude Code team)
- Post: https://x.com/trq212/status/2073100352921215386

## Verification status

Direct fetch of x.com returns HTTP 402 in this environment (confirmed
across two sessions), and no browser access was available either
(Chrome extension wouldn't connect). The user pasted the full text of
the article directly into the conversation, which is how the summary
below was produced — not reconstructed from search snippets. This
**corrects an earlier version of this file**, which had characterized
the post's theme as being about delegating coding subtasks to
lower-power subagent models. That was wrong: this article never
mentions model delegation at all. That idea only ever traced back to
Simon Willison's post (see
[simon-willison-fables-judgement.md](simon-willison-fables-judgement.md)),
and got conflated with this one during the earlier, search-snippet-only
reconstruction. Full verbatim text is not reproduced here (or anywhere
in this repo) — this is a paraphrase in my own words.

## Summary (in my own words)

The essay's frame: the map (your prompts, skills, and context) is not
the territory (the actual codebase and its real constraints). The gap
between the two is what Thariq calls an "unknown" — and whenever Fable
hits one mid-task, it has to guess at what the user wants. His claim is
that Fable is the first model capable enough that output quality is now
bottlenecked less by the model and more by how well the user surfaces
their own unknowns, before, during, and after implementation.

He splits unknowns into four kinds (a version of the classic Rumsfeld
matrix applied to prompting):
- **Known knowns** — what's already in the prompt.
- **Known unknowns** — gaps you're aware you have.
- **Unknown knowns** — things you'd recognize but couldn't specify in
  advance (e.g. visual taste).
- **Unknown unknowns** — gaps you don't know exist at all.

The instructing balance he describes: over-specify and Claude follows
orders even when a pivot would serve better; under-specify and Claude
defaults to generic best-practice assumptions that may not fit the
task. His fix is to give Claude context about the user's own starting
point — where they are in their thinking, their prior experience with
the problem/codebase — so it can act as a thought partner rather than
either a literal executor or a blind guesser.

### Technique catalog (organized by phase)

**Pre-implementation**
- *Blind spot pass* — ask Claude to explicitly surface the user's likely
  unknown unknowns before starting, especially in unfamiliar code areas
  or domains, giving it context on what the user already knows.
- *Brainstorms and prototypes* — for unknown-knowns-heavy work like
  visual design, ask for several divergent options (e.g. an HTML page
  with a handful of different design directions, or a throwaway
  mockup) to react to before wiring up real functionality. Also useful
  at the very start of a session, to avoid scoping a task too narrowly
  or too broadly.
- *Interviews* — ask Claude to interview the user one question at a
  time about ambiguities, prioritizing the questions whose answers
  would actually change the architecture.
- *References* — when something is too hard to describe in words,
  point Claude at existing source code that implements the desired
  behavior (even in a different language) rather than trying to
  articulate it; the same principle underlies pointing an agent at a
  live component/module to read its underlying markup instead of just a
  screenshot.
- *Implementation plans* — ask for a plan that foregrounds the parts
  most likely to change (data models, type interfaces, user-facing
  flows) and pushes mechanical/refactoring work to the bottom.

**During implementation**
- *Implementation notes* — have Claude maintain a running notes file
  during the work itself, logging any deviations it's forced into by
  edge cases discovered mid-implementation (defaulting to the
  conservative choice when it has to deviate), so both the user and
  future sessions can learn from it.

**Post-implementation**
- *Pitches and explainers* — package the prototype, spec, and
  implementation notes into a single shareable document to accelerate
  review/buy-in from people who share the same unknowns the author
  started with.
- *Quizzes* — after a long session, ask Claude to quiz the user on what
  actually changed and why, as a comprehension check before merging —
  the idea being that reading a diff alone under-communicates the
  behavioral surface area of a change.

### Case study: editing Fable's own launch video

Thariq describes using these same techniques on himself in an
unfamiliar domain (video editing): asking Claude to explain how
transcription-based editing (Whisper + ffmpeg) works before trusting it
with cuts, prototyping a word-synced UI in Remotion to de-risk a
technical unknown, and — notably — asking Claude to teach him what
"good" color grading even looks like once he realized he lacked the
taste to judge outputs himself, rather than asking Claude to just
generate variations to choose from blind.

### Closing point

When a long-running agentic task comes back wrong, his diagnosis is
usually that the user needed to spend more time surfacing unknowns
up front, or needed to build a plan that explicitly leaves room for
Claude to improvise around the unknowns that remain. Every technique
above is framed as a cheap way to discover what you didn't know before
it becomes expensive to fix mid- or post-implementation.
