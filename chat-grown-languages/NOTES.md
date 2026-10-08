# Notes: chat-grown software in five languages

Follow-up to `chat-grown-software/` (a TypeScript kernel where a model grows an app by chat and the user owns the
contract). Question from the user: is TypeScript the right language, why did Geoff Huntley use Lisp for Jiti, and
what do other languages give? Build Clojure, Elixir/BEAM, Pharo Smalltalk, Racket and Lean ports in parallel,
benchmark them with DeepSeek, and record demos.

## Setup (2026-10-08)

- First attempt: the network policy blocked Pharo, Racket's site, Clojars, Hex and Lean releases; apt had Elixir,
  Racket, Clojure. The user widened the policy; then everything was reachable.
- Installed: Elixir 1.14 / OTP (apt), Racket 8.10 CS (apt), Clojure CLI 1.12 (official installer), Lean 4.34.1 +
  Lake via elan, Pharo 12 headless. `get.pharo.org` downloads over plain `http://`, which the egress proxy doesn't
  carry; fetching the same zips over https works.
- Plan: I own the language-neutral parts and quality; five Sonnet subagents each build one kernel.
  - `PROTOCOL.md`: every kernel is a process speaking JSON lines (observe / try / develop / execute / rollback /
    why). Calls are data (`{"fn": "total", "args": []}`), never code, so one driver serves all languages.
  - `scenario/expenses.json`: the 8 turns, now naming the functions in the user's words (the session-4 lesson:
    the simulated user only knows the reference program's names).
  - `bench/reference.ts`: the simulated user = the JS reference program run on neutral calls, each call a
    transaction (a throw restores the state before it).
  - `bench/conformance.ts`: drives a kernel with its own reference forms, then six probes (side effect, ratchet,
    invariant, loop, missing function, trace), stale generation, exactly-once (also across restart), throw
    atomicity, why, code-only rollback, restart.
  - `js/`: a baseline kernel on the old `World`, to validate the harness: 51/51.

## Harness decisions

- Rollback check accepts a clean refusal: strict-arity languages rightly refuse to roll `add_expense` back to the
  2-argument version while a 3-argument trace exists. (Clojure, Elixir and Racket all refuse; JS rolls back
  because JS ignores extra arguments: the permissive language "succeeds" at something questionable.)
- Question generation moved out of the kernels into the driver (model's calls + each state-changing call repeated +
  a call for every uncovered function in scope), so all languages get the same questions.
- Hidden goal check: after each turn, the scenario's own examples run on the live code via `try` and are compared
  with the intended program. The model never sees them. Final regression = all turns' examples against the final
  intended program.
- `same()` ignored an `error` key at any depth; the Clojure agent spotted it. Now only an outcome's top-level
  `error` is ignored.

## DeepSeek baseline (JS kernel)

- expenses: 8/8 turns accepted, hidden goals 20/20, final regression 20/20, 17 develops, 16 corrections, 3.2 min.
- The simulated user's truth includes the reference program's quirks: DeepSeek probed `set_budget("food", -5)`,
  the reference program accepts it, so the user "confirmed" a negative budget, which the invariant then rejected.
  DeepSeek resolved it by refusing negatives (which contradicted the confirmed answer for -5? no: it dropped that
  example). Worth remembering: a simulated user is only as good as its reference program.

- **Simulated-user bug, found by the Racket run:** at turn 1 DeepSeek added validation early and proposed
  `add_expense(-5, "food")`. The turn-1 reference program stores -5, so the user "confirmed" a state that breaks
  the user's own `expenses-shape` invariant, which the kernel enforces from the start: no code could satisfy both
  (the JS run's negative-budget episode was the same bug). Fix: the user's invariants hold from the first turn; when
  the intended program would break one, the user answers that the call should fail. All earlier DeepSeek runs were
  discarded and re-run with the fixed user. (Also: `pkill -f grow.ts` inside a command line that contains
  "grow.ts" kills its own shell; use `pkill -f "node.*grow[.]ts"`.)

## Gateway scenario (second scenario, "old language, modern problem")

- LLM API gateway in 5 turns: `record_usage/usage`, `set_price/cost` (cents per 1K tokens, dollars out),
  `set_quota` + quota enforcement, input validation, `top_spender`. Five invariants including `within-quota`.
  Reference in `scenario/gateway.reference.js` (snake_case JS, used directly by the simulated user).
- DeepSeek on JS: 5/5 accepted, hidden goals 17/19, final regression 19/19, 11 develops, 2.4 min. The two
  misses were intermediate: after turn 1, `usage("nobody")` on `{}` left `{calls: []}` behind (a read that
  writes), and turn 3's `set_quota` on `{}` differed the same way. No question covered an empty state, so the user
  never saw it; later rewrites fixed both by accident. The question rules could add the empty fixture for every
  function in scope.

## Port status (verified by re-running conformance myself)

- Clojure: expenses 51/51, gateway 28/28. Elixir: 51/51, 28/28. Racket: 51/51 (gateway in progress).
- Elixir caps recorded traces (`HATCH_MAX_TRACES`, default 1000): without it `world.json` grew quadratically
  under load (every trace stores its full before-state). The cost: the traces gate then replays only recent use.
  Same trade-off any real system makes; a content-addressed state store (Clojure's structural sharing, on disk)
  would avoid it.

## Benchmark metric

- "Turns accepted" undercounts good behaviour: in the Clojure expenses run, DeepSeek made no change at turn 5
  ("reject zero or less") because its turn-1 `add_expense` already validated, and the hidden goal checks pass.
  Primary metric: hidden goal checks (per turn) and final regression; cost metrics: develops, load errors, user
  corrections, tokens, minutes. Three repetitions per language and scenario, since single runs are noisy.
- First runs with the fixed simulated user: corrections fell from 16 to 5-6 per expenses run (the old user was
  "correcting" toward invariant-breaking answers).
- **Output cap:** the DeepSeek adapter capped responses at 8000 tokens. Lean's first run hit it on turns 6 and 7
  (DeepSeek reasons at length before writing Lean, then the reply is cut before any tool call): 0/3 goals on both
  turns. Clojure hit it once too. Raised to 32000 (`DEEPSEEK_MAX_TOKENS`), discarded every run so far (kept in
  scratch, not committed), and re-ran all languages x 3. `summary.json` now counts `max_tokens_hits`.
  Discarded first-run numbers, for the record (8000 cap): goal checks expenses js 20/20, clojure 20/20, elixir 20/20,
  racket 17/20, lean 14/20; gateway js 18/19, clojure 19/19, elixir 19/19, racket 19/19.
