# Notes: software you grow by talking to it, and how to verify it

Working log. The question comes from Geoffrey Huntley: "Why is software built the way it is now, rather than grown
through iterative use of LLMs? What if you could develop your application just by chatting with it? Live and
interactive, with no compilation steps." The ask: don't require Lisp, but work out the verification piece.

## Sources

- The post "an application in lisp you grow by talking to it" (ghuntley.com/lisp) is blocked by this environment's
  egress proxy, and so are web.archive.org and the gist raw host. I recovered the content from:
  - [ghuntley/jiti](https://github.com/ghuntley/jiti): the implementation the post describes. I read the README,
    all 14 ADRs and the expense-tracker example (cloned through git, which the proxy allows).
  - [gist b8e28634](https://gist.github.com/ghuntley/b8e28634090c51895d7972ff6a7c5619): "JITI: a CS50-style tour of a
    repairable Lisp kernel", with diagrams of the loop, generations, restarts, goals vs. safety and recovery.
  - Search snippets of the post itself: "you ask for a capability, the model writes Lisp, and the application
    permanently acquires that capability until you ask for that capability to be removed."
  - [ghuntley/autolith](https://github.com/ghuntley/autolith) (skimmed): a self-modifying Lisp terminal agent with image
    generations and a recovery image.

## What Jiti does (the parts that matter for verification)

- **A live world.** One persistent SBCL worker thread owns evaluation. A controller exchanges actions and observations
  with it through mailboxes. The model never edits memory; it proposes one validated action at a time.
- **Two intents, one evaluator.** `develop_form` adds, redefines or removes functions; `execute_form` uses them;
  `preview` runs and then restores.
- **Checkpoint per attempt.** A checkpoint is taken before reading, compiling or evaluating. Accepted means a revision
  is published; anything else restores the checkpoint.
- **Generations** reject stale proposals: an action tagged with an old observation's generation is refused.
- **Goals vs. safety invariants** (ADR 0004). Both are caller-owned executable checks. Failed invariants reject the
  attempt; unmet goals allow safe intermediate progress. "Model-generated implementation or a completion message
  cannot replace the acceptance contract." Autonomous evolution requires executable goals (ADR 0008).
- **Live repair.** When a call errors, the worker pauses with the condition's restarts live. The model can redefine
  the function and invoke a restart inside the same dynamic extent. The outer call and its repairs share one
  checkpoint (ADR 0002).
- **Durable revisions.** These are immutable revision artifacts plus an atomic `CURRENT` pointer. Recovery imports
  accepted state and never replays unfinished operations. Rollback publishes an old state as a new revision, so
  history is never rewritten (ADR 0003 and 0007).
- **Testing the kernel itself.** It uses stateful property testing with check-it and FiveAM against an independent
  model of the world, with minimized replayable counterexamples (ADR 0005). The README's own caveat: "Passing
  generated cases is evidence, not proof."
- **Stated boundaries.** The kernel assumes cooperative code. Crash, hang and hostile-code isolation need a process
  boundary. Active frames and inline sites can keep old definitions.
- Jiti's example app is also an expense tracker, with integer cents, a fixture-based goal, and a
  `valid-expense-ledger` invariant. Its goals are written **up front for the whole app**. That is the main
  difference from what I explore here, where the contract **grows with the chat**.

## The verification question, framed

In grown software there is no spec document and no test suite written ahead of time. The program is whatever the
conversation made it. So what can stand in for "the tests"?

1. **The conversation itself.** When the user confirms an example in chat ("so 0.1 + 0.2 shows 0.3?" "yes"), that
   example is a requirement in their own words. Accumulate those as a ratchet: every later change must keep every
   earlier confirmed example.
2. **Use.** The app is used as it grows, so every real call is an observation of accepted behaviour. Recording calls
   with the state before and after gives a free regression corpus. The open question was how to tell an intended
   change from an unintended one. My answer: each request declares its **scope**, the functions it is about.
   - Diffs in traces that involve scope functions are *surfaced* to the user as a behaviour diff, like a PR.
   - Diffs that involve no scope function are rejected.
   - Edits to functions outside scope must be behaviour-preserving, checked by replaying traces on old world plus
     only those edits.
3. **Caller-owned laws.** Invariants on state from the start, and properties agreed in chat ("categories always add
   up to the total"), checked on generated states.
4. **The model never owns the contract.** It can *propose* examples, but they only count once the user confirms
   them. Self-graded tests pass by construction. That is Jiti's ADR 0008 and the most important rule.

## Build log

1. `world.ts`: a `node:vm` context as the "image". Functions are top-level declarations, so they are late-bound
   globals: redefining `sum` changed what `twice()` returned with no rebuild. That is the property that makes "live,
   no compilation" work, and JS has it as long as calls go through global names. The context has no `require` or
   `process`; `codeGeneration: {strings: false}` blocks `eval` and `new Function`; a 200 ms timeout kills synchronous
   hangs. State is one JSON object (like Jiti's readable table), copied by JSON round trip so checkpoints never alias.
2. `store.ts`: Jiti's store in miniature. It holds revision dirs, an fsync'd `CURRENT.tmp` that is renamed over
   `CURRENT`, a journal, and the addition `traces.jsonl`.
3. `gates.ts`: layers `static`, `invariants`, `ratchet`, `properties`, `traces` and `goals`. Each runs on its own, so
   the eval can attribute catches.
4. `kernel.ts`: Jiti's loop with generations. `develop` publishes a revision when every safety layer passes; unmet
   goals give `accepted-incomplete` (the intermediate progress Jiti allows). `execute` traces the call, undoes it if
   it breaks an invariant, and records it. `rollback` is history-preserving and restores that revision's contract too.
5. `scenario.ts`: an expense tracker grown in eight turns (add, total, by category, cents, validation, budgets, top
   category, notes), with confirmed examples, three properties and real use between turns.
6. `demo.ts`: everything accepted. Things refused:
   - a stale generation;
   - a CSV request that slipped in a `Math.floor` edit to `total()` (caught by ratchet, properties and traces);
   - `overBudget` caching into state (invariant `known-keys`);
   - a direct write of a negative expense (undone at execute time);
   - an infinite loop.

   A fresh process recovered rev-0017 with the full contract, and a rollback published rev-0018 as a copy of rev-0015.

## Mutation study, round 1 (no fuzz layer): `results/mutation-eval-v1-no-fuzz.md`

(This round predates the fuzz layer. To reproduce it, remove `"fuzz"` from `LAYERS` in `gates.ts`.)

245 first-order mutants of the eight proposals. Of those, 238 differ observably from the original under a
differential test of about 60 states times about 30 probes; 7 are likely equivalent. No legitimate proposal was
rejected.

| layer | catch rate alone | unique catches |
|---|---|---|
| static | 2% | 0 |
| invariants | 23% | 10 |
| ratchet (earlier confirmed examples) | 62% | 4 |
| properties | 49% | 3 |
| traces (use replay) | 59% | 8 |
| goals (this turn's examples) | 35% | 15 |
| **all** | **96%** (89% without goals) | |

- Each layer has unique catches. Invariants are the only thing that sees a stray `state.cache = {}` (10 of 11). Traces
  are the best detector of drive-by edits (92% alone) because they cover behaviour nobody wrote an example for.
- Every one of the 10 silent misses is one of two gaps:
  - **`setBudget` is never called by any check.** Examples set budgets through fixtures, and there are no traces yet
    because the function is new. Even a `while (true) {}` in it passes every layer. A function no check calls is
    simply unverified.
  - **The boundary `amount > 0` → `>= 0`.** The user said "zero or less" but the confirmed examples used -5 and "",
    never 0. Examples cover what people think of, not the boundaries.
- Both point to checks for inputs nobody wrote down, so I added a fuzz layer and a coverage report (round 2).

## Mutation study, round 2 (+ fuzz layer, coverage report): `results/mutation-eval-v2-fuzz.md`

What the fuzz layer does:
- It calls every function with tuples drawn from a pool of boundary values (`0, -1, NaN, "", null, undefined, 1e9,
  [], {}, ...`) on a few generated states.
- **Blocking:**
  - a hang;
  - a function outside the request's scope that behaves differently from the accepted version (synthetic-input
    traces);
  - an input on which the candidate corrupts the state but the accepted version did not (a validation regression).
- **Advisory (not blocking):** corruption that the accepted version allowed too, or that comes from a brand-new
  function. The kernel's execute-time invariant check undoes those calls at runtime anyway, so they are latent gaps
  to *show the user*, not regressions.

Coverage report: the functions in scope that no confirmed example of this turn calls (found by a dynamic call trace
of the examples).

Results (same 238 non-equivalent mutants, still 0 false positives):
- All layers: 96% to 97%. Safety layers alone: 89% to 90%. Hangs: 91% to 100%. Relational: 71% to 86%.
- The fuzz layer is strong alone (66%, and 95% of drive-bys) but overlaps almost entirely with traces and ratchet;
  its unique catches are hangs in functions nothing else calls and validation regressions. For drive-by edits it is
  a substitute for traces **before any usage exists**, since it needs no history.
- **Fuzzing found real bugs in the "correct" scenario code** that I wrote as the stand-in for a model:
  - `addExpense(1, 2.5)` passes the turn-5 validation (`!category` doesn't check the type), so a numeric category
    would corrupt the ledger;
  - `setBudget` accepts `NaN` and negative amounts.

  The invariants would undo these at runtime, but the user never thought to ask. That is the advisory channel
  doing its job.
- The coverage report flagged exactly the turn-6 gap (`setBudget` uncovered) on the unmutated proposal.
- Remaining silent misses: `setBudget` mutants (uncovered) and the `> 0` → `>= 0` boundary in addExpense, where the
  accepted version also allowed 0 at turn 5, so fuzz only advises.
- An implementation note: the first version deduplicated advisories per function, which hid a mutant's new
  advisories behind the legit one's. Deduplicating per expression fixed it (one stray-write mutant moved from
  "silent" to "surfaced").

## Mutation study, round 3 (contract fixed): `results/mutation-eval-v3-fixed-contract.md`

`CONTRACT=fixed` adds the two examples that a kernel enforcing coverage, and asking about the user's own boundary
words, would have obtained:
- turn 5: `addExpense(0, ...)` is rejected ("zero or less" names the boundary);
- turn 6: `setBudget` is called directly and its effect on state is checked.

- All layers: **100%** with goals, 92% with safety layers only. One silent survivor: `setBudget` dropping `return
  amount;`, because my fix example checks the state but ignores the return value. So an example has to observe both
  the value and the effect.
- The boundary example also lets the *invariants* catch the relational mutant (adding 0 now breaks `amount > 0` in
  the state), which shows how layers compound once an example exercises the boundary.

## What the three rounds say

| configuration | all layers | safety only | needs nothing from the user (static, invariants, fuzz, traces) |
|---|---|---|---|
| v1: as written | 96% | 89% | n/a (no fuzz) |
| v2: + fuzz | 97% | 90% | 73% |
| v3: + 2 examples the kernel asked for | 100% | 92% | 75% |

- **Machinery alone is not enough.** Static analysis, invariants, fuzzing and use-trace replay need nothing from
  the user, and catch about three quarters of slips. They are excellent at the categories nobody writes examples for:
  stray state writes, hangs, and drive-by edits to unrelated functions.
- **The user's confirmed examples carry the rest.** Ratchet plus goals take it from 75% to 100%, and goals had the
  most unique catches (15 to 18). So the verification design for chat-grown software is mostly about **harvesting
  examples from the chat**:
  - every request should end with the model proposing concrete input → output examples (including the boundaries
    the user's words imply), which the user confirms or corrects;
  - the kernel should refuse to call a change "done" while a function in scope is uncovered.
- **Scope declarations make use-replay usable.** Without a declared scope, any behaviour diff is ambiguous (intended
  or not). With it, out-of-scope diffs can be rejected automatically and in-scope diffs shown as a PR-like
  "behaviour diff".

## Caveats

- The mutants are first-order syntactic slips. Real LLM failures are often *misunderstandings* (a coherent program
  that does the wrong thing). Only user-confirmed examples catch those; the gates verify consistency with what was
  confirmed, not with what was meant.
- There is one scenario with 8 turns and 238 mutants. The differential "equivalence" oracle is about 60 generated
  states times about 30 probes: an approximation.
- The scenario code stands in for model output. No model API key was available, so the real chat loop (a model
  calling develop, execute and preview as tools) is described, not run. A fuzz pool tuned to this domain's types
  (numbers, strings) would need extending for richer data.
- `node:vm` is cooperative isolation, like Jiti's thread. Hostile code needs a process or isolate boundary.

## Tamper check (after reading the sibling harness's install-order finding)

The question: can a proposal neuter the caller's checks? `src/tamper-check.ts`, `results/tamper-check.txt`.

- Before the fix: the form `function helper() { return 1; }` followed by `Array.prototype.every = function () {
  return true; };` was **accepted**. Every invariant uses `.every`, so all of them would pass. The live world also
  diverged from the stored revision, because only declarations are stored. (The execute-time check happened to
  rebuild a fresh world from the stored declarations, so it was not fooled. That was luck, not design.)
- Fixes:
  - `World.define` rejects any top-level code other than function declarations;
  - every world realm freezes its intrinsics (`Object`, `Array`, `Math`, `JSON` and their prototypes), so a function
    body cannot tamper at call time either. The function-body variant is now accepted, but `every` stays native.
- Re-ran rounds 2 and 3 after the hardening to confirm the catch rates are unchanged.
- The general rule: the checks must not share mutable machinery with the code they check. It is the same lesson as
  the agent harness's "the kernel is installed last".
