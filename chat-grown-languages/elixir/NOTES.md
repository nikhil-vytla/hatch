# NOTES (Elixir/BEAM port)

## Design
- mix project + Jason, built as an escript (`_build/hatch`, setup.sh) so `run.sh` is `exec escript`. Kernel is one GenServer (`Hatch.World`); every op is serialised through it, each execute is one transaction.
- Form convention: every function takes `state` (string-keyed map) first; reads return a plain value, writes return `{value, new_state}` (a 2-tuple is never a JSON value, so it is unambiguous). Throw = `raise`. Chosen over "everything returns {value, state}" so read functions and cross-calls (`by_category(state)` inside `over_budget`) stay plain.
- Static gate: `Code.string_to_quoted`, each form = one `def`/`defp` (clauses of one name allowed), AST walked with an allowlist (Kernel Enum Map List String Float Integer Keyword MapSet Tuple Range :math). Rejected: other modules, atom/variable receivers (`m.cmd`), `apply spawn send receive self import @attr String.to_atom`, nested defs, names that shadow Kernel. Missing local functions are caught by the compiler (undefined function) = `calls_missing`.
- Isolation: compile, every call-list, every migrate run in a fresh process (`spawn_opt`, `max_heap_size` 30M words with kill), 1 s timeout, `Process.exit(pid, :kill)`.
- Live code is module `Hatch.App`; candidates compile as `Hatch.Cand.C<n>` (gates run there, then purged). On accept the same sources are recompiled as `Hatch.App`, which hot-loads over the previous version (old stays as "old code" until the next load purges it).
- Persistence: `world.json` (atomic rename) after every change, holds revisions with full function snapshots, examples, traces, request_id results. Restart recompiles `Hatch.App` from it.

## Language layer: live state migration (optional `migrate` in develop)
`migrate` = one `def migrate(state)` form, compiled into the candidate only. Gates then run on migrated data: live state, earlier examples (fixture and expected state), recorded traces' before-states are all passed through it; invariants are checked on the migrated live state and on every resulting state. Crash in migrate = layer `beam`. On accept the contract (examples, traces) is stored migrated. Examples in the migrating request are in the NEW shape. Showcase: 4 clients, 179 executes, 0 failures, bad migration refused, good one accepted in ~100 ms. Rollback across a migration is refused (traces give different values): no down-migration.
Limits: develop holds the GenServer, so executes queue ~100 ms during a swap (not a lock-free upgrade); traces store the whole before-state (O(n^2) file growth).

## What I tried / learned
- OTP 25 has no JSON; Jason via hex works (proxy ok).
- First run: rollback crashed on `nil or ...` (Elixir `or` is strict boolean). Use `||`.
- `loops` probe took 6 s because every ratchet example and trace that calls `total` timed out (1 s each). Now each layer stops at its first failure: 2 s.
- `spawn_opt` is not auto-imported in Elixir (`:erlang.spawn_opt`).
- `~S|..|` sigils die on `|>`; pipes inside test strings need heredocs.
- `x.field` on a variable is a runtime remote call if x is an atom (`m = :os; m.cmd`), so all non-alias receivers are rejected, which also bans `e.amount` (models must write `e["amount"]`).
- `laws` are ignored (allowed by protocol).
- Superseding: an older example is dropped only if all its fns are in scope and a new example asks the identical (fixture, calls) with a different expectation.

## Measured
start (first observe, empty world) 230-290 ms in conformance, 330-400 ms wall for `run.sh` incl. exit; restart with 8 functions 600-850 ms (recompiles Hatch.App); develop avg 50 ms (30-100); try ~30 ms; loops probe 2 s.
Conformance: 51/51.

## Gateway scenario (SCENARIO=gateway)
- `Hatch.Invariants.check` switches on env SCENARIO: gateway enforces calls-shape, prices-shape, quotas-shape, within-quota, known-keys. Forms in `reference-gateway.json`. `SCENARIO=gateway` conformance: 28/28; expenses still 51/51.
- Showcase `showcase/gateway.sh` -> `gateway-transcript.txt`: 5 clients, ~500-640 requests, 0 unexpected failures, quotas/validation/aggregation-migration deployed live; swap windows 75-220 ms (requests queue behind develop). My first quota example was wrong (1200+500 < 2000) and the ratchet gate refused the deploy: the gates catch the demo author too.
- Traces are now capped to the most recent HATCH_MAX_TRACES (default 1000; showcase uses 40) because world.json is rewritten per execute and before-states are full copies.
