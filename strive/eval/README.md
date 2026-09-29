# strive's learning eval

The task suite and runner for ADR-0021: does strive with learning on do
better, over a sequence of related tasks, than the same strive with
learning frozen?

- `project/`: the synthetic project, `tally`, a small Python invoicing
  library (standard library only, Python 3.11+). Each task starts from a
  fresh copy of it.
- `tasks/<family>/<instance>/`: 75 tasks, written by `build_tasks.py`.
  Don't edit them by hand: change `build_tasks.py` and run it.
- `checklib.py`: what every check uses.
- `oracle-memory.md`: a person-written memory stating each rule (the O
  arm). `placebo-memory.md` is the same length, about an unrelated Go
  service (the placebo arm).
- `../scripts/eval/`: the runner (`run_eval.py`), its statistics
  (`stats.py`), the shared parts (`evallib.py`), the self-check
  (`selfcheck.py`), its unit tests (`test_evallib.py`) and the scripted
  model for the plumbing test (`fake_model.ts`).

## Families

Nine learnable rules, one per family. Seven are team conventions that
nothing in the repository states. No test, lint, error message, README
line or tool output shows them, and only the seed request says them, the
way a teammate corrects someone:

| family | the rule | why the frozen arm misses it |
|---|---|---|
| regression-test | a ticket fix adds `tests/regressions/test_tal_<n>.py`, which fails without the fix | no `tests/regressions/` exists; test requests just name the ticket |
| currency-coverage | tests of Money-returning code include a JPY case | the check's mutant rounds to two decimals: identical on EUR, wrong on JPY |
| deprecate-alias | a renamed public function keeps its old name, warning with `DeprecationWarning` | "rename X to Y" reads as rename; nothing deprecated exists |
| codeowners | a new module gets its line in `.github/CODEOWNERS` | the file only lists owners; no test or tool reads it |
| api-version | a change to the API's keys bumps `API_VERSION`'s minor, 1.4 to 1.5 | it sits unread in `tally_api/__init__.py`; the serializers don't use it |
| versionadded | a new public function's docstring ends with `.. versionadded:: 0.10` | no docstring has one; 0.10 appears nowhere |
| audit-event | a change to an invoice or payment calls `tally.audit.record("<noun>.<verb>", invoice=...)` | `tally/audit.py` exists, but no code calls it |

Two are quirks the repository does show, kept from the first suite
because the frozen arm still missed them: changelog (each change to
tally/ adds `changes/<slug>.<kind>.md`, checked by `./dev changes`) and
lockfile (dependency changes rerun `./dev lock`).

Also two generic families with no quirk (`generic-logic`,
`generic-parsing`): learning should do nothing there, so a drop measures
harm. And one conflicting family (`conflicting-keys`): `tally/export.py`
wants snake_case keys and `tally_api/` camelCase, so a lesson from one
package applied to the other shows up as cross-application.

Each family has one seed instance, three test instances and two
calibration instances. Test and calibration instances use different
files, identifiers and wording. Seed requests state the rule. Test
requests are plain and give no hint of it. Three families
(regression-test, changelog, api-version) also have a `seed-poison`
instance for the P arm: the request asserts a false convention ("no
regression test: QA keeps those", "no changelog fragments", "leave
API_VERSION alone"). Its check passes anyway, so the session looks like a
success for the wrong reason.

### Why seven families were rebuilt

The first screen (Haiku 4.5, 2026-09-29) kept only changelog and lockfile:
F 0%, O 100%. Seven families had F 100% and O 100%. The agent learned each
of those quirks from what the repository said: a doctest failing under
`./dev test`, a skip message pointing at the fixtures README, "stale: run
./dev gen", the `==` TypeError naming tests/README.md, test_banned.py
naming `tally.clock`, test_errors.py, and `./dev lint`. Those tests and
tools are still in the template, so the project stays realistic, but no
family is scored on them. The rebuilt families are scored on rules the
repository never states. Each keeps 1 seed, 3 test and 2 calibration
instances.

`build_tasks.py` lists, per rebuilt family, the terms that would state
its rule (`HIDDEN`). `selfcheck.py` checks that no set-up workspace
contains them outside the files named as allowed. Every instance of a
rebuilt family also has a `violation/`: a fix that does the task and
ignores the rule. It must fail, and only on the checks named `rule: ...`,
which shows the check tests the rule.

## A task

- `instruction.md`: what the person asks.
- `setup/`: files laid over the template.
- `oracle/` plus `oracle_run` in `task.json`: the solution.
- `check.py`: the verifier. It copies the finished workspace, puts back
  the project's own harness (`./dev`, `tools/` and, unless the task is to
  write tests, `tests/`), then runs the project's tests and the task's own
  assertions. Exit 0 is a pass. The last line is JSON with failures and
  signals, such as whether the lesson was followed or a key style was
  cross-applied.
- `check-data/` (currency-coverage): a mutant the agent's tests must catch.
- `violation/` (every instance of a rebuilt family, and one instance of
  changelog, lockfile and conflicting-keys): a fix that does the task but
  ignores the rule. The check must fail it.

Each check enforces only its own family's rule, so a rule learned in one
family never makes another family's task fail.

## Keeping the checks from the agent

- The workspace is a git repo whose one commit is the set-up task. It lives
  under `/tmp`, outside the checkout, and holds nothing of the checks.
- Each sequence runs its checks from a copy of `eval/` inside its
  `STRIVE_HOME`. strive's sandbox denies the agent all of strive's home.
- For the length of a run, the checkout's `eval/tasks`, `checklib.py`,
  `build_tasks.py`, `oracle-memory.md` and this README are made
  unreadable (mode 000). The agent's sandbox can't change permissions
  outside its workspace. The runner restores them when it ends, and at its
  next start if it was killed. `--no-lock` skips this.
- Any agent command or file path that names the checkout, the vault or
  these files counts as peeking. The trial fails and the record lists the
  commands.

`selfcheck.py --e2e` checks this with a real strive session. The agent
runs `cat` on its own README, on a check in the vault and on a check in
the checkout. The first read works, the vault read fails with "Operation
not permitted" (Seatbelt), the checkout read fails with "Permission
denied", and the runner flags the command.

## Running it

```sh
cargo build -p strived                        # the runner prefers this checkout's build
python3 scripts/eval/selfcheck.py             # every oracle passes, every unfixed task fails: ~30 s
python3 scripts/eval/selfcheck.py --e2e       # also the runner against a scripted model: ~5 min
python3 scripts/eval/run_eval.py --dry-run    # the plan and its cost; spends nothing
```

`scripts/check.sh` runs the fast parts: `build_tasks.py --check` and
`test_evallib.py`, which take a few seconds.

A paid run, after reading the dry run's estimate:

```sh
export ANTHROPIC_API_KEY=...                  # the run's fresh STRIVE_HOME has no stored key
python3 scripts/eval/run_eval.py --screen --yes --out eval-runs/screen
python3 scripts/eval/run_eval.py --dry-run --families-from eval-runs/screen/screen.json \
    --calibration eval-runs/screen/results.jsonl
python3 scripts/eval/run_eval.py --families-from eval-runs/screen/screen.json --yes --out eval-runs/full
```

- The screen runs the calibration instances under F and O and keeps a
  learnable family only if F passes at most 50% and O at least 70%.
  Generic and conflicting families are always kept. With one repetition
  that means O passes both instances and F at most one; `--screen-reps 2`
  halves the noise and doubles the screen's cost. `screen.md` also gives
  each family's mean turns and cost per task under F and O, with the
  counts, and a Wilcoxon test on O against F for both over the paired
  calibration tasks.
- The full run's `summary.md` reports turns and cost as outcomes: L/F
  ratios with a Wilcoxon signed-rank test on paired learnable test
  instances (H5 for turns, H7 for cost; H7 counts the agent's cost, and
  the learner's cost per task is reported beside it), and a per-family
  table of passes, mean turns and mean cost for every arm, with counts.
- `--calibration` bases the next estimate on the screen's measured cost per
  task, not on the assumed token counts.
- Output goes to `--out` (default `eval-runs/<time>`, which git ignores):
  `results.jsonl` (the run, each planned trial, each finished trial),
  `summary.md` and `summary.json` (or `screen.md` and `screen.json`),
  `journals/` (each session's journal as `strive run --json` printed it,
  the learner's entries, and each learning session), and `strive/` (each
  L and P task's `.strive/` after learning).
- `--summarize OUT/results.jsonl` rewrites the summary.

What a trial records: pass or fail from the check; turns (the agent's
replies); model calls; cost and tokens from the journal; whether memory was
loaded (the memory file in `contextLoaded`); whether the lesson was followed
(from the check's artifacts, else the family's command appearing in a bash
call); leaked strings (a test instance's unique strings already in
`.strive/` before it ran); peeking; and, for L and P, each proposal with its
static verdict, the judge's advice and whether accepting it applied.

The runner doesn't read the proposal's format. It lists proposals, accepts
those whose status is `ready`, and reads the files in `.strive/`. When
memory proposals become per-bullet (ADR-0022), only `fake_model.ts`, the
scripted learner, needs to change.

## Before the first paid run

1. Build strive from this checkout: `cargo build --release -p strived`, and
   make the host available. Either install `strive-tui` next to the binary
   (`./install.sh`) or set `STRIVE_HOST="bun $PWD/packages/host/src/main.ts"`.
2. Run `selfcheck.py --e2e`. It should end with `selfcheck: all passed`.
3. Set `ANTHROPIC_API_KEY`. The dry run's estimate uses assumed token
   counts; read them.
4. Run the screen and read `screen.md`. The first screen cost $2.20 for
   48 tasks ($0.046 a task); `--dry-run --screen --calibration` on its
   `results.jsonl` estimates a rescreen at $2.20 to $2.74. If too few learnable families survive, the run can't
   answer the question. Fix the families before spending the rest.
5. Re-run the dry run with `--calibration` on the screen's results.
   ADR-0021 says to drop the placebo arm if a task costs more than $0.07
   (`--arms F,L,O,P`).
6. The full run: `--max-usd` (default 60) stops it past a total.

## Things a run depends on

- **The learner's host keeps the learned files it started with.** A
  learning session's host gets `learnedFiles` once, when it starts. In one
  long daemon, every memory proposal after the first accepted one is built
  on a stale file and goes `stale` on accept. `--keep-learner-host`
  reproduces it with the scripted model: 1 of 5 proposals applies,
  against 5 of 5 by default. The runner restarts the daemon before each
  learner run so the learner sees current memory. strive should give the
  host fresh learned files per learning request. ADR-0022's add
  operations, which don't depend on the file's other text, would also
  avoid it.
- **Budgets reserve a call's maximum output.** On Haiku 4.5 one call
  reserves about $0.087, so a per-task budget below that fails the first
  call, and a task stops once less than that remains. The default per-task
  budget of $0.40 allows about $0.31 of spend. Each sequence's learning
  session has its own budget (`--learner-budget`, default $4), which
  covers its learner and judge runs.
- A trial whose model is never reached (a bad key, a budget below one
  call) fails the run, as does a model other than the pinned one. The
  pinned model is checked in each `modelCallStarted` and in the `model`
  field of each recorded response.
