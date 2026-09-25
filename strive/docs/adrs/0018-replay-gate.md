# ADR-0018: The replay gate runs past tasks again in scratch copies

Status: accepted. Refines "Checks" in [ADR-0016](0016-trusted-learning.md)
for M10.

## Context

The static gate checks a proposal's text, and the judge (ADR-0017) asks a
model whether the lesson is sound. Neither measures whether the agent does
better with the change. ADR-0016's third check does: tasks from the
project's past work sessions whose outcome a machine can check are run
again, without and with the proposal, three times each.

What makes this hard:
- **A run is an agent turn:** tools, the sandbox, the gateway, a host. It
  must use the real ones, or it measures something else.
- **It must not touch the project** or strive's state, and it may reach the
  network only through the gateway.
- **It costs money:** a task times three runs times two sides, each an
  agent turn.
- **The learner must not reach it,** as with the judge.

## Decision

### Tasks: a command that went red to green

A task is mined from a work journal by a pure function
(`strive_learning::replay::mine`):
- **Shape:** a turn ran a command that exited non-zero, and later in the
  same session the same command (trimmed) exited 0. A test going red to
  green is the usual case.
- **The task:** the turn's prompts, the checkpoint journaled with the first
  of them (the files before the turn), and the command as the check.
- **One per turn:** its first such command. Commands over 300 characters
  are passed over. A command killed by its time limit has no exit and isn't
  a failure.
- **Which sessions:** the project's work sessions the proposal doesn't
  cite, begun before it, whose journals verify and whose checkpoints exist,
  newest first, as the judge holds sessions out. At most `replay.tasks`
  (3).

Other checkable outcomes (a session whose last test run passed, say) wait
until this one has shown what it's worth.

### Runs: the daemon drives sessions of their own

ADR-0016 said the tasks run "with `strive run`". They run through the same
machinery, driven by the daemon, as the judge's call is:
- **A session per run,** `kind: replay`, created by the daemon in a scratch
  directory: the real host, the gateway and the sandbox. Full-auto
  approvals, and no person attached: anything that would ask is refused.
  Its model is chosen before the prompt; its budget is what the cap has
  left.
- **Why not a `strive run` process:** it would create its session in the
  project, with the settings' model and budget, and list it with the user's
  work. The daemon would then have to trust its report of the check.
- **The scratch copy:** `$TMPDIR/strive-replay-*/work`, checked not to
  overlap the project. The checkpoint's tree is written there from the
  task session's shadow repository through an index of the replay's own.
  - The checkpoint's learned files are replaced by the ones the learner was
    shown (the learning session's latest `contextLoaded.learned`), on both
    sides. The runs with the change then write the proposal's file. So the
    two sides differ by exactly the proposal.
- **Paths:** the project's directory, wherever it appears as a whole path
  in the prompt or the check (and as `/tmp/...` for `/private/tmp/...`),
  becomes the scratch copy's (`strive_learning::replay::relocate`). Agents
  write `cd /the/project && sh check.sh`; run as written, the check would
  read the project's files, and pass or fail by them on both sides.
- **The prompt** is the task's; the daemon waits for its turn to end (the
  turn's time limit plus a minute), then stops the host.
- **The check** runs as an effect of the run's session (call id
  `replay-check`): gated, sandboxed, journaled. Passed means exit 0.
- **Order:** for each task, `runs` times (3): without, then with. Runs go
  one at a time, so each run's budget is what the earlier ones left, and a
  cap that runs out doesn't fall on one side.

### Isolation

- **Writes:** the agent's `write` and `edit` outside the scratch copy ask,
  and so are refused. Its commands run in the OS sandbox, which for a
  replay session allows writes only under its scratch directory: `work`,
  and `tmp` (the commands' `TMPDIR`), not the system's temp directories. So
  a project that itself lives under `/tmp` is out of reach too.
- **No sandbox, no replay:** where commands can't be sandboxed (or
  `"sandbox": "off"`), replay is skipped.
- **No MCP servers:** they run unsandboxed, in the session's directory.
- **The network:** the sandbox has none; model calls go through the
  gateway.
- **strive's state:** hidden from commands as always. The runs add only
  journals (and their blobs) under `~/.strive/sessions`.
- **Reads are not confined,** as for any session: a replayed agent could
  read the project's current files, and so see a later fix. Both sides can,
  so it blurs the difference rather than faking one.

### Money

- **A hold:** before any run, the daemon journals `ReplayStarted` in the
  learning session, holding `replay.budgetUsd` (default $1.00) in its
  ledger, if it fits. Otherwise the gate is skipped, with the numbers.
- **The runs** spend from the cap: each run's session budget is the cap
  minus what earlier runs spent. The gateway admits their calls as always.
- **`ReplayFinished`** records the runs' actual cost (read from their
  journals, calls left open charged in full) and each run's session, side
  and outcome. It releases the hold, in the same commit as the verdict.
- **A crash** leaves the hold charged in full: the runs' cost is unknown.
- **A refused call** (the cap ran out) stops the replay: the gate is
  skipped, saying after how many runs.
- **The model:** `replay.model`, else the cheaper of `model` and
  `judgeModel`. The tradeoff: a cheaper model makes eighteen runs
  affordable, but it measures the change on an agent other than the one the
  user runs. A lesson that a strong model doesn't need may help a weak one,
  and the reverse. Set `replay.model` to the agent's model to measure that
  one.

### The verdict

Counted over every run of every task:

| Situation | Replay verdict |
| --- | --- |
| With the change, runs passed at least as often as without | pass |
| With the change, they passed less often | fail |
| Every run failed on both sides | skipped: inconclusive |
| The static check or the judge failed | skipped, saying which |
| Replay is off (`budgetUsd` 0), no sandbox, no host, no key, no price | skipped, saying which |
| No task could be mined | skipped, saying so |
| The learning session can't hold the cap | skipped, with the numbers |
| The cap ran out, or a run couldn't be set up | skipped, saying why |

The detail's first line reads "with the change 3/3 passed, without 1/3;
1 task", then the model and cost, then one line per task.

### When it runs, and what a skip means

- **After the judge's verdict,** pass or skipped: with the proposal when
  the judge is skipped at once, otherwise when its verdict is journaled.
  Until the replay's verdict, the proposal is `checking`.
- **In the background,** off the project's lock, like the judge. A set of
  running replays keeps a list from starting a second; after a crash the
  next list or decision runs it again.
- **A skip doesn't block:** ready still means every check that ran passed
  or was skipped. Most projects have no sandbox-safe red-to-green history
  yet, or no key; blocking there would make learning unusable. The reason
  is in the detail, and a person decides.

## Consequences

- **The learner can't reach it:** tasks, runs and the verdict are the
  daemon's. The learner's only input is the proposal.
- **Every run is on record:** a replay session per run (`strive log`
  shows it; `strive verify --all` checks it), named in `ReplayFinished`.
  `session/list` leaves them out unless asked for `kind: replay`.
- **A replay takes a while:** eighteen agent turns at most. `strive learn`
  waits five minutes for checks, then lists a proposal still `checking`.
- **The copy is partial:** checkpoints skip ignored files and nested
  repositories, so a task whose check needs `node_modules` fails on both
  sides (inconclusive). The copy has no `.git`.
- **Deferred:** reusing the "without" runs across proposals, keyed by task
  and the digests of memory and skills (bb's replay-by-hash); recording
  whether a skill was read; other task shapes; running runs in parallel.
