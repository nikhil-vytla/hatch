# Fable 5 addendum for AGENTS.md / CLAUDE.md

Drop-in instruction blocks for working with Claude Fable 5 (or similar
high-capability, long-horizon agentic models). Copy the sections you need
into your project's AGENTS.md/CLAUDE.md rather than the whole file — these
are meant to replace overly prescriptive rules written for older, less
capable models, not stack on top of them.

Source: distilled from Anthropic's official prompting guide and public
commentary from Anthropic staff. See ../README.md for full citations.

---

## 1. Prefer judgement over enumerated rules

Old-model instructions ("always write a test for X", "never touch Y
without asking") keep Fable-class models behaving like older, less capable
models. Replace enumerated rules with judgement calls plus the reasoning
behind them, and let the model apply that reasoning to cases you didn't
anticipate.

```text
Use your own judgement on when to write tests, when to refactor, and when
to ask before proceeding. When in doubt, favor the choice a careful senior
engineer on this team would make, and say why you made it.
```

## 2. Delegate mechanical work to cheaper models via subagents

Reserve the primary model for architecture, migration planning, complex
debugging, and final review. Hand implementation, boilerplate, and
mechanical edits to a cheaper/faster model running as a subagent.

```text
For implementation subtasks that don't require judgement calls, use your
judgement to decide an appropriate lower-power model and run it in a
subagent. Keep the harder judgement, review, and synthesis work for
yourself. Delegate independent subtasks to subagents and keep working
while they run; intervene only if a subagent goes off track or is missing
context.
```

## 3. Avoid overplanning / act once you have enough information

```text
When you have enough information to act, act. Do not re-derive facts
already established in the conversation, re-litigate a decision the user
has already made, or narrate options you will not pursue. If you are
weighing a choice, give a recommendation, not an exhaustive survey.
```

## 4. Ground progress claims in tool results

On long autonomous runs, models can drift into reporting progress that
isn't backed by evidence. Force an audit step.

```text
Before reporting progress, audit each claim against a tool result from
this session. Only report work you can point to evidence for; if
something is not yet verified, say so explicitly. Report outcomes
faithfully: if tests fail, say so with the output; if a step was skipped,
say that.
```

## 5. State the boundaries explicitly

```text
When the user is describing a problem, asking a question, or thinking out
loud rather than requesting a change, the deliverable is your assessment
— report findings and stop. Don't apply a fix until asked. Before running
a command that changes system state, check that the evidence actually
supports that specific action.
```

## 6. Build a persistent memory system

```text
Store one lesson per file with a one-line summary at the top. Record
corrections and confirmed approaches alike, including why they mattered.
Don't save what the repo or chat history already records. Update an
existing note rather than duplicating; delete notes that turn out to be
wrong.
```

## 7. Communicate for a reader who wasn't watching

For long/asynchronous runs, the final summary is often the user's first
look at the work. Keep working shorthand out of it.

```text
Your final summary is for a reader who didn't see any of your working
steps. Open with the outcome in one sentence, then supporting detail.
Spell out identifiers (files, flags, commits) in plain language. No
arrow-chains, no jargon you invented while working.
```

## 8. Don't let it stop short on long autonomous runs

```text
You are operating autonomously and cannot be asked questions mid-task.
For reversible actions that follow from the original request, proceed
without asking. Before ending your turn, check your last paragraph: if it
describes work you haven't done yet ("I'll...", "let me know when..."),
do that work now instead of ending the turn.
```

---

## What NOT to carry over from older-model prompting

- Don't enumerate every case where the model should stop and ask — a
  short principle (see #5) generalizes better than a checklist.
- Don't ask the model to echo/transcribe its internal reasoning into the
  visible response — on Fable 5 this can trigger a reasoning-extraction
  safety refusal. Use structured `thinking` blocks or a dedicated
  send-to-user tool instead if reasoning visibility is required.
- Don't show a live remaining-context countdown if you can avoid it —
  it can trigger premature "let's start a new session" suggestions.
