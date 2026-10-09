# Pharo Smalltalk port of the live kernel

Pharo 12 headless VM, one long-running image per world. `./setup.sh` once, then `./run.sh <data-dir>` speaks the JSON-lines
protocol of `../PROTOCOL.md`. Result: `node --experimental-strip-types --no-warnings bench/conformance.ts smalltalk` ->
**51/51 checks pass; develop avg 24 ms; start 133 ms** (restart 115 ms; the `loops` probe costs its 1 s limit).

## The language layer: Smalltalk is the live image
App functions are **methods compiled into a live class** `ExpenseApp` (protocol `app`); state is the instance variable
`state` of the one live instance (a Dictionary). Nothing is "loaded" when a change is accepted: the kernel compiles the
method into the class, and every existing caller (`over_budget` -> `self by_category`) reaches the new method on its next send.

**Selector convention.** The function name is the first keyword of the selector; a call is dispatched on (name, argument
count). `total()` -> `total`; `set_budget(c, a)` -> `set_budget: c amount: a`; `add_expense(a, c)` -> `add_expense: a category: c`.
The remaining keywords are free, which is what a model naturally writes. An optional argument is a second method of another arity.

**Static gate (the Pharo parser as a policy engine).** A form must parse with `RBParser parseMethod:` (so it is exactly one
instance-side method; `Class >> sel` headers are tolerated, class-side ones refused), have no pragmas, a snake_case first
keyword that Object does not already understand (no redefining kernel methods), and an AST in which every variable is a
local/instance/self or an **allowlisted global** and no message is on the forbidden list (`perform:`, `compile:`, `evaluate:`,
`instVarAt:put:`, `become:`, `fork`, `subclass:`...). `Smalltalk at: #X put: 1`, `thisContext`, `FileSystem` are refused.
After the candidate is compiled, every `self` send is checked against it: unknown selector = a missing function, caught
before anything runs.

**Candidates.** `ExpenseCandidate` is a scratch class rebuilt from the live code map + forms - removes, so `try` and all gates run
on a candidate while `ExpenseApp` stays untouched. Calls run in a forked process under a 1 s watchdog that terminates it;
`[true] whileTrue` and infinite recursion cannot hang the VM. Every call is a transaction (state snapshot, restored on error).

**Gates:** static, ratchet (all confirmed examples, with superseding by scope), invariants (live state, example states,
trace replays), traces (replay of every recorded execute), sandbox (timeouts). `laws` are accepted and ignored.

**Persistence = the image, with a write-ahead file.** `<data-dir>/world.image` is a copy of the kernel image that is saved
(`Smalltalk snapshot:andQuit:`) at clean shutdown: 55 MB, 256 ms. `<data-dir>/world.json` holds the revisions (each with its
full code map), state, examples, traces and request results, written atomically after every change (1.7 ms), so a crash loses
only the snapshot. Chosen because a per-change image save would cost ~250 ms per `execute` for no extra durability; resume
reconciles the image's methods with world.json and skips recompiling methods whose source is unchanged.

**Change log, `why`, rollback.** Pharo logs every compile twice: Epicea (in-image, queried by the extra op `changes`) and the
`.changes` file (source of every method ever compiled). `why` maps function -> revision -> chat message (kernel metadata:
Epicea knows what changed, the revision knows why). Rollback recompiles an earlier revision's methods into the same class,
keeps the data, and is refused if the old code breaks an invariant or a recorded trace.

## Showcase (`showcase/`, transcript in `showcase/transcript.txt`; regenerate with `showcase/demo.sh`)
Part 1 (protocol): `over_budget` calls `by_category`. Recompiling only `by_category` (round to cents) flips the answer of the
untouched `over_budget` for 0.1 + 0.2 vs a 0.3 budget, immediately; `why`, the Epicea log, and a rollback that flips it back.
Part 2 (inside the saved world image): the code is already in `world.image`; **the shape of the state holder changes**:
`ExpenseBase addInstVarNamed: 'lastCount'` migrates the live instance in place (same object, state intact, new slot nil), a form
that uses the variable is refused before and accepted after, executed on the existing instance; an Epicea revert; the
`.changes` tail.

## Problems / caveats
- Strings sort with Pharo's `<` (not code-unit order); fine for the scenario's lowercase categories.
- Rollback to the previous revision is refused after turn 8 because the recorded 3-argument trace cannot replay (allowed by the harness comment).
- An owner-level change made outside the kernel (the Epicea revert in the showcase) makes the image drift from world.json; the next start reconciles to world.json.
- Epicea timestamps are nil in headless mode, so `changes` has no times.
- No protocol problems found in PROTOCOL.md/bench.

## Files
`setup.sh`, `run.sh`, `build.st`, `src/ChatKernel/*.st` (Tonel), `reference.json` (8 turns, 6 probes), `prompt.md`, `showcase/`, `NOTES.md`.

## Gateway scenario
`SCENARIO=gateway ./run.sh <dir>` enforces the gateway's five invariants (default stays expenses); `reference-gateway.json` holds its
5 turns. Extra ops: `inspect` (read-only views of the live object), `rollback` with `fn` (one method). Showcase:
`showcase/gateway-transcript.txt` (live image as an operations console: traffic, hot-fix, history, one-method rollback, image restart).
