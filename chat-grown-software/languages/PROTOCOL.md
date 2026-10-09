# Kernel protocol (v1)

Every language port is a **kernel process** that grows one app (the expense tracker) and speaks JSON lines on
stdin/stdout: one request per line in, exactly one response per line out, in order. Nothing else may be written to
stdout (log to stderr). The process is started as

    <lang>/run.sh <data-dir>

and must resume from `<data-dir>` if it already holds a world (persistence is the "image"). An empty or missing
`<data-dir>` starts an empty world: no functions, state `{}`, generation 0, no revision.

The driver (`bench/`, TypeScript) owns everything language-neutral: the scenario, the questions put to the user,
the simulated user, the model. The kernel owns everything that needs the language: loading code, running it,
the verification gates, revisions, persistence.

## Values

- **State** is a JSON object, for this scenario
  `{"expenses": [{"amount": 12.5, "category": "food", "note": "..."}], "budgets": {"food": 15}}`; either key may be
  absent, `note` is optional. Kernels hold it natively (maps, dictionaries, structures) and convert at the boundary.
- **Arguments and return values** are JSON: numbers, strings, booleans, null, arrays, objects. "No value" is `null`.
  A function that returns nothing returns `null`.
- **A call** is `{"fn": "add_expense", "args": [12.5, "food"]}`. Function names are snake_case as given. Calls never
  contain code; the kernel maps them onto its functions (e.g. `addExpense`, `add-expense`, `App.add_expense/3`,
  a Pharo selector) however it likes, but the user-visible names in `observe` are the snake_case names.

## Outcomes

Running a list of calls on a fixture state gives an **outcome**:

    {"value": <return value of the LAST call>, "state": <state after all calls>}
    {"throws": true, "error": "<message>", "state": <state just BEFORE the throwing call>}
    {"timeout": true}

Each call is a transaction: if it throws, its partial changes are discarded and later calls are not run. A call
that runs over 1 second times out. Two outcomes are equal when they are deep-equal JSON, except that object key
order is ignored, numbers are equal within 1e-9, and `error` messages are not compared.

## Requests

### observe
    {"op": "observe"}
    -> {"generation": 3, "revision": "rev-0003" | null, "functions": {"total": "<source>", ...}, "state": {...}}

`functions` lists every public app function by its snake_case name with its current source text (helpers may be
listed under their own names).

### try (preview a candidate, change nothing)
    {"op": "try", "forms": ["<source>", ...], "removes": ["name"], "questions": [{"fixture": {...}, "calls": [call, ...]}, ...]}
    -> {"ok": true, "outcomes": [outcome, ...]}           one per question, run on the CANDIDATE (live code + forms)
    -> {"ok": false, "error": "<why the forms don't load>"}

The live world is unchanged afterwards. The driver uses `try` to show the user what a proposed change actually
does before anything counts.

### develop
    {"op": "develop", "generation": 3, "intent": "budgets", "scope": ["set_budget", "over_budget"],
     "forms": ["<source>", ...], "removes": [],
     "examples": [{"fixture": {...}, "calls": [...], "expect": outcome}, ...],
     "laws": [{"name": "...", "check": "<source>"}],
     "asked": {"message": 12, "text": "Let me set a monthly budget ..."}}
    -> {"status": "accepted" | "rejected" | "stale", "revision": "rev-0004", "generation": 4,
        "failed": [{"layer": "ratchet", "detail": "..."}]}

`examples` are this turn's user-confirmed examples (expectations come only from the user, never the model).
`laws` are optional, language-specific property checks (source in the kernel's language, evaluated against
generated states; a kernel may ignore them and say so in its README). If `generation` is not the current
generation, answer `stale` and change nothing. Otherwise build the candidate and run the **gates**; accept only if
all pass:

1. **static**: every form loads, and every form is exactly one function definition of the kernel's allowed shape
   (no top-level side effects, no redefinition of builtins, no I/O). Calls to functions that don't exist fail here
   when the language can tell.
2. **ratchet**: every example confirmed in any earlier accepted develop, plus this request's examples, gives its
   expected outcome on the candidate. (An earlier example whose functions are all in this request's `scope` and
   that this request's own examples contradict is superseded: drop it from the ratchet.)
3. **invariants**: the three scenario invariants (see `scenario/expenses.json`) hold on the live state, on every
   example's resulting state, and on the state after replaying each trace. The kernel implements them natively.
4. **traces**: every recorded `execute` is replayed on the candidate from its recorded before-state. A trace that
   ran without error before must still run without error/timeout, and its value may only change if the called
   function is in `scope`.
5. **language layer** (optional, your choice, name it): whatever the language gives for free that the others
   can't: proofs, sandboxed resource limits, structural checks on code-as-data, hot-upgrade with migration...

On accept: install the forms live (late-bound: existing callers see the new definition), record a revision
`{id, code_id, data_id, intent, scope, asked}`, increment `generation`, persist. Examples join the contract.

### execute (real use)
    {"op": "execute", "call": call, "request_id": "r-17"}
    -> {"ok": true, "value": ..., "replayed": false}
    -> {"ok": false, "error": "..."}

Runs on the live world and commits the new state (one transaction). Records a trace `{before, call, value}`.
**Exactly once**: a repeated `request_id` returns the recorded result with `"replayed": true` and runs nothing.

### rollback (code only)
    {"op": "rollback", "revision": "rev-0002"}       (omit revision = the one before the current)
    -> {"ok": true, "revision": "rev-0002", "generation": 5}
    -> {"ok": false, "error": "..."}

Restores that revision's code and keeps today's data. Refuse (ok false) if the old code breaks an invariant on
today's data or fails a trace replay. A successful rollback is itself a new generation.

### why
    {"op": "why", "fn": "over_budget"}
    -> {"revision": "rev-0004", "intent": "budgets", "asked": {"message": 12, "text": "..."}} | null

The revision that last changed this function, and the chat message that asked for it.

### Errors
Any malformed request: `{"error": "<message>"}`. Never crash on bad input; never exit until stdin closes.

## What each port ships (in `<lang>/`)

- `run.sh` (executable): starts the kernel on `<data-dir>`. Must start in well under 10 s once dependencies are
  installed (warm caches are fine; a compile step may live in `setup.sh`).
- `setup.sh`: anything that must run once (fetch deps, compile). Idempotent.
- `reference.json`: the scripted model in your language,
  `{"turns": [{"intent": "...", "scope": [...], "forms": ["..."], "removes": [], "laws": [...]}, ...]}`, one entry
  per scenario turn. These are the forms a correct model would write. It also carries `"probes"`, bad changes the
  conformance check expects every gate to refuse after the last turn, each `{"scope": [...], "forms": [...]}`:
  - `side_effect`: a form that is not a pure function definition (a top-level statement, or a definition that
    also rebinds/patches something global, the JS `Array.prototype.every = () => true` trick in your language);
  - `breaks_ratchet`: `total` redefined to return 0;
  - `breaks_invariant`: `add_expense` redefined to store the amount negated (it still returns the count);
  - `loops`: `total` redefined as an infinite loop;
  - `calls_missing`: `total` redefined to call a function that does not exist;
  - `breaks_trace`: `top_category` redefined to throw (it is NOT in this probe's scope: declare scope `["total"]`).
- `prompt.md`: what a model must know to write forms for your kernel: the allowed form shape, how state is read and
  changed, how to throw, how JSON values map to native values, one short example. It is appended to the
  driver's system prompt for model runs, so keep it under ~60 lines and exact.
- `showcase/`: one demo of the language-specific feature, as a script plus its recorded output.
- `NOTES.md`: what you tried and learned, terse.
- No build output, no vendored dependencies, nothing over 2 MB.

The conformance check is `node --experimental-strip-types --no-warnings bench/conformance.ts <lang>`.
