# HANDOFF — strive (vNext)

## Current: vNext Phase A (corrected), on branch `strive-vnext-phaseA`

Strive is a policy-neutral, revision-native mechanism substrate plus a
result-driven, resumable policy kernel. Comparative evaluation is an optional
mechanism a policy requests, never a universal activation gate. This corrects
the first Phase-A PR (run-scoping, semantic verification, the result-driven
lifecycle, the floor, a usable CLI, and a stronger proof).

### Modules

- **`strive.substrate`** — one artifact root, many runs
  (`<root>/runs/<run_id>.events`), CAS shared at `<root>/objects`. Composite
  `HarnessState`; coupled `CompositeChange` (exact before/after, invertible);
  `EventEnvelope` (stable `<run_id>#<seq>` id, run/task scope, `caused_by`,
  timestamp, CAS body ref). `verify()` → `VerifiedSubstrateView` checks
  framing, one leading `PolicyBound`, CAS closure, canonical/allowlisted
  bindings, an EXACT apply/revert replay, command lifecycle + one terminal +
  one payload digest per command id, checkpoint agreement, observation
  subjects, and change-id uniqueness. Authority appends verify first and are
  head-checked; a structural/semantic error refuses mutation. `repair`
  quarantines only a torn/forged tail (semantic corruption is refused, not
  auto-quarantined).
- **`strive.policy`** — `AdaptationPolicy[Config, State]` (`next_command` +
  `reduce`, `decode_state`) and `SurfaceStrategy`; the closed command
  vocabulary; immutable `RunView`; injected immutable `PolicyCatalog` with a
  `conformance_violations` suite.
- **`strive.kernel`** — the result-driven loop: one intent / one effect
  (perform or reconcile) / one terminal result per command, then reduce and
  checkpoint (state + consumed-result cursor). Never advances before the
  outcome; restart reconstructs the exact result. Enforces the floor —
  authoritative bound identity, trusted budgets, sandbox capabilities +
  exact `SandboxProvenance`, CAS closure before apply, and fork base/candidate
  refs captured before execution.
- **`strive.policies.manual_change`** — `manual-change@1`: `policy.py` +
  `manual_change.toml` + `prompts/manual_change_refine@1.md`. Emits
  `ChangeProposed`, uses run-scoped ids, and reacts to fork success/failure
  through the reducer (applies+reverts on improvement; stops otherwise).
- **`strive.cli`** — `strive run/runs/status/view/history/inspect/revert/
  repair/sandbox`.

### Honest scope

`manual-change@1`'s fork scores the **code** surface over the task's cases;
the **prompt** surface is coupled into the same change and applied+reverted
round-trip, but no scorer consumes it yet. A real prompt consumer and a real
model refiner arrive with `continual-refine@1`.

### Verification

- `uv run pytest` — 115 tests: substrate floor + verified view + missing-CAS
  + semantic-corruption refusal + concurrent heads + multiple runs + exact
  revert; kernel happy path + identity/seed mismatch + budget + fork
  success/failure reaction + idempotent re-run + crash after every command
  effect (fork/apply/revert/stop) + fork-crash-without-duplicate-execution +
  crash-before-apply; CLI flow + installed entry point; codec; sandbox.
- `uv run mypy` — clean, `--strict`, over 30 files.
- `uv run strive` — installed console script; verified in tests.

### The Phase-A claim

Strive has a usable, semantically verified, run-scoped event/CAS substrate
and a result-driven resumable policy kernel whose bound configuration,
budgets, sandbox capabilities, commands, effects, observations, and
checkpoints remain exact across concurrency and crashes.

### Next

After review + merge: begin the Prime-Agent / Continual-Harness-style
`continual-refine@1` end-to-end policy (a real model refiner behind
`RequestRefinement`, a real prompt consumer, optional composed fork
evaluation). See `docs/ROADMAP.md`.

The promotion-era handoff is archived at
`docs/archive/HANDOFF-stage1-3c.md`.
