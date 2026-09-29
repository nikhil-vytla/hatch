# ADR-0019: Predictions are checked by a watch the daemon evaluates

Status: superseded, 2026-09-28. The watch language, `predictionChecked`,
tallies and the "may be hurting" suggestion are deleted. A proposal keeps its
prose `prediction`, which the person reviewing it reads. The stale-memory
check (`strive_learning::stale`) stays: it doesn't depend on watches. The
record below is kept as history.

The evidence (NOTES, "subtract before adding"):
- Nobody gates each learned change by replay: exo, Prime Agent and the
  literature validate learned context offline, over many tasks, if at all.
- At three runs a side, a change that does nothing passes "with > without"
  about a third of the time, so a pass said little about the change.
- Our adversarial reviews found the checks themselves were the main attack
  surface and the main complexity.

System-level validation is to come back as an offline `strive eval`, not
as a check on each proposal.

Watches had the same weakness at smaller scale: a learner-written predicate
checked on a handful of sessions, whose tally a person had to interpret.

Originally: refined M11 in [ADR-0016](0016-trusted-learning.md).

## Context

Every proposal carries a `prediction`: a falsifiable claim about later
sessions ("sessions that run the host tests won't first fail with 'no
display'"). The checks before acceptance (static, judge, replay) ask whether
a change is sound. None of them asks whether it kept working after a person
accepted it. ADR-0016's M11 does: check each accepted proposal's prediction
against the sessions that come after it, show whether it is holding, and
suggest a rollback when it looks like it's hurting.

A prose prediction can be checked only by a model. That brings cost, a key,
a budget and a verdict the learner's own words can sway, on every session of
every project. bb's suggestion 2 ("what bb suggests" in NOTES) is to put a
small predicate a machine can check beside the prose instead.

What makes this hard:
- **The predicate is the learner's.** Whatever it writes, the daemon
  evaluates on every later session. So the language must be total, cheap and
  bounded: no regular expressions, no loops, nothing whose cost depends on
  the learner's input beyond a fixed limit.
- **Sessions are long and outputs large.** A command's output is kept up to
  200 KiB; a session can run thousands of commands.
- **A session isn't over when a turn ends.** A person can come back to it.
- **Drift is a pattern over many sessions,** and a single contradiction is
  noise.

## Decision

### A watch: a tiny predicate beside the prose

A proposal keeps its prose `prediction` and may add a `watch`. The learner's
`propose_change` tool takes it; its prompt says when to give one.

- **Steps.** A session, for a watch, is its steps in order: each prompt (a
  person's message) and each command that ran (its text, its output and its
  exit). Only commands that ran count: a refused one did nothing.
- **A step pattern** (`StepMatch`) names what to look for, as substrings,
  case-insensitive:
  - `prompt`: a prompt containing this; or
  - any of `command`, `output` (the command's output) and `exit` (`zero` or
    `nonZero`; a command stopped by its time limit is `nonZero`), which a
    command step must all match.

  A pattern names at least one field, and `prompt` stands alone.
- **The watch** is an optional `when` pattern and one expectation:
  - `never: P`: no step matches P;
  - `any: P`: some step matches P;
  - `first: {of: P, is: Q}`: the first step matching P also matches Q.
- **Outcomes,** for one session:

  | Situation | Outcome |
  | --- | --- |
  | No prompt, or no step matches `when` | not applicable |
  | `first`, and no step matches `of` | not applicable |
  | `never`: a step matches; `any`: none does; `first`: the step doesn't match `is` | contradicted |
  | Otherwise | confirmed |

  Examples:
  - "in sessions that run `bun test`, no output of it says `no display`":
    `{when: {command: "bun test"}, expect: {kind: "never", step: {command: "bun test", output: "no display"}}}`;
  - "the first test command runs `bun test src`":
    `{expect: {kind: "first", of: {command: "test"}, is: {command: "bun test src"}}}`;
  - "the user doesn't say X": `{expect: {kind: "never", step: {prompt: "X"}}}`.

Why this shape: it covers what a learned bullet is usually about (a command
to run or not, an error that shouldn't recur, a correction the user
shouldn't have to repeat), and every question is answered in one pass over
the steps. A step pattern can't reach across steps, so no evaluation is more
than linear in what it reads.

### Bounded, and honest about what it didn't read

- **The static gate** fails a malformed watch (rule `watch`): a pattern with
  no field, `prompt` with a command field, a `first` whose two patterns can't
  both match one step (a prompt pattern and a command one), and any string
  that is empty, over 200 bytes, or holds a line break. The hidden-text rule
  covers its strings too.
- **Evaluation** reads at most 2,000 steps, at most 256 KiB of any one
  output, and at most 8 MiB of output in all per session, and only when a
  pattern names `output`. Substring search is linear.
- **A cut session** decides only what the part it read decides. A
  contradiction found stands, and so does a confirmation for `any` and
  `first`. An outcome that needed the rest (`never` finding nothing, say) is
  not applicable, and the detail says the session was too long to check
  whole.
- **Only ended turns count.** A session is read up to its last `turnEnded`;
  one with none isn't checked yet.

### When the daemon checks

- **Which proposals:** applied and not rolled back, with a watch.
- **Which sessions:** the project's work sessions created at or after the
  proposal was applied. A session begun before it started with the old file.
- **When:**
  - a work session's host records `turnEnded`: that session is checked in
    the background;
  - `learning/run`: every session of the project is checked first. This
    catches up after a crash, or a turn that ended without its host (a host
    that died mid-turn).
- **What is journaled:** `predictionChecked {proposal, session, throughSeq,
  outcome, detail}`, in the learning session, under the project's lock,
  only when the pair has no record yet or its outcome changed. So checking
  again journals nothing, and a session that continues and changes its
  answer is recorded again. The latest record per pair is the one that
  counts.

### Tallies, and "not holding"

`proposal/list` folds each watched proposal's records into a
`prediction` tally: sessions confirmed, contradicted and not applicable;
and, over the last 10 sessions it applied to (by session id, which orders
sessions by creation), how many confirmed and contradicted it.

- **Not holding:** at least 3 of those 10 contradicted it, and more
  contradicted than confirmed. One bad session is noise; three that
  outnumber the good ones are a pattern.
- **A proposal without a watch** has no tally. The surfaces say "prediction
  not machine-checked".
- **The suggestion:** an applied proposal that is not holding shows it, with
  the rollback that undoes just that proposal's file: `strive review` puts a
  line under the list and in the proposal's detail, and the desktop's Learned
  pane shows it in the proposal's Prediction section, beside the existing
  Roll back button.
- **Never automatic.** The daemon never rolls anything back. Rollback is
  `proposal/rollback`, a person's request, as before.

### The judge

The judge is shown the watch, and its `checkable` criterion asks, when there
is one, whether it tests what the prediction claims. A watch isn't required
to pass.

## Consequences

- **Drift shows without spending anything:** checks cost no model call and
  need no key.
- **A watch can be wrong in a way a person has to catch.** A watch that
  tests the wrong thing confirms a bad change or condemns a good one. A
  person reads it in review, beside the prose, and the judge is asked about
  it.
- **Substrings are crude.** They can't tell "no display" in a test's output
  from the same words in a log line. The threshold keeps one such
  coincidence from suggesting a rollback.
- **The tally lags a crash** until the next turn end or `learning/run`.
- **Stale memory** (bb's suggestion 4): a memory line that names a
  project path which no longer exists is listed as "may be stale" by
  `proposal/list` (`mayBeStale`), read from the file as it is, and `strive
  review` prints it. Only backticked, relative paths with a `/` and no
  spaces or glob characters count (`src/a.ts:12` names `src/a.ts`), so
  commands and paths outside the project don't.
- **Deferred:**
  - stale memory in the desktop pane, skills' paths, and commands a bullet
    names that later fail;
  - watches on file effects (a file written or not), and on the order of
    two different steps ("runs X before Y");
  - telling the learner how its predictions fared, so it can drop or amend a
    lesson itself;
  - a watch for quality that peaks and then declines (ADR-0016's second M11
    bullet): only a contradiction rate is watched.
