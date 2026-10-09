# Growing software by talking to it, and how to verify it

Geoffrey Huntley [asks](https://ghuntley.com/lisp/): "Why is software built the way it is now, rather than grown
through iterative use of LLMs? What if you could develop your application just by chatting with it? Live and
interactive, with no compilation steps." His answer is [Jiti](https://github.com/ghuntley/jiti), a Common Lisp
kernel. You ask for a capability, the model writes Lisp, and the running image keeps it.

This folder rebuilds that idea without Lisp and concentrates on the hard part: **how do you know a program grown
one chat turn at a time is still right?** It contains:

- a small kernel in TypeScript;
- a chat loop in which a model calls the kernel's tools and the user, not the model, decides what "done" means;
- two apps grown through it: an expense tracker (8 turns) and a shop's stock (6 turns, with a data migration);
- two studies:
  - 474 model-style slips (mutants), measuring which verification layer catches which kind of mistake;
  - 38 hand-written *misunderstandings*: coherent programs that do the wrong thing (37 of them observably);
- a follow-up in [`languages/`](languages/README.md): is TypeScript the right language for this kernel? The same
  kernel in Clojure, Elixir, Pharo Smalltalk, Racket and Lean 4, benchmarked with DeepSeek, with seven recorded demos.

> Note: ghuntley.com was blocked in this environment. The post's substance came from the Jiti repository (README, 14
> ADRs, examples) and Geoff's ["CS50-style tour" gist](https://gist.github.com/ghuntley/b8e28634090c51895d7972ff6a7c5619).
> No Claude API key was available, so the results come from a scripted model. DeepSeek has also driven the chat
> loop; that run found a kernel bug, and its scores depend on the simulated user (see Limits).

## The short answer

The verification for chat-grown software is a contract that **grows with the chat and is owned by the user, never
by the model**, plus machinery that needs nothing from anyone:

| layer | owned by | what it catches best |
|---|---|---|
| **static** | kernel | calls to functions that don't exist; forms that are not pure declarations |
| **invariants** | caller, from the start | stray writes into state, corrupt data |
| **ratchet** | user, accumulated | regressions of anything confirmed in an earlier turn |
| **properties** | user, agreed in chat | arithmetic and logic slips ("categories always add up to the total") |
| **fuzz** | kernel | hangs; out-of-scope behaviour changes and validation regressions on boundary inputs nobody typed |
| **traces** | kernel, from real use | drive-by edits to functions the request was not about |
| **goals** | user, this turn | "did it do what I asked?" (the most unique catches) |

The contract comes from **questions the kernel asks**. The model proposes example *calls*, never expected answers.
The kernel runs each call on the candidate and shows the user what it returns and what it does to the state, and
only the user's answer counts. The kernel adds its own questions:

- **argument boundaries** from the user's words: "zero or less" gives 0 and -1;
- **data boundaries**: "fewer than 5" gives a state with exactly 5 left;
- **repetition**: the same call twice in a row, to tell "set" from "add to";
- **coverage**: a direct call for any function in scope whose result no question observes.

The kernel refuses "done" until the user's answers pass and every function in scope is covered.

Results on mutants that change observable behaviour (no legitimate change was ever rejected):

| contract | expenses (238 mutants) | shop (224 mutants, held out until v3) |
|---|---|---|
| examples as the user wrote them | 96-97% | 90% |
| + the 2 examples a coverage-enforcing kernel would ask for (added by hand) | 100% | n/a |
| **the kernel's questions** (rules v1, before the shop existed) | **100%** | n/a |
| the kernel's questions, rules v2 (+ repetition) | 100% | 92% |
| the kernel's questions, rules v3 (+ data boundaries, observed coverage) | 100% | **96%** |
| machinery that needs nothing from the user (static, invariants, fuzz, traces) | 75% | 67% |

And on misunderstandings, coherent but wrong programs (counting the ones that differ observably from what the user
meant):

| contract | expenses (21) | shop (16) |
|---|---|---|
| self-graded (the model's own calls and answers) | 6 (29%) | 4 (25%) |
| examples as the user wrote them | 14 (67%) | 12 (75%) |
| the kernel's questions, rules v1 / v2 | 16 / 17 (81%) | 12 (75%, held out) |
| the kernel's questions, rules v3 | 17 (81%) | 13 (81%) |

Three takeaways:

- **Machinery catches two thirds to three quarters of slips and few misunderstandings.** That covers stray writes,
  hangs and edits to unrelated functions. A misunderstanding passes it unless it breaks something already pinned
  down: a stated property, an invariant, or an earlier answer.
- **The user's answers carry the rest, and the kernel can collect them.** On the expense tracker the kernel's
  questions reach 100% with nothing added by hand. They find the two examples I had added by hand after round 1,
  and also catch the one slip my hand-added example let through.
- **What no one asks about stays unverified.** The kernel can only ask about inputs it can derive. The question rules
  were designed on the expense tracker. On the held-out shop scenario they tied the user's own examples (12/16
  misreadings) and missed boundaries that live in the data. Rules added after seeing that (v3) recovered some (96%,
  13/16). Seven misreadings still pass every contract, each needing an input nobody mentioned: a capital letter, a
  third decimal, spending exactly at the budget, a sale of exactly the stock.

## Follow-up: which language should the kernel be written in?

[`languages/`](languages/README.md) rebuilt the kernel five more times behind one JSON-lines protocol, then had
DeepSeek grow two apps (this expense tracker and an LLM API gateway) in each, 3 runs per language, scored by hidden
checks the model never sees:

| kernel | expenses | gateway | output tokens / run | what the language adds |
|---|---|---|---|---|
| JavaScript (this prototype's `World`) | 100% | 100% | 15-22k | baseline |
| Clojure | 98% | 100% | 20-35k | code as data: missing functions and side effects refused statically |
| Elixir | 100% | 100% | 13-39k | hot code loading with live state migration (564 requests, 0 failures during a reshape) |
| Pharo Smalltalk | 100% | 100% | 18-28k | the live image: 25 ms changes, change log, per-method rollback, save/restart |
| Racket | 95% | 100% | 25-41k | a real sandbox: attacks that escape `node:vm` are contained |
| Lean 4 | 83% | 84% | 130-160k | proofs: "no key exceeds its quota" proved for all inputs |

The language barely changes whether the model gets the code right; it changes what the kernel can know before
running anything and what it can safely do to a live system. Lean is the exception both ways: the strongest
guarantees, at 3-12x the tokens and with turns lost to re-proving. Details, the showcases and their videos are in
[`languages/README.md`](languages/README.md).

## What's here

```
languages/                   the follow-up: PROTOCOL.md, bench/ (DeepSeek driver, simulated user, conformance),
                             js/ clojure/ elixir/ smalltalk/ racket/ lean/ kernels, results/, videos/
prototype/
  src/world.ts               the live "image": late-bound functions + JSON state in a node:vm realm
  src/store.ts               revisions (code id + data id) + atomic CURRENT + journal + traces + request ids
  src/gates.ts               the seven layers, each runnable alone; scope-aware trace replay; fuzz; coverage
  src/kernel.ts              ask / develop / execute / preview / rollback / why, with generations and checkpoints
  src/ask.ts                 the kernel's questions: proposed calls, boundaries, repetition, coverage
  src/chat.ts                the chat loop over the kernel's tools (Messages API wire format), scripted model
  src/model-claude.ts        Claude as the model (Anthropic SDK; only loaded with MODEL=claude)
  src/model-deepseek.ts      DeepSeek as the model (OpenAI-style API over fetch; MODEL=deepseek, NODE_USE_ENV_PROXY=1 behind a proxy)
  src/sim-user.ts            a simulated user who answers from the intended program
  src/terminal-user.ts       you as the user (INTERACTIVE=1): type requests, confirm or correct the kernel's questions
  src/scenario.ts            the expense tracker in 8 turns
  src/scenario-shop.ts       the shop's stock in 6 turns, its misreadings and probes
  src/scenarios.ts           SCENARIO=expenses|shop
  src/misreadings.ts         21 misreadings of the expense turns
  src/demo.ts                grows the app; refusals; recovery; why; code-only rollback; crash + retried request
  src/mutation-eval.ts       the mutation study (CONTRACT=written|fixed|chat, SCENARIO=...)
  src/misunderstanding-eval.ts  the misunderstanding study (self / written / chat)
  src/tamper-check.ts        can a proposal neuter the checks? (it could; now it can't)
  results/                   outputs of every run named in NOTES.md
```

Run it (Node 22.6+; the kernel, demo and evals need no dependencies):

```sh
cd prototype
node --experimental-strip-types --no-warnings src/demo.ts
node --experimental-strip-types --no-warnings src/chat.ts                              # scripted model, simulated user
SCENARIO=shop node --experimental-strip-types --no-warnings src/chat.ts
node --experimental-strip-types --no-warnings src/misunderstanding-eval.ts            # about 30 s
CONTRACT=chat EVAL_TAG=x node --experimental-strip-types --no-warnings src/mutation-eval.ts   # about 2 min
npm install && MODEL=claude node --experimental-strip-types --no-warnings src/chat.ts  # needs ANTHROPIC_API_KEY
npx tsc -p .                                                                           # type-check (after npm install)
```

`ASK_RULES=v1|v2|v3` picks the question rules (v3 by default) to reproduce earlier rounds. NOTES.md maps every
result file to the command that produced it.

## Try it yourself

Needs Node 22.6+ and a DeepSeek key (the model defaults to `deepseek-flash`; `DEEPSEEK_MODEL` overrides it):

```
cd chat-grown-software/prototype && npm ci
export DEEPSEEK_API_KEY=sk-...
npm run play     # = INTERACTIVE=1 MODEL=deepseek node --experimental-strip-types --no-warnings src/chat.ts
```

Type what you want ("Let me record expenses: an amount and a category."). When the model calls `develop`, the
kernel shows each question's call, what it returns and the state it leaves: press Enter if that's right, `t` if it
should throw, `v <json>` for a different return value, or a full `{"value": ..., "state": ...}`. An empty line ends
the chat. The app lives in `prototype/data/chat-expenses/` (revisions, journal, `chat.jsonl`); each run starts it
fresh. The expense scenario's invariants still apply (`SCENARIO=shop` for the shop's). Behind an HTTPS proxy, add
`NODE_USE_ENV_PROXY=1`.

## How the kernel works

It follows Jiti's design, translated to JavaScript:

```
user says something
  -> model: observe, then develop {intent, scope, forms, example calls}  (tagged with the generation it saw)
  -> kernel: generation check; build the candidate; ask the user about what the candidate actually does
  -> user answers: the answers are this turn's examples (the model's expectations never count)
  -> gates: static, invariants, ratchet, properties, fuzz, traces, goals
  -> safety layers pass?  the change goes live as a revision recording the chat message that asked for it
                          "accepted" only if the user's answers pass and every function in scope is observed,
                          otherwise "accepted-incomplete" with what is missing
     otherwise:           the live world is untouched
execute(expr, request_id) -> traced call -> invariants on the new state (undo if broken)
                          -> revision with the request id and result (exactly-once) -> trace
```

- **Live, no compilation.** Functions are top-level declarations in one `node:vm` context. Calls go through global
  names, so redefining `cents` changes what `total()` computes on its next call. That is the same late binding that
  makes Lisp images live, and JS has it too.
- **Checkpoints and revisions.** Every attempt runs on a candidate built from a snapshot. Accepted changes publish an
  immutable revision and atomically swap `CURRENT`. A fresh process recovers it with the whole contract.
- **Code and data roll back separately.** Each revision has a `codeId` (functions + contract) and a `dataId`
  (state). `rollback(id)` restores code and contract and keeps today's data; `"data"` and `"both"` are explicit. A
  combination that breaks the invariants is refused and needs a migration. In the demo, rolling code back to before
  notes now keeps the expense recorded with a note. Jiti-style `"both"` drops it.
- **Exactly-once requests.** The request id and result are written in the revision file that commits the state
  change. In the demo a process dies right after committing `addExpense(2, "fun")`. The client retries with the
  same id and gets `{"value": 6, "replayed": true}`, and there are still 6 expenses.
- **The chat is the change log.** Each revision stores the index and words of the chat message that asked for it.
  `why("topCategory")` answers "Which category do I spend the most on? If two tie, pick the alphabetically first."
- **Scope makes use-replay decidable.** Each proposal declares which functions the request is about. When a recorded
  real call would now behave differently:
  - if the call involves a function in scope, the diff is *surfaced* to the user ("`total()`: 59.75 → 59, confirm?");
  - otherwise it is rejected;
  - edits to functions outside scope must replay every trace identically on the old world plus just those edits.
- **Fuzzing has two outputs.** A *blocking* one covers hangs, out-of-scope changes and validation regressions. An
  *advisory* one reports inputs that would corrupt state where the accepted version allowed that too. Advisories
  found two real gaps in the code I wrote as the model's answers: `addExpense(1, 2.5)` passes validation with a
  numeric category, and `setBudget` accepts `NaN`.

## Findings beyond the numbers

- **A self-graded check can only fail through a bug in the harness.** In the first misunderstanding run the
  self-graded contract "caught" 3 misreadings. The cause was my `?? "error"` turning a `null` answer into the
  expected value. After the fix it catches 0, as it must by construction. Jiti's ADR 0008 makes the caller own
  acceptance for this reason. Here the model only proposes calls.
- **Coverage of a function is not observation of its value.** Round 3's survivor dropped `return amount;` because
  the example checked only the state. The fix, every question shows both the value and the state, killed it. Then
  the shop produced the same bug in a new form: `setPrice` was called only inside `(setPrice(...), stockValue())`,
  where the comma throws its value away. Rules v3 count a function as covered only when a question observes its own
  result.
- **Boundaries live in the data as often as in the arguments.** "Zero or less" names an argument; "fewer than 5" and
  "never below zero" name stock levels. The second kind needs states (or arguments derived from them) that nobody
  typed. The remaining shop misses are of that kind.
- **A request id must name the request, not its content.** The scripted model first derived ids from the expression,
  so a second identical `byCategory()` in the same turn came back "replayed" with a stale value.
- **A missing migration is invisible until data that needs it exists.** At the shop's turn 6 all live names are lower
  case, so the misreading that skips the migration behaves identically. It would only show once a capitalised name
  had been stored before the change.
- **A syntax error can become a confirmed answer.** The first real-model run (DeepSeek) wrote calls as
  `a(); b()`. Wrapped in parentheses for the question, that is a syntax error, which the candidate and the user
  both "answer" as an error. The ratchet then fails that example forever ("gave `error`, confirmed `error`"), and
  the model spent the whole chat on it: 1 of 17 changes landed. The kernel now refuses a call that is not one
  expression. In the second run 7 of 24 landed, and the remaining rejections come from the simulated user (above).
- **A "function" can carry top-level statements.** A form of `function helper() {...}` followed by
  `Array.prototype.every = () => true` was accepted and made every invariant pass. The fixes are two: forms may only
  declare functions, and the realm's intrinsics are frozen (`results/tamper-check.txt`). **The checks must not share
  mutable machinery with the code they check.**

## Lessons that transfer from building a self-modifying agent harness

A sibling experiment built a durable agent harness that writes and hot-installs its own tools, on
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable),
[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)-style memory and
[celld](https://github.com/denoland/celld)-style cells. Its lessons, and where they ended up here:

1. **Separate code identity from state identity** (celld's version ids and facets). *Implemented:* code and data
   ids per revision, code-only rollback by default, refusal when the old code cannot hold today's data. Still
   missing: a verified migration path for that refusal. celld warns that unmigrated state "can keep a value that the
   new configuration rejects. The failure then looks unrelated to the change."
2. **Exactly-once effects through an id stored with the effect.** *Implemented* for `execute`, with a crash test.
3. **The kernel must be out of the model's reach; install order is a security boundary.** Same class as the tamper
   finding above.
4. **The chat is the change log** (OptChat keeps every message and ranks the user's own words highest).
   *Implemented:* revisions point at the chat message that asked for them, and `why()` follows the pointer.
5. **Keep the prompt prefix stable as the app grows.** The chat loop's system prompt and tool list never change; the
   function catalogue arrives through `observe` results, so a provider cache stays warm.

## Limits

- **One real model has run the chat loop: DeepSeek (V4.1-Flash), not Claude.** `ANTHROPIC_API_KEY` is not set, so
  the Claude adapter is untested. The DeepSeek runs (`results/chat-deepseek-flash-v1.txt`, `-v2.txt`) are judged
  by the simulated user, who knows only the scripted program's function names. A model that names things
  differently (`totalExpenses` for `total`) is "corrected" toward functions that throw. Their numbers measure
  agreement with the script as much as the model, so they are not comparable with the scripted results. (The
  `languages/` benchmark avoids this by naming each function in the user's message.)
- **The simulated user never errs.** They answer from the intended program, so the chat numbers are an upper bound
  on what confirmation catches. Real users mis-confirm, and a long list of questions (up to 11 in one turn here)
  costs attention.
- **I wrote the misreadings, the question rules, and the scenarios.** The shop scenario and its misreadings were
  written before any run, so the v2 shop numbers are held out. The v3 rules were then tuned on both scenarios.
- Mutants are first-order syntactic slips; the "is it equivalent?" oracle is a differential test, not a proof.
- The boundary lexicon is crude: "without a price" produced `setPrice("", 1.25)`, and coverage calls pick argument
  values by kind, not by the parameter's type (`cents("food")`).
- `node:vm` with frozen intrinsics and a timeout is cooperative isolation (`languages/racket/showcase/` runs the
  same attacks against both). Hostile code needs a process or isolate boundary, as Jiti's README also says.
