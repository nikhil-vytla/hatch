# strive — Architecture (vNext)

Two layers plus a policy boundary. Everything promotion-era (generation
ledger, revision mirror, dual-write/parity, reader canary, `AcceptancePolicy`
gate, evidence/selection envelopes, migrations) is deleted; see
`docs/archive/` for the historical design and
`docs/adrs/0008-vnext-substrate.md` for the reset.

```
strive/
├── substrate.py   run-scoped event/CAS substrate + composite state + verify()
├── policy.py      AdaptationPolicy / SurfaceStrategy protocols, commands, catalog
├── kernel.py      result-driven, resumable command loop + the floor
├── cli.py         `strive` — run / status / view / history / inspect / revert /
│                  repair / sandbox
├── policies/      policy packages (code + TOML config + versioned prompts)
│   └── manual_change.py / manual_change.toml / prompts/manual_change_refine@1.md
├── cas.py framing.py codec.py   content-addressed store + framed journal + codec
├── sandboxes.py sandbox_backends.py sandbox_launcher.py sandbox_guards.py
│                  the secure CandidateExecutor boundary (ADR-0007)
├── tasks.py evaluate.py budget.py model.py   task data, scoring, budgets, adapters
```

## The substrate (`strive.substrate`)

One artifact root holds many **runs** without collision: a content-addressed
object store shared at `<root>/objects`, and per run an append-only,
crash-framed, hash-chained event stream at `<root>/runs/<run_id>.events`.
Together they are the SOLE harness state.

- **Composite state.** `HarnessState` is a canonical set of `SurfaceBinding`
  `(kind, name) → content_ref`. A `CompositeChange` is coupled per-surface
  `SurfaceDelta(before_ref, after_ref)`; `apply_change` applies it exactly
  and `invert()` reverts it exactly.
- **Events.** Every event is an `EventEnvelope`: a stable id
  (`<run_id>#<seq>`), run/task scope, the command that CAUSED it, a monotonic
  seq, a timestamp, and a CAS ref to a typed body. Authority bodies
  (`PolicyBound`, `ChangeApplied`, `ChangeReverted`) move state; observations
  and annotations never do; command bookkeeping
  (`PolicyCommandIssued`/`Completed`, `PolicyCheckpointed`, `OperationFailed`)
  makes the kernel resumable.
- **Verification.** `verify()` parses the whole stream into a
  `VerifiedSubstrateView`: framing integrity; exactly-one leading
  `PolicyBound`; full CAS closure; canonical/allowlisted/existing bindings;
  an EXACT apply/revert replay (before equals the prior state, the change
  decodes, deterministic application equals the recorded after ref, and the
  effect cites a command); command lifecycle with one terminal completion and
  one payload digest per command id; checkpoint state agreement; observation
  subjects; and change-id uniqueness. Any structural or semantic error makes
  the view `ok=False`, and every authority append is REFUSED. Recovery is
  explicit (`repair`): a torn/forged tail is quarantined and truncated to the
  last verified frame; a semantically-invalid-but-intact log is refused, not
  auto-quarantined.

## The policy boundary (`strive.policy`)

One active `AdaptationPolicy[Config, State]` owns timing and lifecycle;
`SurfaceStrategy` objects analyze immutable `RunView`s and propose (never
mutate). The lifecycle is result-driven:

```
command = policy.next_command(config, state, view)   # None => done
result  = kernel runs & journals the single command
state   = policy.reduce(config, state, result)
```

Commands are a small closed vocabulary — `RequestRefinement`, `ApplyChange`,
`EvaluateFork`, `ScheduleTrigger`, `ConfirmChange`, `RevertChange`,
`StopAdaptation` — each with a run-scoped unique `command_id` bound to one
canonical payload digest. `EvaluateFork` is how a policy requests comparative
evaluation. The catalog is injected and immutable (no import-time
registration); descriptor config loaders and prompt slots are authoritative
and conformance-tested.

## The kernel (`strive.kernel`)

The only mutator. Per command it journals exactly one intent, performs or
RECONCILES exactly one effect, journals exactly one terminal result, then
reduces and checkpoints (state + a consumed-result cursor) — never advancing
state before the outcome. On restart it reloads the last checkpoint,
re-derives the same deterministic command, and reconstructs the exact
recorded result (so `last_result` can never disappear); an effect present
without a terminal is finished, not repeated; a reduction not yet reflected
in the checkpoint happens exactly once.

The kernel enforces the floor: bound identity is authoritative (a caller
whose config/prompts/seed disagree with `PolicyBound` is rejected); trusted
budgets charge executions/model-calls; candidate code runs under the secure
`CandidateExecutor` with declared, capability-checked, exactly-recorded
`SandboxProvenance` (capability-equivalent backends allowed); a change's full
CAS closure is staged and required before apply; and `EvaluateFork` captures
exact base/candidate state refs BEFORE execution and records both even if
active state later advances.

## The secure executor (ADR-0007, unchanged)

Candidate code executes only through `CandidateExecutor` over a pluggable,
capability-declaring `SandboxBackend` (`process-fault-only@1` for trusted
fixtures; `deno-pyodide@1`, the shipping secure WASM boundary). Provenance
(exact runtime digests) is recorded as reproducibility metadata.
