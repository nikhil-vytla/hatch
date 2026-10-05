# Growing software by talking to it, and how to verify it

Geoffrey Huntley [asks](https://ghuntley.com/lisp/): "Why is software built the way it is now, rather than grown
through iterative use of LLMs? What if you could develop your application just by chatting with it? Live and
interactive, with no compilation steps." His answer is [Jiti](https://github.com/ghuntley/jiti), a Common Lisp
kernel. You ask for a capability, the model writes Lisp, and the running image keeps it.

This folder rebuilds that idea without Lisp and concentrates on the hard part: **how do you know a program grown
one chat turn at a time is still right?** It contains a small kernel in TypeScript and an expense tracker grown in
eight turns. A mutation study of 245 model-style mistakes measures which verification layer catches which kind of
mistake.

> Note: ghuntley.com was blocked in this environment. The post's substance came from the Jiti repository (README, 14
> ADRs, examples) and Geoff's ["CS50-style tour" gist](https://gist.github.com/ghuntley/b8e28634090c51895d7972ff6a7c5619).

## The short answer

The verification for chat-grown software is a contract that **grows with the chat and is owned by the user, never
by the model**, plus machinery that needs nothing from anyone:

| layer | owned by | what it catches best |
|---|---|---|
| **static** | kernel | calls to functions that don't exist; forms that are not pure declarations |
| **invariants** | caller, from the start | stray writes into state, corrupt data (the only layer that saw `state.cache = {}`) |
| **ratchet** | user, accumulated | regressions of anything confirmed in an earlier turn |
| **properties** | user, agreed in chat | arithmetic and logic slips ("categories always add up to the total") |
| **fuzz** | kernel | hangs; out-of-scope behaviour changes and validation regressions on boundary inputs nobody typed |
| **traces** | kernel, from real use | drive-by edits to functions the request was not about |
| **goals** | user, this turn | "did it do what I asked?" (the most unique catches) |

The results across three configurations, on 238 mutants that change observable behaviour:

| configuration | all layers | safety layers only | machinery needing nothing from the user |
|---|---|---|---|
| as written | 96% | 89% | n/a |
| + fuzz layer | 97% | 90% | 73% |
| + the 2 examples a coverage-enforcing kernel would ask for | **100%** | 92% | 75% |

Two takeaways:

- **Machinery catches about three quarters.** That covers static checks, invariants, fuzzing and replay of real use:
  stray writes, hangs, and edits to unrelated functions. It cannot know what the user wanted.
- **The user's confirmed examples carry the rest.** Every miss in the first round traced back to a gap in the
  contract, not in the gates:
  - a new function (`setBudget`) that no example called, where even an infinite loop in it passed every check;
  - a boundary the user stated in words ("zero or less") but no example tried (0).

  So the kernel should:
  - make the model end each change by proposing concrete examples, including the boundaries the user's words imply;
  - count only the examples the user confirms;
  - refuse "done" while a function in scope is uncovered. The kernel reports this automatically.

## What's here

```
prototype/
  src/world.ts          the live "image": late-bound functions + JSON state in a node:vm realm; redefinition is live
  src/store.ts          revisions + atomic CURRENT pointer + journal + traces of real use (after Jiti's store)
  src/gates.ts          the seven layers, each runnable alone; scope-aware trace replay; fuzz; coverage report
  src/kernel.ts         develop / execute / preview / rollback with generations and checkpoints (after Jiti's loop)
  src/scenario.ts       the expense tracker in 8 turns: what the user said, the change, confirmed examples, real use
  src/demo.ts           grows the app, shows what is refused, recovers in a fresh process, rolls back
  src/mutation-eval.ts  the mutation study
  src/tamper-check.ts   can a proposal neuter the checks? (it could; now it can't)
  results/              demo output, three rounds of the study (markdown + per-mutant JSON), tamper check
```

Run it (Node 22.6+ and no dependencies):

```sh
cd prototype
node --experimental-strip-types --no-warnings src/demo.ts
node --experimental-strip-types --no-warnings src/mutation-eval.ts                 # about 2 min
CONTRACT=fixed EVAL_TAG=fixed node --experimental-strip-types --no-warnings src/mutation-eval.ts
```

## How the kernel works

It follows Jiti's design, translated to JavaScript:

```
observe -> model proposes {intent, scope, forms, examples}  (tagged with the generation it saw)
        -> generation check (stale proposals refused)
        -> build candidate world: live functions + state, then the forms
        -> gates: static, invariants, ratchet, properties, fuzz, traces, goals
        -> all safety layers pass?  accept: publish a revision, examples join the contract, generation++
           otherwise:               the live world is untouched
execute(expr) -> traced call -> invariants on the new state (undo if broken) -> record trace -> revision if data changed
```

- **Live, no compilation.** Functions are top-level declarations in one `node:vm` context. Calls go through global
  names, so redefining `cents` changes what `total()` computes on its next call. That is the same late binding that
  makes Lisp images live, and JS has it too.
- **Checkpoints and revisions.** Every attempt runs on a candidate built from a snapshot. Accepted changes publish an
  immutable revision and atomically swap `CURRENT`. A fresh process recovers it with the whole contract. Rollback
  publishes an old revision as a new one, so history is kept.
- **Scope makes use-replay decidable.** Each proposal declares which functions the request is about. When a recorded
  real call would now behave differently:
  - if the call involves a function in scope, the diff is *surfaced* to the user ("`total()`: 59.75 → 59, confirm?");
  - otherwise it is rejected;
  - edits to functions outside scope must replay every trace identically on the old world plus just those edits.
- **Fuzzing has two outputs.** A *blocking* one covers hangs, out-of-scope changes and validation regressions
  against the accepted version. An *advisory* one reports inputs that would corrupt state where the accepted version
  allowed that too. Advisories found two real gaps in the code I wrote as the model's answers: `addExpense(1, 2.5)`
  passes validation with a numeric category, and `setBudget` accepts `NaN`.

## Findings beyond the numbers

- **A "function" can carry top-level statements.** A form of `function helper() {...}` followed by
  `Array.prototype.every = () => true` was accepted. It made every invariant check pass, and it left the live world
  different from the stored revision, because only declarations are stored. Two fixes: forms may only declare
  functions, and the realm's intrinsics are frozen so function bodies can't tamper either
  (`results/tamper-check.txt`). The general rule is that **the checks must not share mutable machinery with the code
  they check.**
- **Rollback of code can silently roll back data.** Like Jiti, a revision holds code and managed data together. The
  demo's rollback to "before notes existed" also dropped the expense recorded with a note. Code identity and data
  identity probably want to be separate, with explicit migrations (see the next section).
- **Examples must observe both the value and the effect.** The one survivor in round 3 drops `return amount;` from
  `setBudget`, because my added example checked the state and ignored the return value.
- **Self-graded checks catch nothing by construction.** If the model writes the expectations from its own code, a
  wrong program passes its own tests. Jiti's ADR 0008 makes the caller own acceptance for this reason. Here the model
  may *propose* examples, but they count only once the user confirms them.

## Lessons that transfer from building a self-modifying agent harness

A sibling experiment built a durable agent harness that writes and hot-installs its own tools, on
[pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable),
[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)-style memory and
[celld](https://github.com/denoland/celld)-style cells. Several of its lessons apply directly here:

1. **Separate code identity from state identity.** celld's Worker Loader loads code under a version id, and a
   *facet* gives that code a SQLite database keyed by name, so state outlives code versions. A grown app would do
   better to version functions and data on separate lines: rollback of code keeps data, and a change that alters data
   shape must carry a migration that is verified on a copy of live state. celld's README warns about exactly this:
   state is not migrated, "so an object can keep a value that the new configuration rejects. The failure then looks
   unrelated to the change."
2. **Exactly-once effects through an id stored with the effect.** If a chat client retries an `execute` after a crash,
   the effect must not apply twice. Writing the request id in the same transaction as the state change makes a retry
   return the original result. Jiti avoids the problem by never replaying, but a chat UI that retries needs this.
3. **The kernel must be out of the model's reach, and install order is a security boundary.** In pi-durable, a later
   extension's same-name tool replaces an earlier one, so agent-written tools could shadow the kernel's unless the
   kernel is installed last. The tampering finding above is the same class of bug.
4. **The chat is the change log.** OptChat keeps every message forever and lets the agent zoom from a summary to the
   verbatim message. Store, with each revision, the log index of the user's words that asked for it. "Why does
   `topCategory` break ties alphabetically?" is then one lookup away, however long the chat gets. OptChat's compactor
   ranks the user's own words highest for the same reason this kernel makes confirmed examples the contract: they are
   the only ground truth.
5. **Keep the prompt prefix stable as the app grows.** pi-durable announces new tools as positional system messages,
   rather than rewriting the head of the prompt, so provider caches stay warm. A kernel that tells a model its function
   catalogue should append catalogue changes in the same way.

## Limits

- The mutants are first-order syntactic slips. A model's worst failures are coherent programs that do the wrong
  thing; only user-confirmed examples catch those.
- There is one scenario (8 turns). The "is this mutant equivalent?" oracle is a differential test over about 60
  generated states, not a proof.
- No model API key was available, so the scenario's proposals stand in for model output. The chat loop is the same
  one Jiti runs: a model calling `develop`, `execute`, `preview` and `rollback` as tools against `observe()`. It is
  described here, not run.
- `node:vm` with frozen intrinsics and a timeout is cooperative isolation. Hostile code needs a process or isolate
  boundary, as Jiti's README also says.
