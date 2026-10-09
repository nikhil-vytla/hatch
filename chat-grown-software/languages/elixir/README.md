# Elixir / Erlang (BEAM) port of the live kernel

A kernel for chat-grown software that speaks the JSON-lines protocol (`../PROTOCOL.md`) and grows the 8-turn expense tracker. It passes `node --experimental-strip-types --no-warnings bench/conformance.ts elixir`: **51/51 checks**, develop avg 51 ms, start 273 ms.

## Layout
- `lib/hatch/world.ex` the kernel (GenServer): observe, try, develop with five gates, execute (exactly-once), rollback, why, persistence.
- `lib/hatch/sandbox.ex` allowlist check on the AST, compilation, isolated execution (process per evaluation, heap limit, 1 s kill).
- `lib/hatch/cmp.ex` outcome equality and the three scenario invariants. `lib/hatch/cli.ex` stdin/stdout loop.
- `setup.sh` (deps + escript), `run.sh <data-dir>`, `reference.json` (8 turns + 6 probes), `prompt.md`, `showcase/`, `NOTES.md`.

## Form convention
One `def`/`defp` per form. Every function takes the state (string-keyed map) first; reads return a plain value, writes return `{value, new_state}`; throw with `raise`. See `prompt.md`.

## The gates
static (AST allowlist + compiler; catches missing functions), ratchet (all confirmed examples), invariants, traces (replay every recorded execute), and the language layer **beam**: sandboxed evaluation plus live state migration. Probes are refused at: side_effect (static), calls_missing (static), breaks_ratchet (ratchet), breaks_invariant (ratchet, invariants), loops (ratchet, traces; 2 s of timeouts), breaks_trace (ratchet, traces).

## Language layer: hot code loading with state migration
Each accepted change recompiles the app as module `Hatch.App` and loads it over the running version; the previous version stays loaded as old code (`:erlang.check_old_code`), the BEAM mechanism for hot upgrades. The new optional `develop` field `migrate` (a `def migrate(state)` form) is the `code_change` of this kernel: the live state, the confirmed examples and the recorded traces are all carried through it and every gate runs on the migrated data. `showcase/live_migration.exs` (transcript in `showcase/transcript.txt`, regenerate with `showcase/run.sh`) applies "store amounts as integer cents" to a world under load from 4 client processes:

- a bad migration (truncating dollars) is refused by the invariants and traces gates; world, module version and state unchanged;
- the correct migration is accepted in ~100 ms; amounts become integer cents, the module version changes, the old version stays loaded;
- 179 execute requests, 0 failed, no client saw `total()` go backwards, and the cents in state equal seed + every acknowledged add;
- `over_budget` and `top_category` (outside the change's scope) keep returning identical values on migrated before-states, which the traces gate verifies;
- rollback across the migration is refused (no down-migration), which is the honest answer.

Limits: develop runs inside the GenServer, so executes queue for ~100 ms while a change is gated (no failed requests, but not lock-free); `laws` are ignored; traces keep full before-states.

## Findings
- The BEAM made isolation cheap: a fresh process per evaluation with `max_heap_size` and `Process.exit(pid, :kill)` is a few lines and handled both `loops` and memory blowups.
- The static story is weaker than the runtime one: Elixir's metaprogramming means an allowlist has to reject every non-alias receiver (`m.cmd`), `apply`, macros and attributes, so forms look restricted to model authors (no `e.amount`).
- Behaviour-preserving migration is where the existing gates shine: unchanged values on migrated traces are exactly the evidence that a representation change is safe.
