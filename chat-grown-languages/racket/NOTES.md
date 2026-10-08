# NOTES (Racket port)

- Design: one Racket process (`kernel.rkt`), app code in `racket/sandbox` evaluators whose language is `lang.rkt`
  (an allow-list of racket/base + racket/list/string/math/format + `get-state/set-state!/update-state!`). Anything
  not exported (eval, namespaces, ports, files, tcp, subprocess, call/cc, threads, parameterize, require) is unbound.
- Static gate: `read` with reader/lang/compiled/graph disabled, exactly one `(define (name params) body+)`; name not a
  builtin/forbidden; the form is rewritten to a `lambda` and `expand`ed (never run) in a throwaway-free namespace; walk
  the expansion: `(#%top . id)` = free identifier (unknown -> calls_missing, or "forbidden" with the reason if on the
  deny list), `set!` whose target is not `lexical` = refused. Expanding a `lambda` rather than the `define` matters:
  expanding a top-level `define` binds the name in the namespace and later references stop being `#%top`.
- Tried: whole-`define` expansion (leaked bindings, see above); `racket/match` (not needed); a spare pre-built evaluator
  thread (dropped: try and develop usually carry the same forms, so a one-entry candidate cache removes the cost).
- Evaluator cost: `make-evaluator` on lang.rkt = 150-250 ms (first ~160, later ~250 with a warm heap). Per call inside
  an evaluator ~1 ms. Choice: states travel per call (`kernel-run state thunk`), evaluators are stateless, so one
  evaluator is reused for live, for try, and promoted to live on accept; a fresh one is built only for a new code
  signature (cache of one candidate) or after memory-limit death. Timeouts do not kill the evaluator (with-limits kills
  the eval thread only); out-of-memory does, and it is rebuilt lazily.
- Limits: `sandbox-eval-limits '(1 #f)` (1 s per eval), `sandbox-memory-limit 128` (custodian-limit-memory). Observed:
  400M-element `build-list` is killed at ~0.7 s with `out-of-memory`; `(expt 9 (expt 9 9))` raises "out of memory" in
  ~100 ms; `(let loop () (loop))` is killed at 1 s and the evaluator survives.
- Racket specifics learned: `racket/list` in 8.10 has `takef`/`dropf`, not take-while. `null` in Racket is `'()`; JSON null
  is the symbol `'null`. Exact rationals appear easily (`(/ 3 10)`), so output is normalised: exact non-integers -> float,
  void -> null. JSON object keys come in as symbols, so category names need `string->symbol` (stated in prompt.md).
- Gates: static -> sandbox load -> ratchet -> invariants (live state, example results, post-trace states) -> traces
  -> laws (language layer: Racket expressions run on 25 generated states + {}, persisted and re-checked each develop).
  First failing layer is reported (short-circuit; keeps the `loops` refusal at ~1.1 s instead of several).
- Finding (honest): gates only judge what is covered. In my first showcase run a `set_budget` that adds an `admin` key was
  ACCEPTED because no example or trace had ever called `set_budget`; once one trace existed, replay + invariants refused it.
  The sandbox protects the host; the contract protects the data, and only where the user has pinned behaviour.
- Sandbox limits found: `getenv` is not guarded by racket/sandbox (a bare racket/base evaluator returns `$HOME`); here the
  allow-list language has no `getenv`, and the static gate names it. Sandbox output ports are discarded (`sandbox-output #f`),
  so `displayln` cannot forge a protocol line; the kernel also repoints `current-output-port` to stderr.
- Rollback: refused cleanly at the end of the scenario because the recorded 3-arg `add_expense` trace fails under the
  2-arg revision (strict arity). Rolling back a function whose trace is unaffected works (not exercised by conformance).
- Protocol notes: ratchet "supersede" implemented as: earlier example whose functions are all in scope and which has the
  same fixture+calls as a new example with a different expectation. Only successful executes are traced / recorded for
  exactly-once. An execute whose result would break an invariant is refused (nothing committed).
- Measured (conformance run): process start + first observe 310-410 ms; develop avg 112 ms (max ~230 incl. building the
  sandbox once per distinct code); `loops` probe 1.1 s; others < 150 ms. 51/51 checks.
