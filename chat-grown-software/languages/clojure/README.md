# Clojure port of the live kernel

A JSON-lines kernel (PROTOCOL.md) that grows the expense tracker in Clojure. Conformance:
`node --experimental-strip-types --no-warnings bench/conformance.ts clojure` -> **51/51 checks pass**,
start ~400 ms, develop avg ~80 ms (1 s for the `loops` probe, which is a real timeout).

## Layout
`run.sh`, `setup.sh` (resolve deps, AOT-compile, jar, AppCDS warm-up; output in ignored `build/`), `deps.edn`,
`src/kernel/{api,walk,core,main}.clj`, `reference.json` (8 turns + 6 probes, with laws), `prompt.md`, `NOTES.md`,
`showcase/` (`demo.clj`, `run.sh`, `transcript.txt`).

## Form convention
One `(defn name [params] body...)` per form. State is an immutable map with string keys (the JSON itself).
`(state)` reads, `(swap-state! f & args)` changes. Throw with `(throw (ex-info msg {}))`. See `prompt.md`.

## The language layer
1. **Code is data.** Each form is read with `*read-eval*` false, must be exactly one `defn`, and its body is walked
   (scope-aware) against an allowlist of clojure.core symbols + app functions + the state API. `def`, `eval`,
   `alter-var-root`, `.`, `new`, qualified symbols (`System/exit`), I/O and unknown names are refused before anything
   runs; unknown function calls are the static `calls_missing` catch. The showcase lists 15 refused sources with reasons.
2. **Persistent state.** Per-call transactions and rollback are "keep the old value". The full history of states
   is kept (derived from traces); the showcase holds 20,001 states in 7.7 MB, where one deep copy of the final state
   costs 4.8 MB. Extra ops `history` and `at` expose time travel.
3. **Stoppable evaluation.** Java 21 removed `Thread.stop`, so the walker rewrites the code: a cooperative deadline
   check is injected into every fn body and loop. Runaway loop: timeout reported at ~1.03 s, no CPU used afterwards.
   Each candidate lives in its own fresh namespace that is dropped when rejected.
4. Laws (property checks as Clojure expressions over 40 seeded generated states) are implemented.

## Gates
static (shape, allowlist, names, compile) -> ratchet -> invariants -> traces -> laws. Probes are refused by:
side_effect, calls_missing = static; breaks_ratchet, breaks_invariant, loops, breaks_trace = ratchet/invariants/traces.

## Caveats
Native calls that never reach a tick (huge finite `reduce`) are bounded only by the 1.5 s wait and an abandoned daemon
thread. See NOTES.md for the full account, latencies, and two small harness observations.

## Second scenario: LLM API gateway
`SCENARIO=gateway` makes the kernel enforce the gateway's 5 invariants (calls/prices/quotas) instead of the expense
ones; `reference-gateway.json` holds the 5 turns. `SCENARIO=gateway node ... conformance.ts clojure` -> 28/28; expenses
still 51/51. `showcase/gateway.sh` records `showcase/gateway-transcript.txt`: a billing audit done by reading the live
code as data (call graph, which functions can change state or depend on prices, a structural diff of `record_usage`
between revisions) plus time travel and a price what-if run on past states without touching the live world.
