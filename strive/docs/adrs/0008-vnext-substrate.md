# ADR-0008 — vNext: a policy-neutral, revision-native mechanism substrate

Status: accepted and implemented in vNext Phase A. **Supersedes the
empirical-promotion premise** of ADR-0004 (validation bundles / selection
decisions as a universal activation gate) and the "selection decides every
activation" framing of ADR-0005, and retires the loop-era `AcceptancePolicy`
gate. ADR-0001/0002/0003/0006 are refactored (their FLOOR notions survive;
the generation ledger, revision mirror, dual-write/parity, reader canary,
and migrations are deleted). ADR-0007 (the secure sandbox boundary) is kept
unchanged.

## Context

Through Stage 3C, Strive baked one adaptation ceremony into the kernel:
"every change requires empirical promotion" against held-out evidence,
carried by a large compatibility apparatus (generation authority + mirror +
dual-write + parity + reader canary + migrations). vNext changes the thesis
to **durable mechanisms for model-led adaptation** (the Exo lineage):
comparative evaluation is one valuable mechanism a policy may request, but
the kernel should not impose it. Backward compatibility and migration of
pre-vNext artifacts are out of scope — the promotion machinery is deleted,
not adapted.

## Decision

### One run-scoped, semantically-verified event/CAS substrate

`strive.substrate` is the SOLE harness state. One artifact root holds many
RUNS without collision: a content-addressed object store shared at
`<root>/objects`, and per run an append-only, crash-framed, hash-chained
event stream at `<root>/runs/<run_id>.events`.

- **Composite state** is a canonical set of allowlisted `SurfaceBinding`s;
  a `CompositeChange` is coupled, exact `before_ref → after_ref` per
  surface, applied and inverted deterministically.
- **Every event is an `EventEnvelope`** with a kernel-generated STABLE id
  (`<run_id>#<seq>`), run/task scope, the command that CAUSED it, a
  monotonic seq, a timestamp, and a CAS ref to a typed body. There are no
  count-based or fixed ids. A `command_id` is unique within a run and bound
  to ONE canonical payload digest; reuse with a different payload fails
  closed.
- **`verify()` is authoritative.** It parses the whole stream into a
  `VerifiedSubstrateView`, checking: framing integrity; exactly one leading
  `PolicyBound` with full policy/config/prompt/seed CAS closure and valid
  seed bindings (canonical, unique, allowlisted, existing); an EXACT
  apply/revert replay (before equals the prior state, the change decodes,
  deterministic application equals the recorded after ref, and the effect
  cites a command); command lifecycle with one terminal completion and one
  digest per command id; checkpoint state agreement; observation subjects;
  and change-id uniqueness. A structural or semantic error makes the view
  `ok=False`, and EVERY authority append is refused. Recovery is explicit
  (`repair`): a torn/forged tail is quarantined + truncated to the last
  verified frame; a semantically-invalid-but-intact log is refused, not
  auto-quarantined.

### A result-driven, resumable policy kernel

`strive.policy` defines `AdaptationPolicy[Config, State]`
(`next_command` + `reduce` + `decode_state`) and `SurfaceStrategy`; the
closed command vocabulary (`RequestRefinement`, `ApplyChange`,
`EvaluateFork`, `ScheduleTrigger`, `ConfirmChange`, `RevertChange`,
`StopAdaptation`); immutable `RunView`s; and an injected immutable
`PolicyCatalog` (no import-time registration) whose descriptor config
loaders and prompt slots are authoritative and conformance-tested.

`strive.kernel` is the only mutator. Per command it journals ONE intent,
performs or RECONCILES ONE effect, journals ONE terminal result, then
reduces and checkpoints (state + a consumed-result cursor). It never
advances state before the outcome. On restart it reloads the last
checkpoint, re-derives the same deterministic command, and reconstructs the
exact recorded result (so `last_result` can never disappear); an effect
present without a terminal is finished, not repeated; a not-yet-reflected
reduction happens exactly once. Apply, Revert, EvaluateFork, Confirm,
Schedule, and Stop all reconcile without duplicate intents, effects, model
calls, observations, or spend (RequestRefinement is reserved for the model
refiner in `continual-refine@1`).

### The floor, enforced regardless of policy

Allowlisted surfaces and exact before/after (substrate); expected-head
conflict checks on authority appends; full CAS closure staged and required
before apply; bound identity authoritative on resume (a caller whose
config/prompts/seed disagree with `PolicyBound` is rejected); trusted
budgets charging executions and model calls; candidate code only through the
secure `CandidateExecutor` with declared, capability-checked, exactly
recorded `SandboxProvenance` (capability-equivalent backends allowed); and
`EvaluateFork` capturing exact base/candidate state refs BEFORE execution
and recording both even if active state advances.

### Policy packages

Typed code + a frozen, policy-specific config dataclass loaded from TOML (no
universal DSL) + versioned Markdown model-facing instructions; model output
decodes into strict typed proposals. A run pins the policy implementation,
exact config, prompt refs, and seed; the model/provider is run metadata, not
harness identity. Policy prompts are swappable/versioned but not yet an
ordinary self-evolvable surface.

## Consequences

- Deleted (compat/migration out of scope): `lifecycle`, `loop`, `reader`,
  `dualwrite`, `experiment`, `selection`, `evidence`, `validators`,
  `datasets`, `promptgate`, `migrations`, `migrate`, `capability`, `store`,
  `stage3_contracts`, `monitors`, `propose`, `model_proposer`, `diagnose`,
  `revisions`, the old `AcceptancePolicy`, `fakemodel`, the promotion CLI,
  and the promotion-era `contracts` wire types.
- Kept (refactored): `codec`, `cas`, `framing`, `contracts` (primitives),
  `tasks`, `evaluate`, `budget`, `model`, and the full sandbox stack.
- Phase A ships `manual-change@1` as the substrate proof (deterministic:
  propose → optional fork → apply → revert, exactly, resumably). It does NOT
  begin Pareto search or a full model refiner.

### Policy package layout

```
strive/policies/manual_change.py       # typed state machine (next_command/reduce)
strive/policies/manual_change.toml     # frozen ManualChangeConfig (TOML)
strive/policies/prompts/manual_change_refine@1.md   # versioned instructions
```

## Phase-A hardening (correction pass)

The Phase-A implementation was hardened before merge without changing the
thesis:

- **Exact run identity.** Run ids are opaque validated tokens (traversal
  safe); the task is discovered from a persisted `RunBinding` index, never
  parsed from the id. `PolicyBound` pins the task fingerprint, policy
  implementation digest, config, prompts, seed + seed state, budget spec,
  required capability profile, and surface-catalog digest; resume rejects a
  disagreeing caller. The binding index is cross-checked against the
  authoritative in-stream `PolicyBound` on every verify.
- **`verify()` is pure, closed, and complete.** It never writes CAS (the
  apply/revert replay recomputes expected refs with `hash_text`), accepts
  only the closed substrate body union, and additionally checks command
  causation / one-terminal / one-digest, observation + proposal ref presence,
  revert-follows-an-unreverted-apply (no arbitrary or duplicate reverts), and
  the surface-catalog digest. On any error it exposes NO active state.
- **Strict identity + codecs.** The kernel re-derives each command's payload
  digest and compares it before both the already-issued and already-completed
  paths; canonical encoding is strict typed JSON (no `default=str`); config /
  policy-state blobs pin an encoder version; TOML loading rejects non-string
  values; public views expose read-only mapping proxies.
- **Honest effects + restart-safe budgets.** Durable state effects reconcile
  exactly; a completed fork's base/candidate refs + metered usage are recorded
  durably and reused on resume (never re-executed or re-charged); the budget
  spec is content-addressed in `PolicyBound` and cumulative spend is re-seeded
  from durable usage, so restart cannot reset or expand it; wall + cumulative
  output are enforced alongside execution count. External model calls
  (`RequestRefinement`, deferred) are documented as not exactly-once and must
  record `indeterminate` on a dispatch-without-durable-result crash.
- **Hardened CAS + injected surface catalog.** Canonical sha256 ref
  validation (traversal safe), hash-verified reads, concurrent-writer-safe
  publication (unique temp + fsync + atomic replace); an injected immutable
  `SurfaceCatalog` with trusted structural validators run before seed/apply.
- **Mutation stays on the command path.** `strive revert` issues a durable
  operator `RevertChange` command through the kernel, never a direct
  `Substrate.revert`.

## Phase-A correctness pass 2

A second pass closed the remaining correctness gaps before merge, without
changing the thesis:

- **Verification closed and deep.** `verify()` now checks every envelope's run
  AND task scope, rejects a duplicate intent even at the same digest, requires
  every effect/annotation/terminal/checkpoint to cite an ISSUED, kind-compatible
  command in valid order, decodes/hash-verifies EVERY referenced object (not
  `has()`), requires proposal/change id↔ref agreement, requires a revert to
  follow one unreverted apply and equal its EXACT inverse, and ties a
  checkpoint's cursor to the completed result it reduced — staying pure and
  exposing no state on error.
- **Crash-safe derived discovery.** `PolicyBound` is authoritative; the binding
  index is a rebuildable cache reconciled by `ensure_binding`/`discover`
  (rebuild-after-publication-crash, run_id cross-check, quarantine-on-divergence)
  and is NOT part of stream validity. `bind_policy` preflights every bound ref
  and seed invariant.
- **Command exactness + concurrency.** A per-run advisory lease serializes
  runners; a same-id/same-digest issue is an idempotent read; the initial and
  reconstructed `CommandResult` (incl. `head`) are identical; `expected_state_ref`
  is a logical precondition excluded from command identity so re-derivation is
  stable.
- **Honest budgets/effects.** Per-command usage (incl. failed/partial) is
  durable and re-seeded from every completed command on restart (no reset /
  no double-absorption); sandbox limits are capped by the remaining budget; a
  fork records base and candidate attempts separately with actual
  provenance/failure/denials/usage/state; a dispatch with no recoverable result
  is `indeterminate` (explicit retry, never silent re-dispatch).
- **CAS + versioned extensibility.** `put_text` verifies a preexisting object;
  invalid UTF-8 is corruption; referenced surface artifacts are validated even
  when shared and unrelated staged blobs are refused. A run pins versioned
  per-surface descriptor snapshots (validator name + implementation digest), so
  catalog growth never invalidates old runs and validator drift is detected.
  Task identity includes signature/catalog/scorer semantics; policy identity is
  the full policy module.

## Phase-A semantic-atomicity pass

The final pass makes every append semantically atomic and every runtime record
closed and neutral:

- **Atomic append.** Each authority append is preflighted by a PURE fold of the
  RESULTING stream and refused unless the post-event view is fully valid, so a
  valid run can never be turned invalid and a refused append leaves the journal
  byte-for-byte unchanged.
- **Neutral runtime contracts.** Command payloads, stored results,
  config/policy-state envelopes, attempt dispatches/records, and fork
  observations moved to `strive.runtime`, imported directly by the substrate;
  verification decodes each ref as its expected type and matches
  id/kind/outcome/encoding, requires one proposal per change id, and matches an
  applied/forked change to its proposal AND its issued command payload — never
  a kind string. Verification is independent of kernel import order.
- **Pinned-surface mutation.** A run may mutate only the surface snapshots
  pinned in its `PolicyBound`, resolved + validated through those descriptors
  even for shared CAS content; catalog growth keeps old runs readable but
  mutating a new surface needs a rebind.
- **Durable preconditions.** `expected_state_ref` is part of the command's
  durable identity; the manual policy derives a stable seed-state precondition.
- **Truthful attempts + budgets.** Each fork attempt journals a DISPATCH then a
  RESULT; an open dispatch is `indeterminate`, never re-run; the meter is
  rebuilt fresh from the durable per-attempt ledger; wall is cumulative active
  time and output is enforced cumulatively across cases.

## Phase-A command/attempt state-machine pass

The final pass makes each command and external attempt a single verifiable
lifecycle:

- **Closed per-command grammar.** `verify()` enforces the exact allowed effects
  per command kind + outcome (proposal/apply, exact revert, fork
  proposal→dispatch→result×2→summary, confirmation, or none for schedule/stop),
  rejects effects before intent / after terminal, missing/extra effects, a
  successful terminal without a `StoredResult`, and duplicate checkpoints; a
  checkpoint follows one terminal, consumes its command once, and pins the
  exact reduced state.
- **Typed command/result semantics.** Embedded command/config/policy-state JSON
  must be canonical; a `StoredResult` matches its command's id/kind/outcome,
  proposal ref, observation ref, and metrics; `expected_state_ref` stays in the
  durable identity; initial and reconstructed results are byte-for-byte equal.
- **Fork-attempt lifecycle.** One dispatch → at most one result per
  `(command_id, label)`, no result without a dispatch, base before candidate,
  dispatch/result `state_ref` equal to the observation subject, a summary equal
  to the two durable results and the issued candidate change, provenance that
  satisfies the pinned capability profile, and finite/nonnegative usage.
- **Honest budget dimensions.** Open dispatches reserve executions AND wall AND
  output; `CandidateExecutor` preserves the actual backend wall/output/failure
  (no zeroed wall, no error-string byte counts); output is enforced from real
  captured bytes.
- **Pinned evaluation + policy package.** The task fingerprint includes the
  case-selection and aggregate-evaluator identity; a policy descriptor may
  declare an explicit `dependency_modules` manifest folded into the policy
  digest.

## Sources: borrowed / rejected / deferred

- **Borrowed** — exo (note 04): durable adaptation mechanisms + journaled
  update intents as the substrate; RLM (note 05): content-addressed
  resumable state so restart never repeats a model call.
- **Rejected** — the universal empirical-promotion gate (ADR-0004 as a
  ceremony); generation-native authority + mirror/dual-write/parity; the
  reader canary/burn-in; legacy migrations/backfills.
- **Deferred** — `continual-refine@1` (a Prime-Agent / Continual-Harness
  style end-to-end refinement policy: a real model refiner behind
  `RequestRefinement`, a real prompt consumer, optional composed fork
  evaluation); later, a budget-matched policy comparison expressed as
  ordinary policies over this substrate; making policy prompts an ordinary
  self-evolvable surface.
