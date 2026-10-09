# Notes (Clojure port)

- Form convention: `(defn name [params] body...)` text; state is a string-keyed immutable map read with `(state)`,
  changed with `(swap-state! f & args)`. Chosen over pure `[value new-state]` because helpers call each other
  (`over_budget` -> `by_category`) and a model writes the imperative-looking style correctly first time.
- First try passed 51/51 (after one bug: a timed-out call fell through to `norm` and reported `{value nil}`; conformance
  hid it because the mismatch still refused the probe. Found only by the showcase. Fixed.)
- Timeout design: Java 21 has no `Thread.stop`. Instead the walker injects `(kernel.api/tick)` at the start of every
  fn body, `loop`, `doseq`, `dotimes`; tick checks a per-call deadline and throws a `java.lang.Error` (not catchable by
  the only allowed `catch Exception`). Code runs on a dedicated daemon thread (64 MB stack); the caller waits 1.5 s and
  abandons it if it is stuck in native code. `range`/`repeat` are wrapped with a 10^7 cap, `iterate`/`cycle`/`(range)`
  are not exposed, so the remaining uninterruptible cases (one huge `reduce` over a finite seq) are bounded.
  Measured: runaway loop reports timeout at ~1.03 s, process CPU ~0 ms afterwards.
- Namespaces: every candidate gets a fresh `kernel.appN` namespace holding ALL functions (vars interned first so
  forward refs work), only allowlisted clojure.core vars are `refer`red (defense in depth behind the walker).
  Accepted candidate's ns becomes live; rejected ones are `remove-ns`ed.
- Reader: `*read-eval*` false (kills `#=`), then exactly one form, shape `(defn ...)`. The walker is scope-aware
  (let/loop/fn/for/doseq/if-let/as->/destructuring), rewrites app-name spellings (snake/kebab), rejects qualified
  symbols (blocks `Math/..`, `clojure.core/..`, and reader-generated `clojure.core/deref`, syntax-quote), `.`, `new`, `def`.
- Laws are implemented: checked as Clojure expressions on 40 generated states (seeded), only when cheaper gates pass.
- Gotchas hit/anticipated: `(= 0 0.0)` false (use `==`); `(/ 30 100)` is a Ratio (so `round` returns a double);
  keywords don't work on string-keyed state; `(sort [])` is `()` which serializes as `[]`.
- JVM start: AOT jar + AppCDS (`-XX:+AutoCreateSharedArchive`, needs a jar not a dir on the classpath: a classes
  directory gave "Cannot have non-empty directory in paths") + SerialGC + C1 only. Observed start ~350-410 ms
  (observe round trip), restart with 8 turns of code ~870 ms (recompiles every function). Develop avg 70-120 ms.
- The `loops` probe takes ~1.0 s (one timeout; calls to a function that already timed out are short-circuited in that
  gate run, and laws are skipped once another gate failed). Without that it was 3 s.
- Rollback to rev-0007 is refused by the harness's own trace (3-arg add_expense under the 2-arity code): clean refusal.
- Harness/protocol issues: none blocking. Note `same()` in bench ignores a key named `error` at every depth, so a
  category called "error" would be compared loosely; and the conformance rollback check cannot see the rolled-back path
  succeed for strict-arity kernels (it accepts both outcomes).
