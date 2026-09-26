# ADR-0020: Learning triggers, a cheap pre-filter, and the `learning` setting

Status: accepted. Refines "Triggers" in [ADR-0016](0016-trusted-learning.md).

## Context

The learner runs only when a person asks (`strive learn`, or the desktop's
button). ADR-0016 plans triggers (end of session, every N turns, idle
consolidation) behind a `learning` setting: `off`, `suggest` by default,
`gated`, `auto`. bb's suggestion 3 ("what bb suggests" in NOTES) is to put
cheap triggers before paid ones: a deterministic scan for corrections,
interrupts, declined approvals and failed-then-fixed commands, with a
daily cap.

What makes this hard:
- **A run costs money** and a key. A trigger that fires on every session
  spends the learning session's budget on sessions with nothing to learn.
- **Nobody is watching.** Whatever the daemon does on its own has to be on
  record and shown, or a person can't tell learning from drift.
- **Accepting without a person** is the step ADR-0016 kept for people. Doing
  it at all needs a rule that can't be satisfied by default: a check that
  was skipped (no key, no held-out session, no minable task) says nothing
  about the proposal.
- **A project's own files** are writable by anyone who commits to it, and
  by a work session's commands (the sandbox guards `.strive/memory.md` and
  `.strive/skills`, not the rest of `.strive`).

## Decision

### The `learning` setting

In `~/.strive/settings.json`:

```json
"learning": {"mode": "suggest", "idleSeconds": 600, "everyTurns": 0, "dailyRuns": 3}
```

| Mode | Automatic runs | Accepting |
| --- | --- | --- |
| `off` | none | a person |
| `suggest` (default) | when a trigger's scan finds a sign | a person |
| `gated` | as `suggest` | a proposal whose every check **passed** is accepted by the daemon; otherwise a person |

- **Manual runs work in every mode,** `off` included. `strive learn` is a
  person's explicit request; `off` is about what the daemon does on its own.
- **`gated` applies to every proposal,** from an automatic run or a manual
  one: the mode says who decides, not who asked.
- **`auto` is refused on load,** with a message naming `gated`. ADR-0016
  meant it for a tier above `gated`, for artifacts riskier than others.
  strive learns two kinds today, memory and skills, and both are text loaded
  into every later session's prompt, reviewed the same way. There is nothing
  to tier, so `auto` would be an alias of `gated`. An alias would silently
  change meaning when a riskier kind (a hook, a verification command) comes;
  refusing it keeps that a decision someone makes then.
- **A project can only lower it.** `.strive/settings.json` in a project may
  hold `{"learning": {"mode": ...}}` and nothing else; the mode in effect is
  the lower of the two (`off` < `suggest` < `gated`). It can't raise it:
  anyone who commits to the repository, or a work session's command, can
  write that file, and neither may turn on accepting without a person. A
  project file that can't be read (malformed, a symlink, an unknown field)
  turns automatic learning off for that project, and the daemon logs why.
  A project at `~` has strive's home as its `.strive`, so there the user's
  file is the only one.
- **Settings load when the daemon starts,** as every setting does.
  `strive stop` makes the next command start one that reads the change. The
  project's file is read each time it's needed.

### The pre-filter: signs in a work journal, no model

`strive_learning::signals::scan` reads one work session's verified journal
and returns its signs, each anchored at the entry that completes it:

| Sign | Found when | Anchored at |
| --- | --- | --- |
| `correction` | the first prompt after a turn ended opens with a word like "no", "actually", "wait", "don't", or holds a phrase like "I said", "you didn't", "why did you", in its first 200 characters | the prompt |
| `interrupted` | a turn ended `interrupted` | the turn's end |
| `declined` | a person answered an approval `deny` | the decision |
| `failedThenPassed` | a turn's first command that failed, and the same command's later run with exit 0 (the replay gate's mining, [ADR-0018](0018-replay-gate.md), without its checkpoint requirement) | the passing run |
| `turnFailed` | a turn ended `failed` or `timedOut` | the turn's end |

- **Bounded:** one pass over the journal plus the replay miner's; prompts
  are read to 200 characters; at most 20 signs a scan, each with a
  one-line excerpt of at most 120 characters.
- **Crude on purpose.** The phrases are a fixed English list, and "no
  problem" is excluded by hand. A false alarm costs one run under the daily
  cap, and the learner decides whether there's a lesson. A missed
  correction costs nothing a person can't recover with `strive learn`.
- **Signs already acted on aren't found again.** Anchoring means a scan of
  the same session later finds the same signs plus new ones with higher
  seqs. The learning journal's automatic requests name their signs, so the
  next scan asks only for signs past the highest one acted on for that
  session. A skipped run acts on nothing: its signs are found again the next
  time the session goes idle.
- **A session with no sign triggers nothing** and journals nothing, and the
  learning session isn't created for it.

### When a scan runs

- **Idle:** when a work session's host journals `turnEnded`, the daemon
  waits `idleSeconds` (600 by default). If no prompt was journaled in that
  session since, it scans it. Each turn's end starts its own wait; a wait
  that finds a later prompt ends there. Chosen over "the last client
  detached": a person often keeps the TUI or desktop open on a session they
  have finished with, and `strive run` detaches after every turn. The
  default is under the daemon's idle exit (900s), so a `strive run` that
  exits still gets its scan.
- **Every N turns** (`everyTurns`, 0 by default: off): a session's
  `turnEnded` that makes its count of ended turns a multiple of N scans it
  at once, without waiting. Its idle scan still runs later and finds only
  newer signs.
- **Deferred:** idle-time consolidation across many sessions (a run that
  studies a week of sessions at a quiet moment), and catching up after a
  restart: a daemon that exits before a wait ends drops that scan.

### Limits, checked under the project's lock

A scan that found signs asks for a run only if all of these hold. If one
doesn't, the daemon journals `learnSkipped {trigger, reason}` in the
learning session instead:
1. **Nothing is going:** no request that no turn has finished, and no
   proposal still `checking`. A request whose host can't start stays
   unfinished, so automatic runs wait behind it as a person's `strive
   learn` would.
2. **The daily cap:** fewer than `dailyRuns` (3) automatic requests in the
   project's learning journal in the last 24 hours. Rolling, not by calendar
   day, so it needs no time zone. Manual runs don't count.
3. **A key** for the learner's model's provider.
4. **A price** for the learner's model.
5. **The budget:** the learning session's ledger can admit the most one
   learner call can reserve (the model's whole context window in, the
   agent's output cap out). A run that can't make that call would only
   fail. Beyond that, a run spends the learning session's budget as any run
   does; the judge and replay are held and charged as ADR-0017/0018 say.

A skip is journaled each time a session's scan finds signs and a limit
stops it, so the reasons stay in the record; the newest shows in `strive
review` and the Learned pane until an automatic run starts.

### What an automatic run records

`learnRequested` gains `trigger: {kind: idle | turns, signals: [{session,
seq, kind, detail}]}` and names the scanned session in `sessions`, so the
learner reads it first. A person's request has no trigger. Only the daemon
writes either entry: hosts can't record `learnRequested`, and `learning/run`
takes no trigger. The learner's prompt lists the signs, so it starts where
the scan pointed.

A proposal is attributed to the run whose request came last before it
(`ProposalState.trigger`).

### `gated`: accepting without a person

- **The rule:** a proposal is accepted by the daemon only if the mode in
  effect for its project is `gated`, it is `ready`, and **every gate
  (static, judge, replay) has a `pass` verdict.** `strive_learning::
  every_check_passed` decides it. A `skipped` verdict isn't a pass: a
  judge skipped for no key or no held-out session, or a replay skipped for
  no sandbox, no task, no budget, or an inconclusive result, leaves the
  proposal for a person, as a failure does (and a failure blocks it for
  everyone).
- **Why a judge that failed or was skipped can never be auto-accepted:**
  static and replay measure text and outcomes; only the judge asks whether
  the lesson is sound and safe (its `safe` criterion covers paraphrased
  weakening the static lists miss). Its pass comes only from a strictly
  parsed `record_verdict` with every criterion passing; a provider error or
  an unreadable answer is a fail (ADR-0017). So an outage, a missing key or
  a malformed answer can't open the gate.
- **When:** only at the moment the replay journals a `pass`, the last
  verdict of the cascade, under the project's lock. A crash between that
  verdict and the accept leaves the proposal `ready` for a person; the
  daemon doesn't accept it later on a list or restart. So a proposal made
  under `suggest` is never accepted because the mode became `gated` after.
- **What it writes:** the same apply as a person's accept (the file must
  still be as the learner saw it, a pinned write, `proposalApplied`), with
  `proposalDecided {by: "gate", automatic: "gate"}`. The `automatic` field
  is what distinguishes it: the daemon sets it only here, and a person's
  decision never carries it, whatever the client calls itself. If the file
  changed since the learner read it, the gate records nothing and leaves the
  proposal for a person (who gets `stale`, as before).
- **Rollback is unchanged:** `proposal/rollback` is a person's request and
  undoes a gate's accept as it undoes a person's. Predictions (ADR-0019)
  keep watching it, and a proposal that stops holding suggests its rollback.

### Surfaces

- **`strive review`** marks a proposal from an automatic run `[automatic
  run]` and one the gate accepted `[accepted automatically]`. Its detail
  says `run  automatic, after a session went idle: a correction in session
  …`, one line per sign, or `run  asked for by a person`, and `decided
  accepted automatically: every check passed`. Below the list: the latest
  skipped run and its reason.
- **`strive log`** describes the entries: "automatic learning run, after a
  session went idle: …", "automatic learning run skipped (…): …",
  "proposal #N accepted automatically: every check passed".
- **The desktop's Learned pane** shows an "Automatic" badge and the signs
  on a proposal from an automatic run, "Accepted automatically: every check
  passed" on one the gate accepted (with Roll back as for any applied
  proposal), and the latest skipped run's reason as a notice.

## Consequences

- **Learning happens without asking,** within a daily cap and the learning
  session's budget, and only for sessions with a sign. Every run and every
  skip is in the learning journal, which `strive verify --all` checks.
- **`suggest` changes nothing about who decides.** It turns on spending, not
  accepting: the default costs up to three learner runs (plus their checks)
  a day per active project with a key.
- **`gated` lets a file into every later prompt that no person read.** The
  bar is every check passing, and in practice the replay's pass is rare (it
  needs a sandbox, a red-to-green history and a key), so most proposals
  still reach a person. The accept is marked, shown and undoable.
- **The phrase list is English** and will miss corrections phrased
  otherwise. Interrupts, declines and failures are language-free.
- **Deferred:** consolidation across sessions at idle time; catching up
  scans a restart dropped; ending a session explicitly as a trigger; risk
  tiers (and so `auto`) once an artifact kind riskier than memory and skills
  exists; telling the learner which proposals the gate accepted.
