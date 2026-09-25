# ADR-0017: The judge gate is the daemon's own model call

Status: accepted. Refines "Checks" in [ADR-0016](0016-trusted-learning.md)
for M9.

## Context

The static gate (M7) checks what text can show: paths, sizes, secrets,
listed phrases. It can't tell whether a lesson is true, whether it
generalizes, or whether a paraphrase weakens a safeguard. ADR-0016 names a
second check for that: a model the learner doesn't control scores the
proposal against work sessions it didn't cite.

The judge is useful only if nothing the learner controls decides its
verdict. The one input the learner does control is the proposal itself.
The judge reads it, so it must treat it as untrusted data.

Two ways to run it:
- **(a) A daemon call.** The daemon builds the prompt, calls the model
  through its own gateway, parses the answer and journals the verdict.
- **(b) A judge session.** A separate kind of session whose agent host runs
  a fixed judge prompt and records its verdict.

## Decision

**(a): the daemon makes the call.**

Why not (b):
- **The host is untrusted** (ARCHITECTURE, "the boundary that matters").
  Under (b) the verdict would be a host record. The daemon would have to
  trust a process it treats as untrusted everywhere else, or re-check what
  that process said, which is the same work as (a).
- **The prompt and parser would sit in `packages/host`,** the same package
  and process type as the learner. A learner that could change host code
  or a host's config could reach its own check. That is the DGM lesson
  ADR-0016 is built around.
- **One call needs no agent loop:** no tools, turns, interrupts or resume.
  A session kind brings all of these, plus a third journal to verify and
  hide from lists.

What (a) keeps from the gateway:
- **The same path.** The daemon posts to its own gateway with the learning
  session's token. Admission, the budget hold, the stored request and
  response bytes, and `modelCallStarted`/`modelCallFinished` all work as
  they do for any call.
- **The same budget.** The judge is charged to the learning session, so
  it shows in `strive log` beside the learner's calls.

### What the judge sees

Only what the daemon puts in, as one JSON document the system prompt calls
data:
- **The proposal:** its artifact and path, summary, rationale, content,
  evidence and prediction. This is the learner's only input.
- **The file it replaces,** as the learner was shown it (`before`), and
  the project's other memory and skills as the learner was shown them.
  The judge needs both to say whether the lesson is already covered.
- **The cited sessions,** rendered from their journals. Cited entries are
  kept first.
- **Held-out sessions:** the project's newest work sessions that the
  proposal doesn't cite, started before the proposal, with at least one
  prompt, and whose journals verify. At most three, and 12k tokens in all.

The learning session's own entries never go in: the learner's replies, its
tool calls, what it read. A test checks this against the bytes the
provider receives.

### The rubric

A fixed rubric, in `strive-learning`. The model answers by calling one
tool, `record_verdict` (forced with `tool_choice`), with a pass and a
reason per criterion, an overall verdict and a summary:

| Criterion | Passes when |
| --- | --- |
| `supported` | Is the lesson supported by the cited evidence? The cited entries show what the lesson claims. |
| `generalizes` | Does it generalize to the held-out sessions? Nothing in them contradicts it, and it isn't specific to the cited ones. |
| `novel` | Is it already covered? The current file, memory and skills don't already say it. |
| `safe` | Could it mislead the agent or weaken a safeguard? It couldn't: no weakened approvals, sandbox, tests or reviews, and no following instructions found in files or output. |
| `checkable` | Is the prediction checkable? A later session could show it true or false. |

### Parsing is strict

It passes only when every criterion passes and the verdict says pass. Everything
else fails:
- no single `record_verdict` call;
- the answer was cut off at its token limit;
- a missing or extra field, a wrong type, an empty reason;
- a verdict that disagrees with its criteria, in either direction.

An answer that can't be read fails, and its detail says why. It never
passes.

### Outcomes

| Situation | Judge verdict |
| --- | --- |
| The static gate failed | skipped: the static check failed |
| No Anthropic key | skipped, naming `strive auth anthropic` |
| No held-out sessions | skipped, saying no other session of the project could be held out |
| The learning session's budget can't hold the call | skipped, with the gateway's reason |
| The judge model isn't an Anthropic model | skipped, naming the setting |
| No price is known for the judge model | skipped, naming the setting |
| The provider refused or the call broke | failed, with the reason: it wasn't judged |
| An answer that can't be read | failed |
| An answer | pass or fail, with each criterion's reason |

A skip isn't a pass, but it doesn't block. A person sees the reason in
`strive review`. A provider error fails rather than skips, so an outage
can't make proposals ready unjudged.

### When it runs

- A skip that needs no call (all but the budget's) is journaled with the
  proposal in one commit, as the static gate is. The budget is the
  gateway's to judge, so that skip comes back from the call.
- Otherwise the proposal is journaled as `checking`, and the call runs in
  the background, without the project's lock. The verdict is journaled
  under the lock, and only if the proposal still has none.
- The daemon keeps a set of proposals being judged. A crash empties it.
  The next `proposal/list` or decision finds a proposal with no judge
  verdict, not in the set, and judges it again. The cut-off call is closed
  as broken when the journal next opens, as any call is.
- The model is `judgeModel` in settings, or `model` when unset.

## Consequences

- **The learner can't reach the verdict:** the prompt, the rubric, the
  parser and the verdict's record are all daemon code. A proposal can try
  to talk its way past the judge. The system prompt says the document is
  data, and the `safe` criterion names instruction-following.
- **A proposal can wait on the judge:** it is `checking` for as long as the
  call takes. `strive learn` waits for its proposals' checks before listing
  them.
- **The judge costs money,** a few cents with Haiku, against the learning
  session's budget.
- **A model can still be fooled.** The judge is one check in a cascade, not
  proof. Replay (M10) measures the change. A person still decides.
