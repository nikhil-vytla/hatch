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

## Session 2 (2026-10-06): chat loop, code/data separation, request ids, coverage refusal, misunderstandings

- Environment check: `ANTHROPIC_API_KEY` is **not set**, and the `ant` CLI is not installed, so no credential source
  exists. A real model run is therefore not possible here. Other credentials in the container (cloud, GitHub) were
  not given for model calls and I did not use them.
- Baseline: the demo reproduces `results/demo-output.txt` byte for byte before any change.
- Plan, in the given priority order: (1) a chat loop with a model adapter for Claude (SDK, loaded only with a key) and
  a scripted model that issues the same tool calls; (2) code rollback that keeps data, plus exactly-once request ids;
  (3) each revision records the chat message that asked for it; (4) the kernel refuses "done" while a function in
  scope is uncovered and asks boundary questions; (5) misunderstanding-style failures; (6) a second scenario if time.

### Items 2-4: store, kernel, questions (`store.ts`, `kernel.ts`, `ask.ts`)

- Revisions now carry `codeId` (hash of functions + contract) and `dataId` (hash of state). `rollback(id, what)`
  takes `"code"` (the new default: old code and contract, today's data), `"data"` or `"both"` (Jiti's behaviour).
  The combination must satisfy the invariants of the contract it lands under, or the rollback is refused and asks for
  a migration. Demo: rolling code back to before notes keeps the expense with a note (1 kept); `"both"` drops it, plus
  the expense added after the code rollback.
- Exactly-once `execute(expr, requestId)`: the id and the result go into the same revision file as the state change
  (the atomic `CURRENT` swap is the commit point); the trace is written after. A retry finds the id and returns the
  first result. Demo: a child process with `CRASH_AFTER_COMMIT=1` dies after committing `addExpense(2, "fun")`; the
  recovered kernel has 6 expenses, the retry with the same id returns `{"value":6,"replayed":true}` and still 6.
- **Bug found while wiring the chat loop:** the scripted model first built request ids from the expression text
  (`req-3-byCategory()`), so the second `byCategory()` in a turn was "replayed" and returned a stale result. A request
  id must name the request, not its content; two identical reads are two requests. Fixed with positional ids.
- Each develop records `asked: {message, text}`, the chat-log index and words of the user message that asked for it.
  `kernel.why("topCategory")` returns the revision and "Which category do I spend the most on? If two tie, pick the
  alphabetically first." A rollback does not count as the change that shaped a function.
- "Done" is now the user's: `develop` returns `accepted` only if this turn's confirmed examples pass *and* call every
  function in scope; otherwise `accepted-incomplete` with `uncovered`. The old demo's turn 6 now says
  `accepted-incomplete` (setBudget uncovered), which is the intended change.
- `ask.ts` makes the questions. The model proposes example *calls*; the kernel runs each on the candidate and shows
  the user the value **and** the state after (wrapped by `watch()`), and the user's answer becomes the expectation.
  Extra questions: boundary variants from the user's words (a small lexicon: "zero" -> 0, "less"/"negative" -> -1,
  "without"/"empty" -> ""), substituted into the literal arguments of proposed calls; and, for each function in scope
  that no question calls, a call built from argument values already typed in the chat, keeping only tuples whose
  result satisfies the invariants (otherwise `setBudget("food", "food")` would be the first tuple tried).
- On the scenario: turn 5 gets `addExpense(0, "food")` and `addExpense(-1, ...)` from "zero or less"; turn 6 gets
  `setBudget("food", 12.5)` because setBudget was uncovered. Those are the two examples I added by hand in round 3.

### Item 1: the chat loop (`chat.ts`, `model-claude.ts`, `sim-user.ts`)

- The loop speaks the Messages API wire format (tool_use / tool_result blocks, all results of a turn in one user
  message, assistant content appended unchanged). Tools: observe, develop, execute, preview, rollback, why.
  `develop` is where the user comes in: kernel.ask -> user answers -> kernel.develop with only the user's answers.
- Two models: `ScriptedModel` (the scenario's proposals, sent as tool calls: observe, then develop with the observed
  generation, then the turn's real use with request ids), and `ClaudeModel` (Anthropic TypeScript SDK 0.131,
  `claude-opus-5-5`, effort high, server-side refusal fallback, cached system prompt). The SDK is only imported when
  `MODEL=claude`; the kernel and evals still need no dependencies. `npx tsc -p .` type-checks everything, including
  the adapter.
- **Not run against a real model.** `MODEL=claude` gets as far as the first request and stops with the SDK's "Could
  not resolve authentication method". The adapter's request shape is type-checked, not exercised.
- `SimulatedUser` answers the kernel's questions from the *intended* program (the scenario's forms up to that turn).
  It never errs, so it is an upper bound on what confirmation can catch.
- Scripted run (`results/chat-scripted.txt`): 8 turns all `accepted`, 49 chat-log entries, 23 confirmed examples,
  0 corrections.

### Round 4 of the mutation study: `CONTRACT=chat` (`results/mutation-eval-v4-chat-contract.md`)

Each turn's contract is exactly what the kernel's questions collected in the scripted chat run. Nothing added by
hand. Rounds 2 and 3 were re-run first and reproduce exactly (identical per-mutant JSON; only the timing line moved).

| configuration | all layers | safety only | machinery only | ratchet alone | goals alone | silent misses |
|---|---|---|---|---|---|---|
| v3: 2 examples added by hand | 100% | 92% | 75% | 66% | 37% | 1 |
| v4: contract from the kernel's questions | **100%** | 92% | 75% | 78% | 45% | **0** |

- The round-3 survivor (setBudget dropping `return amount;`) is now caught, because every question records the
  value and the state.
- Invariants' unique catches went from 8 to 0: the confirmed examples now see the state, so they also see
  `state.cache = {}`. Invariants stay useful for the states nobody asked about (execute-time and fuzz), but on this
  scenario they no longer carry anything alone.

### Item 5: misunderstandings (`misreadings.ts`, `misunderstanding-eval.ts`)

21 hand-written misreadings of the 8 expense turns: coherent programs, no slips, each a plausible reading of the
user's words (e.g. "zero or less" read as "less than zero"; ties go to the alphabetically last; "spend the most on"
read as "most often"; a note folded into the category). All 21 behave differently from the intended program on the
probes. Each goes through every layer under three contracts: **self** (the model's own calls with its own program's
answers), **written** (the scenario's user-confirmed examples), **chat** (the kernel's questions, answered by the
simulated user from the intended program).

- First run had a bug in the self-graded column: `?? "error"` turned a `null` answer into the expectation "error", so
  self-graded goals "caught" 3 misreadings. Fixed; self-graded goals now catch 0, which is what must happen by
  construction. Worth recording: a self-graded check can only fail through a harness bug.
- v1 (`results/misunderstanding-eval-v1.md`), rules as designed before seeing any misreading:

  | contract | caught | by safety layers | by this turn's examples | silent misses |
  |---|---|---|---|---|
  | self | 6/21 (29%) | 6/21 | 0/21 | 14 (+1 behaviour diff shown) |
  | written | 14/21 (67%) | 6/21 | 14/21 | 7 |
  | chat | 16/21 (76%) | 8/21 | 16/21 | 5 |

  - Safety layers catch only misreadings that break something else: a stated property (categories sum to the
    total), an invariant (empty category), or an earlier confirmed answer. 6 of 21.
  - Chat beats written on `validate-negative-only` (the "zero" boundary question) and `add-newest-first` (the
    question shows the state, so the order of expenses is visible).
  - Chat misses 5: `add-lowercases` (no question uses a capital letter), `cents-truncate` (no question has a third
    decimal), `budget-at-limit` (no question has spending exactly at the budget), `budget-accumulates` (each call is
    asked once, on an empty state), `note-required-text` (no whitespace note). In every case the distinguishing input
    is one nobody asked about.
- Post-hoc rule (motivated by `budget-accumulates`, so tuned on this set): every state-changing call is also asked
  twice in a row, which separates "set" from "add to". v2 (`results/misunderstanding-eval-v2-repeat.md`): chat
  17/21 (81%); the others unchanged. `ASK_RULES=v1` turns the rule off.
- The mutation study under the chat contract with the v2 rule gave per-mutant kills identical to round 4, so I kept
  no separate result files for it; round 4 itself reproduces exactly with `ASK_RULES=v1`.

### Item 6: a second scenario, as a held-out test (`scenario-shop.ts`, `scenarios.ts`)

Stock for a small shop in 6 turns: add stock, sell (refuse below zero), low stock ("fewer than 5"), prices and
stock value, a restock list ("back to 10"), and case/space-insensitive names with a **data migration** of the live
state (the first turn in either scenario that uses `migrate`; the chat tool gained a `migrate` field). 17 misreadings
were written before any run. `SCENARIO=shop` selects it in the chat loop and both evals; the expense results
reproduce exactly after the refactor (misunderstanding v2 compared byte for byte).

- Chat run (`results/chat-scripted-shop.txt`): 6 turns all `accepted`, 25 confirmed examples, the migration
  applied. One noisy question: "without a price" produced `setPrice("", 1.25)`. The lexicon is crude.
- Misreadings, held out (`results/misunderstanding-eval-shop.md`): self 4/16, written 12/16, **chat 12/16**. On
  expenses chat had beaten written; here it ties. The expense wins came from boundary *arguments* ("zero or less").
  The shop's boundaries are in the *data*: "fewer than 5" is about a stock level of exactly 5, and "never below zero"
  is about a sale of exactly what is on the shelf. No rule puts those into a question. Misses: `sell-keeps-one`,
  `low-inclusive`, `value-unrounded`, `restock-under-10`.
- `key-no-migration` showed "no observable difference", and that is true: the live data at turn 6 is all lower case,
  so the migration is a no-op on it. A missing migration is invisible until data that needs it exists. (I also made
  the oracle compare the live state after building, so a migration that does differ would count.)
- Mutation study on the shop (`results/mutation-eval-shop-written.md`, `-shop-chat.md`): 229 mutants, 224 real,
  0 false positives. All layers: written **90%**, chat **92%** (vs 100% on expenses). Machinery only: 67% (75% on
  expenses). The silent misses are the same data boundaries: `<` -> `<=` and `5` -> `6` in lowStock, `>` -> `>=` in
  sell, plus drive-by versions of those that traces and fuzz cannot see because no recorded or generated state sits
  exactly on the boundary.
- The round-3 lesson came back in a new form: under the chat contract, `setPrice` dropping `return price;` survives.
  setPrice *is* covered, but the only call is `(setPrice("pear", 1.25), stockValue())`, and the comma expression
  throws the return value away before `watch()` sees it. Coverage of a function is not observation of its value.

### Question rules v3, post-hoc after the shop (`ask.ts`; `ASK_RULES=v1|v2|v3`, v3 is the default)

Two rules, both motivated by what the held-out scenario missed, so the v3 numbers below are tuned on both scenarios
and are no longer a held-out measurement:

- **Data boundaries.** Numbers the user says ("fewer than 5", "back to 10", "below zero" -> 0) are also put into the
  *state* each proposed call runs on, one numeric field at a time, keeping only states that satisfy the invariants.
  `lowStock()` is then asked on a shelf with exactly 5 pears.
- **Coverage needs an observed result.** A function counts as covered only if a question observes its own return
  value (a direct call, an array element, or the last part of a comma expression). That turns `setPrice`, `cents`,
  `key` and the turn-5/8 `addExpense` into coverage questions with direct calls.
- Bug on the way: the number regex skipped "10." at the end of a sentence (the lookahead refused the period), so the
  restock turn got no data questions until fixed.
- The coverage call builder is crude: it tries seen strings before numbers, so `cents` gets asked as `cents("food")`
  (NaN, shown as null). Harmless, but a real kernel should use the parameter's observed types.

Results:

| | expenses mutants | shop mutants | expense misreadings | shop misreadings |
|---|---|---|---|---|
| as-written examples | 96-97% (v1/v2), 100% with 2 hand-added (v3) | 90% | 14/21 | 12/16 |
| chat, rules v1 | 100% (round 4) | n/a | 16/21 | n/a |
| chat, rules v2 | 100% (identical to round 4) | 92% | 17/21 | 12/16 (held out) |
| chat, rules v3 | 100% (`v5-chat-v3-rules`) | **96%** | 17/21 | **13/16** |

- Shop mutants still missed under v3 (7 silent): all in `sell`. `qty > have` -> `>=` (a sale of exactly what is on the
  shelf), and `|| 0` -> `|| 1` (selling an item never stocked). Both need an *argument* derived from the data (qty
  equal to the stock; a name not in the stock), which no rule produces. The misreading `sell-keeps-one` is the
  same boundary.
- Misreadings missed by every contract (both scenarios): `add-lowercases`, `cents-truncate`, `budget-at-limit`,
  `note-required-text`, `sell-keeps-one`, `value-unrounded`, `restock-under-10`. Each needs a specific input nobody
  mentioned: a capital letter, a third decimal, spending exactly at a budget, a whitespace note, an exact sale, a
  fractional product, a stock between 5 and 9.
- Machinery alone (static, invariants, fuzz, traces) catches 67% of shop mutants and 75% of expense mutants, and the
  user's examples carry the rest in both. The pattern from round 3 holds on the second scenario.

### Reproducing every result file (from `prototype/`, prefix each with `node --experimental-strip-types --no-warnings`)

| file | command |
|---|---|
| `demo-output.txt` | `src/demo.ts` |
| `tamper-check.txt` | `src/tamper-check.ts` |
| `chat-scripted.txt`, `chat-scripted-shop.txt` | `src/chat.ts`, `SCENARIO=shop src/chat.ts` |
| `mutation-eval-v1-no-fuzz.md` | remove `"fuzz"` from `LAYERS` in `gates.ts`, then `EVAL_TAG=v1-no-fuzz src/mutation-eval.ts` |
| `mutation-eval-v2-fuzz.*` | `EVAL_TAG=v2-fuzz src/mutation-eval.ts` |
| `mutation-eval-v3-fixed-contract.*` | `CONTRACT=fixed EVAL_TAG=v3-fixed-contract src/mutation-eval.ts` |
| `mutation-eval-v4-chat-contract.*` | `ASK_RULES=v1 CONTRACT=chat EVAL_TAG=v4-chat-contract src/mutation-eval.ts` |
| `mutation-eval-v5-chat-v3-rules.*` | `CONTRACT=chat EVAL_TAG=v5-chat-v3-rules src/mutation-eval.ts` |
| `mutation-eval-shop-written.*` | `SCENARIO=shop EVAL_TAG=shop-written src/mutation-eval.ts` |
| `mutation-eval-shop-chat-v2.*` | `ASK_RULES=v2 SCENARIO=shop CONTRACT=chat EVAL_TAG=shop-chat-v2 src/mutation-eval.ts` |
| `mutation-eval-shop-chat-v3.*` | `SCENARIO=shop CONTRACT=chat EVAL_TAG=shop-chat-v3 src/mutation-eval.ts` |
| `misunderstanding-eval-v1.*`, `-v2-repeat.*`, `-v3.*` | `ASK_RULES=v1 EVAL_TAG=v1`, `ASK_RULES=v2 EVAL_TAG=v2-repeat`, `EVAL_TAG=v3`, each `src/misunderstanding-eval.ts` |
| `misunderstanding-eval-shop-v2-heldout.*`, `-shop-v3.*` | `SCENARIO=shop` with `ASK_RULES=v2 EVAL_TAG=v2-heldout` / `EVAL_TAG=v3` |

Checks done at the end: `npx tsc -p .` clean; demo and tamper check reproduce their committed outputs; rounds 2 and 3
reproduce (only the timing line differs); round 4 reproduces with `ASK_RULES=v1`; the expense misunderstanding v2
reproduces byte for byte after the scenario refactor. `MODEL=claude src/chat.ts` stops at the SDK's authentication
error: no real model run was possible.

### Session 3 (2026-10-08): DeepSeek adapter, not yet run

- The user offered a DeepSeek key in `~/.pi/agent/auth.json`. That file is not in this cloud container, and
  `DEEPSEEK_API_KEY` is not set (environment changes reach only new sessions). After the user updated the network
  policy, `api.deepseek.com` is reachable.
- Added `src/model-deepseek.ts` (`MODEL=deepseek`): DeepSeek's OpenAI-style chat completions over plain `fetch`, no
  SDK. It translates the loop's Messages API blocks on every call (tool_use <-> `tool_calls` with JSON-string
  arguments, one `role: "tool"` message per tool_result). Unparseable arguments become an input the tool handler
  rejects, so the model sees the error. `npx tsc -p .` is clean; without a key it stops with "DEEPSEEK_API_KEY is
  not set"; the scripted chat output is unchanged.
- A run with it would test a non-Claude model in the loop and should be reported as that.
- The remote branch had been rewritten onto a reorganised repo (no common history with my local branch; the
  folder's content was identical). I re-applied this commit on top of it instead of force-pushing, and kept the old
  local commit on a local backup branch.
- README: the adapter is listed under What's here and Limits. Ran the repo's `summarize` skill (new in AGENTS.md):
  the summary already describes the README accurately, so `_summary.md` is unchanged apart from naming both adapters.

### Session 4 (2026-10-08): first real-model run, DeepSeek

- The key arrives through the session's proxy, not the environment: the proxy adds `Authorization` to requests for
  `api.deepseek.com` only when the request carries none. A placeholder key got a 401 for that reason. The adapter
  now sends the header only when `DEEPSEEK_API_KEY` is set.
- Node's built-in `fetch` ignores `HTTPS_PROXY`; it needs `NODE_USE_ENV_PROXY=1` (Node >= 22.21). Without it the
  request went straight out and got DeepSeek's own 401 ("governor").
- `deepseek-chat` is served as `deepseek-flash` (DeepSeek-V4.1-Flash); `/models` also lists `deepseek-v4-pro`.
- Run 1 (`results/chat-deepseek-flash-v1.txt`, 2 min): 1 of 17 `develop` calls landed (accepted-incomplete),
  5 confirmed examples, 13 corrections. The model spent the whole chat on one ratchet case that read
  "gave `error`, confirmed `error`".
  - **Kernel bug, found only by a real model:** DeepSeek wrote calls as `addExpense(3, "coffee"); listExpenses()`.
    `watch()` puts the call inside `( ... )`, where `;` is a syntax error. Both the candidate and the simulated
    user evaluate to "error", so a syntax error became a confirmed answer, and the ratchet (which fails any run
    that errors) could never pass it. 97 of the kernel's questions in that run were unparseable. The scripted
    model always joins steps with commas, so it never hit this.
  - Fix: `Kernel.ask` refuses a proposed call that is not one expression, with "join steps with commas, not
    semicolons"; the tool schema says the same. Scripted chat transcripts (both scenarios) and the demo output are
    unchanged; `tsc` is clean.
- Run 2 (`results/chat-deepseek-flash-v2.txt`, 2.7 min): 7 of 24 `develop` calls landed (4 accepted,
  3 accepted-incomplete), 60 confirmed examples, 0 single-expression refusals, 106 corrections.
  - **The remaining blocker is the simulated user, not the model.** It answers by running the *scripted* program,
    so it knows only the scripted names (`total`, `byCategory`, `overBudget`...). DeepSeek chose `getExpenses`,
    `totalExpenses`, `expensesByCategory`; every question about those "should throw" in the user's answers. The
    model then has to build functions that throw, against the user's words. The budget turn (17 rejections) is
    where this piles up. So the simulated user tests agreement with the script's names as much as behaviour.
  - Not fixed here. Options: give the model the function names in the user's messages (changes the scenario), or
    let the simulated user map unknown names onto intended functions by behaviour (hard to do honestly).
- `why topCategory()` prints undefined after the DeepSeek run because the model never defined a function by that
  name; the line is hard-coded to the scripted names.

### Session 5 (2026-10-08): deepseek-flash by default, interactive mode

- The adapter's default model is now `deepseek-flash` (what `deepseek-chat` was already served as).
- Added `src/terminal-user.ts` (`INTERACTIVE=1`): a person replaces the simulated user. It reads stdin synchronously
  (`readSync` on fd 0) because the `User` interface is synchronous. Smoke test piped one request plus empty lines
  (accept every answer) through DeepSeek: 7 questions, `addExpense` accepted at rev-0003, 13 confirmed examples.
  Scripted transcripts are unchanged.
- In this mode the user's own judgement replaces the scripted program, so the naming problem from session 4 goes away.
- First local run by the user failed with DeepSeek's "Authentication Fails (governor)": outside this container there
  is no proxy adding the key, and `DEEPSEEK_API_KEY` was unset. A 401 without a key now says so. Added
  `npm run play` for the interactive command (a typo'd `-- experimental-strip-types` made node look for a file).

### Session 6 (2026-10-08/09): five more languages, merged here

- Built Clojure, Elixir, Pharo Smalltalk, Racket and Lean 4 kernels behind one protocol, benchmarked them with
  DeepSeek and recorded seven demos. Worked as a separate top-level folder first, then moved into `languages/`
  at the user's request so the whole investigation is self-contained. Its own notes: `languages/NOTES.md`.
- The move: `git mv`, four import prefixes `../../chat-grown-software/prototype/` -> `../../prototype/`, every
  kernel rebuilt from scratch at the new path (ignored build output deleted first, so each setup ran as on a fresh
  clone: Lean 2 min, the others 5-12 s), then 6 kernels x 2 scenarios of conformance (all pass), the prototype's scripted
  chat output unchanged and `tsc` clean.
