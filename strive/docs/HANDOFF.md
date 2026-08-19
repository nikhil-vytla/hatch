# HANDOFF — strive (vNext)

## Current: vNext Phase A (hardened), on branch `strive-vnext-phaseA`

Strive is a policy-neutral, revision-native mechanism substrate plus a
result-driven, resumable policy kernel. Comparative evaluation is an optional
mechanism a policy requests, never a universal activation gate.

### Intent-to-effect binding pass (what changed since the last review)

- **Durable command intent is explicit and typed.** `CommandPayload` is now a
  NEUTRAL, normalized record — not an opaque JSON blob — carrying every
  consequential field (target change id, change ref, `expected_state_ref`, the
  fork's `issue_state_ref`, prompt role/context, trigger delay, stop reason).
  Verify binds each effect to exactly what the command named: Confirm/Revert
  target the change the command names, and an Apply/Revert effect must satisfy
  the ISSUED `expected_state_ref`, not merely the folded state at effect time.
- **Fork evidence is derived from the issued states.** The base state is
  anchored to the state ref recorded at issue; the candidate state is recomputed
  by applying the issued candidate change to that base; every attempt
  dispatch/result and the summary subject must equal those exact refs; and
  `improved` is recomputed (`candidate.overall > base.overall`), never trusted
  as asserted.
- **Every terminal reconstructs exactly.** ok/failed/indeterminate ALL require a
  typed `StoredResult` (no `result_ref=None` fallback); verify matches its
  id/kind/outcome, proposal/observation refs, metrics, usage, and the exact
  pre-terminal SEMANTIC head (`"<seq>:<state_ref>"`). A failure recorded before
  a crash is RECONCILED into a terminal with the same outcome — the operation is
  never re-run — and a legal partial prefix admits at most one failure/effect.
- **Live budget == durable ledger.** After every terminal/reconciliation the
  meter is rebuilt from the durable attempt ledger before the policy may emit
  the next command; an indeterminate dispatch reserves executions AND wall AND
  output immediately, in-process and after restart.
- **Full execution evidence is preserved.** Each `AttemptRecord` references the
  exact `ExecutionReport` (per-case outputs/errors, backend failure,
  wall/output) and `Evaluation` (per-case scores) — a completed evaluation with
  candidate errors is distinguished from a sandbox/infra failure, neither
  collapsed to only an aggregate score. `CandidateExecutor` preserves the actual
  backend wall/output (fixed earlier).

### Command/attempt state-machine pass (earlier in this PR)

- **Each command is a CLOSED state machine.** `verify()` now checks the exact
  per-kind + per-outcome effect grammar: ApplyChange(ok) = a matching proposal
  + one apply; RevertChange(ok) = one exact revert; EvaluateFork(ok) = proposal
  + base dispatch→result + candidate dispatch→result + a matching summary;
  ConfirmChange(ok) = one confirmation; Schedule/Stop = no state effect. A
  failed/indeterminate command requires exactly one failure record and NO
  success effect. Effects before intent, effects after terminal, missing/extra
  effects, a successful terminal without a `StoredResult`, and a duplicate
  checkpoint are all rejected; a checkpoint must follow one terminal, consume
  its command exactly once, and reference the exact reduced state.
- **Typed command/result semantics.** `CommandPayload.json`, `ConfigBlob.json`,
  and `PolicyStateBlob.json` must be canonical JSON; a `StoredResult`'s id,
  kind, outcome, proposal ref, observation ref, and metrics must match the
  command's actual effects; the full `expected_state_ref` stays in the durable
  command identity; and the initial and reconstructed results (incl. the fork
  observation ref) are byte-for-byte equivalent.
- **Verified fork-attempt lifecycle.** Per `(command_id, label)`: exactly one
  dispatch then at most one result, no result without a dispatch, no duplicate
  labels, base before candidate; dispatch/result `state_ref` must equal the
  observation's `subject_state_ref`; a summary must equal the two durable result
  records and the issued candidate change; actual attempt provenance must
  satisfy the run's pinned capability profile; and every `BudgetUsage` field
  (incl. reservations) must be finite and nonnegative.
- **Honest budget dimensions.** An open dispatch reserves executions AND wall
  AND output (not executions alone). `CandidateExecutor` no longer zeroes
  backend wall time or derives stdout bytes from error strings — it preserves
  the ACTUAL captured wall/output/failure, and cumulative output across cases
  is enforced from real captured bytes.
- **Pinned evaluation + policy package.** The task fingerprint now includes the
  case-selection rule and the aggregate evaluator (not only `score_case`); a
  `PolicyDescriptor` may declare `dependency_modules` folded into the pinned
  policy digest (an explicit policy-package manifest).

### Semantic-atomicity pass (earlier in this PR)

- **No append can turn a valid run invalid.** Every authority append runs a
  PURE candidate-event preflight (`_fold_view` over the resulting stream) and
  is refused unless the POST-event view is fully valid; a refused append leaves
  the journal byte-for-byte unchanged (only an orphan CAS body may remain).
- **Runtime records are a neutral, closed contracts module** (`strive.runtime`)
  imported directly by the substrate — verification no longer depends on kernel
  import order (proved by a fresh-interpreter test). Verify decodes each ref as
  its EXPECTED type and matches command id/kind/outcome/encoding; requires ONE
  proposal per change id; and matches an applied/forked change to BOTH its
  proposal and its issued command payload's `change_ref`, not a kind string.
  `OperationFailed.command_id == caused_by`; confirm/revise must target an
  existing change and revised refs must decode.
- **Mutation is confined to the run's PINNED surface set.** A run may only
  touch surfaces pinned in its `PolicyBound`, resolved + validated through the
  pinned descriptors even for content already in shared CAS. Growing the live
  catalog keeps old runs READABLE, but mutating a newly-added surface needs an
  explicit rebind/new run.
- **Command preconditions are durable.** `expected_state_ref` is part of the
  command's durable identity (a changed precondition is a changed command and
  fails closed); the manual policy derives it from the STABLE seed-state ref,
  not whichever state exists after a crash.
- **Attempts + budgets are truthful at every crash point.** A fork journals
  each base/candidate DISPATCH then RESULT separately; an open dispatch (result
  never written) is reconciled as `indeterminate`, never implicitly re-run.
  Failed/partial attempts still record actual provenance/failure/denials/usage.
  The meter is REBUILT fresh from the durable per-attempt ledger on every entry
  (no repeated absorption into a reused `KernelServices`); wall is cumulative
  active time; output is enforced cumulatively across cases (each case's cap is
  the remaining allowance).

### Correctness pass 2 (earlier in this PR)

- **Verification is closed AND deep.** Every envelope's run AND task scope is
  checked; a duplicate intent is rejected even with the same digest; every
  effect/annotation/terminal/checkpoint must cite an ISSUED, compatible command
  in valid order; every referenced ref (command payload, result, policy-state,
  observation, proposal, config, budget, prompt, surface, state) is
  decoded/hash-verified, not merely `has()`-checked; proposal/change ids agree
  with their refs; a revert must follow one unreverted apply and equal its
  EXACT inverse; a checkpoint's cursor must name a command whose terminal it
  reduced. Verification stays pure and exposes no state on error.
- **Run discovery is crash-safe.** `PolicyBound` is authoritative; the
  `<run>.binding.json` index is a DERIVED cache. `ensure_binding`/`discover`
  rebuild it after a crash between the event and the index write, cross-check
  its `run_id`, and quarantine a divergent index rather than invalidating a
  valid event stream. `bind_policy` preflights every bound ref + seed invariant.
- **Command exactness + concurrency.** An exclusive per-run advisory LEASE
  stops two processes executing one run concurrently; a same-id/same-digest
  issue is an idempotent read (no second intent); the initial and reconstructed
  `CommandResult` (including `head`) are identical (the command's canonical head
  is a stable pre-terminal point); `expected_state_ref` is a LOGICAL
  harness-state precondition (robust to intervening non-state events) that is
  part of the command's durable identity (a changed precondition is a changed
  command and fails closed).
- **Honest budgets/effects.** Per-command usage (including failed/partial) is
  persisted in the terminal result and re-seeded from EVERY completed command
  on restart — no reset, no double-absorption; sandbox limits are capped by
  remaining wall/output budget; a fork records its base and candidate attempts
  SEPARATELY with actual provenance, failure, denials, usage, and state ref; a
  dispatch with no recoverable durable result is recorded `indeterminate` and
  requires an explicit retry (never a silent re-dispatch).
- **CAS + extensibility hardened.** `put_text` verifies a preexisting object
  (corruption is loud); invalid UTF-8 is `ObjectCorruption`; a change's
  referenced surface artifacts are validated even when already shared, and
  unrelated staged blobs are rejected. Surfaces are pinned PER RUN as versioned
  `SurfaceDescriptorSnapshot` refs (validator name + IMPLEMENTATION digest):
  adding a catalog surface never invalidates an old run, and a validator
  implementation change is detected as drift. Task identity now includes the
  signature, primitive catalog, and SCORER semantics; policy identity is the
  full policy MODULE, not just the class source.
- **Operator/package papercuts.** The CLI catches sandbox/config errors
  cleanly; state/config decode strictly and reject unknown TOML fields; the
  wheel is BUILT, INSTALLED into an isolated venv, and the real `strive` script
  is invoked end to end (build/install failures fail the test, never skip).

### Correctness pass 1 (earlier in this PR)

- **Exact run identity.** Run ids are opaque validated tokens (no separators,
  no `..`); the task is discovered from a persisted `RunBinding` index, never
  parsed from the id. `PolicyBound` now pins the task fingerprint, policy
  implementation digest, config, prompts, seed + seed state, budget spec,
  required capability profile, and surface-catalog digest; resume rejects any
  caller that disagrees.
- **Pure, closed, complete `verify()`.** Verification never writes CAS (the
  replay recomputes expected refs with `hash_text`), accepts only the closed
  substrate body union, checks command causation/one-terminal/one-digest,
  observation + proposal refs, revert-after-unreverted-apply, binding-index
  agreement, and the surface-catalog digest — and on any error exposes NO
  active state.
- **Strict identity + codecs.** The kernel re-derives a command's payload
  digest and compares it before both the already-issued and already-completed
  paths; canonical encoding is strict typed JSON (no `default=str`); config /
  policy-state blobs pin an encoder version; TOML config loading rejects
  non-string values; the public `VerifiedSubstrateView` mappings are
  read-only proxies.
- **Honest effects + budgets.** Durable state effects reconcile exactly; a
  completed fork's base/candidate refs and metered usage are recorded durably
  and REUSED on resume (never re-executed or re-charged); the budget spec is
  pinned in CAS and cumulative spend is re-seeded from durable usage, so a
  restart cannot reset or expand the budget; wall + cumulative output are
  enforced alongside execution count.
- **Hardened CAS + injected surface catalog.** CAS refs are validated as
  canonical sha256 (traversal-safe), reads are hash-verified, publication is
  concurrent-writer safe (unique temp + fsync + atomic replace). Surfaces come
  from an injected immutable `SurfaceCatalog` with trusted structural
  validators (code parses to exactly one `solve(input_text)`; prompt is
  non-empty) run before seed/apply.
- **Mutation stays on the command path.** `strive revert` issues a durable
  operator `RevertChange` command through the kernel (`operator_revert`),
  never a direct `Substrate.revert`.

### Modules

- **`strive.substrate`** — one artifact root, many runs
  (`<root>/runs/<run_id>.events`), CAS shared at `<root>/objects`. Composite
  `HarnessState`; coupled `CompositeChange` (exact before/after, invertible);
  `EventEnvelope` (stable `<run_id>#<seq>` id, run/task scope, `caused_by`,
  timestamp, CAS body ref). `verify()` → `VerifiedSubstrateView` is pure and
  closed: framing, one leading `PolicyBound`, per-envelope run/task scope,
  decode/hash-verify of every referenced ref, catalogued/validated bindings, an
  EXACT apply/revert replay (recomputed without writing CAS), causation
  (every effect/terminal/checkpoint cites an issued compatible command in
  order), one intent + one terminal + one digest per command id, revert =
  exact inverse of one unreverted apply, and checkpoint state+cursor agreement.
  Authority appends verify first and are head-checked; a per-run advisory lease
  serializes runners. `repair` quarantines only a torn/forged tail. The
  `<run>.binding.json` index is DERIVED (rebuilt/quarantined by
  `ensure_binding`/`discover`), never part of stream validity.
- **`strive.surfaces`** — the injected immutable `SurfaceCatalog`
  (`SurfaceDescriptor` per legal surface) and trusted structural validators
  (`validate_solve_code`, `validate_prompt`). A run pins one
  `SurfaceDescriptorSnapshot` (validator name + implementation digest) PER
  surface, so catalog growth never invalidates old runs and validator drift is
  detected.
- **`strive.runtime`** — the NEUTRAL, closed runtime contracts shared by the
  substrate and kernel: `CommandPayload`, `StoredResult`, `ConfigBlob`,
  `PolicyStateBlob`, `AttemptDispatched`, `AttemptRecord`, `ForkObservation`.
  A leaf module (imports only `codec`/`contracts`/`sandboxes`) so verification
  never depends on kernel import order.
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

- `uv run pytest` — 241 tests. The Phase-A floor plus the adversarial matrix
  (`test_cas`, `test_surfaces`, `test_adversarial`, `test_budget`,
  `test_state_machine`): CAS/surface/identity/budget/state-machine attacks PLUS
  the intent-to-effect bindings — Confirm/Revert target mismatch, apply
  expected-state mismatch, unrelated fork states, forged `improved`,
  summary-subject mismatch, failed/null result, forged stored head, crash after
  failure-before-terminal (reconcile, no re-run), same-process indeterminate
  wall/output reservation, and preserved backend/candidate-error evidence. The
  internal-consistency pass adds: command-payload coherence (missing/forbidden
  anchor, target=None bypass, JSON/normalized disagreement, wrong encoding,
  extra JSON key, change_ref↔subtree disagreement); failed-terminal StoredResult
  forgery (metrics, detail, nonzero usage), effect-after-failure, reconciled
  partial-fork usage (accepted vs zeroed); AttemptRecord↔report/evaluation
  disagreement; and REAL boundary faults (`test_sandbox_backend`: a crashed /
  timed-out child is ok=False+failure, a candidate exception stays a completed
  per-case evaluation). `test_substrate_only` verifies a kernel-driven run in a
  FRESH interpreter that never imports the kernel; `test_packaging` BUILDS +
  INSTALLS the wheel in an isolated venv and runs the real `strive` script
  (never skipped).
- `uv run mypy` — clean, `--strict`, over 39 files (src + tests).
- `uv run strive` — installed console script; verified in tests and smoke.

### The Phase-A claim

Every durable command field is bound to its exact effect; command intent has
ONE unambiguous representation (normalized anchors reconciled against the
canonical JSON through a single shared `strict_encode`); fork evidence is
derived from the issued base and candidate states and every AttemptRecord is
bound to its exact ExecutionReport + Evaluation; every terminal outcome is
validated identically and reconstructs exactly, with failure usage reconciled
from the durable attempt ledger (never zero); candidate failures stay distinct
from infrastructure failures (a boundary fault propagates as ok=False, a
candidate exception stays a completed per-case evaluation); and the live budget
always equals the durable external-effect ledger — with each command and
attempt a single verifiable lifecycle across concurrency, corruption, and
restart, verification pure and independent of kernel import order.

### Next

After review + merge: begin the Prime-Agent / Continual-Harness-style
`continual-refine@1` end-to-end policy (a real model refiner behind
`RequestRefinement`, a real prompt consumer, optional composed fork
evaluation). See `docs/ROADMAP.md`.

The promotion-era handoff is archived at
`docs/archive/HANDOFF-stage1-3c.md`.
