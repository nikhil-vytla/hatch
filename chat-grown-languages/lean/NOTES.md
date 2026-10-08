# NOTES (Lean 4 port)

## Approach
- Tried (a) first and it worked first time: `Kernel.lean` is a Lean program that imports `Lean`, holds an `Environment`
  (Init + `Chat.Prelude`), elaborates each form with `IO.processCommands` (`Elab.async false`), and runs it with
  `Environment.evalConst` (IR interpreter). No `lean` subprocess, no host process. (b) was never needed.
- Needed: `supportInterpreter := true` on the exe, `enableInitializersExecution` (so `unsafe def main`), `evalConst` behind
  `@[implemented_by]` of an `unsafe def`. `import Lean` is only in the kernel; user code sees Init + `Chat.Prelude` (which imports only `Lean.Data.Json`).
- Redefinition: Lean envs cannot replace constants, so each candidate is rebuilt from the base env: forms are dependency-ordered
  (by identifiers mentioned), and a prefix of unchanged forms reuses the cached env per step. Late binding therefore means
  dependents are re-elaborated against the new definition (a type change in a callee = static error in the caller).
- Calling convention: every `def f (s : State) ...` gets a generated `def __call_f := Fn.run @f` (typeclass-driven JSON
  decode of args / encode of result, `Except String (R × State)` = may throw/mutate, bare `R` = query). `@f` matters: plain `f`
  makes Lean fill in `(note := none)` and the arity silently drops the optional arg.
- Gates: static (Lean parser: exactly one `def`/`theorem` command; keyword/identifier denylist; attribute allowlist; elaboration
  errors incl. unknown identifiers; `collectAxioms` rejects sorryAx / ofReduceBool), termination (the elaborator's own error,
  reported as layer `termination`), ratchet, invariants (on JSON), traces, proof (laws).
- Laws: `check` is one or more `theorem`s, elaborated in the candidate env, axioms audited, the last one must mention an app function.
  Laws accumulate in the world and ALL are re-checked on every develop; a law resubmitted under the same name replaces the old one.
  Rollback restores the revision's laws with its code.

## Money
`Int` cents in the app, JSON number <-> cents at the boundary with exact decimal arithmetic (`JsonNumber` mantissa/exponent,
round half up = JS `Math.round`). Floats make proofs impossible; with cents `omega`/`simp` close goals. Cost: sub-cent inputs are
quantised (0.001 -> 0 cents -> invariant violation); `Money` as an `abbrev` broke `omega` (it does not unfold it) so the type is plain `Int`.
Consequence: the "round to cents" turn 4 needs no behavioural change; the reference only refactors `total` via `sum_cents` and
proves `total` is the exact integer sum. Turns 1-3 already behave as turn 4 asks.

## Things that failed / learned
- `abbrev Money := Int`: omega "no usable constraints". Dropped.
- Proof of top_category via `foldl` with a stateful `pick_max` was a mess; a right-recursive `best_of` (ties keep the earlier = alphabetically first key) has a 25-line induction proof.
- `Task` cannot be killed: a call over 1 s is reported as timeout and the dedicated thread is abandoned (burns a core until the kernel exits). Termination checker catches `loops`; `partial` is banned; terminating-but-huge loops hit this path.
- A queried function cannot throw (pure `R`); to throw it must return `Except String (R × State)`. So the `breaks_trace` probe changes `top_category`'s type; it is
  refused by ratchet + traces + proof layers (all gates run and report, none short-circuits except after a build failure).
- Deliberate tightening: strict arity (extra args error), `set_budget` rejects negatives (JS wouldn't throw but the invariant forbids it), a rollback is refused when
  recorded traces call the newer arity (add_expense with a note) - allowed by the harness.
- Execute also refuses a result that breaks an invariant.
- Empty state keys: output omits empty `expenses`/`budgets` unless the input state had the key (matches JS `state.expenses ||= []` behaviour on the scenario).
- Proof repair is real: the turn-3 proof (`simpa [by_category, total]`) breaks when turn 4 refactors `total` into `sum_cents`; the kernel rejects until the law is restated (showcase part 2).

## Measured (4 cores, warm .lake)
start 0.3-0.7 s (import Init+Prelude, `loadExts`; restart with 8 turns of forms ~0.6 s); develop 45 ms (turn 1) .. 930 ms (turn 8), avg ~340-370 ms,
growing with the number of laws re-proved (8 theorems+lemmas re-elaborated per develop; ~60-80 ms each); try ~30-100 ms; execute < 5 ms; probes 0-800 ms; full conformance ~8 s.
Cold `setup.sh` (lake build of prelude + kernel): ~14 s.
