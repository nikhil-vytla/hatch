# ADR-0008 — vNext: a policy-neutral, revision-native mechanism substrate

Status: accepted and implemented in vNext Phase A. **Supersedes the
promotion premise** of ADR-0004 (validation bundles / selection decisions as
a universal activation gate) and ADR-0005's "selection policy decides every
activation" framing, and retires the loop-era `AcceptancePolicy` activation
gate entirely. ADR-0001 (revisions/surfaces), ADR-0002 (scopes), ADR-0003
(tasks/datasets), ADR-0006 (storage/migrations), and ADR-0007 (sandbox
boundary) are refactored, not reversed — their FLOOR mechanisms survive; the
mirror/dual-write/generation-authority/migration machinery is deleted.

## Context

Through Stage 3C, Strive's thesis was "every change requires empirical
promotion": a candidate had to pass a comparative `AcceptancePolicy` (or the
3C.2A selection-envelope gate) against held-out evidence before it could
serve. That baked one adaptation ceremony into the kernel. It also carried a
large compatibility apparatus — a generation ledger as the authoritative
state, a generation→revision mirror with dual-write and parity, a reader
canary with burn-in, and sequential legacy migrations — so that the
promotion machinery could evolve without breaking old artifacts.

vNext changes the thesis: Strive should provide **durable mechanisms for
model-led adaptation** (the Exo lineage), not a single promotion policy.
Comparative evaluation is one valuable mechanism, but a policy — not the
kernel — should decide whether and when to use it.

## Decision

**One revision-native event/artifact substrate is the sole harness state**
(`strive.substrate`): a task/run-scoped, append-only, crash-framed,
hash-chained event stream (`strive.framing`) plus a content-addressed
object store (`strive.cas`). Harness state is native composite state — a set
of allowlisted surface bindings — materialized by folding authority events.
There is no generation ledger, no revision mirror, no dual-write/parity, no
reader canary, no legacy migration, and no `AcceptancePolicy` gate. Backward
compatibility and migration of pre-vNext artifacts are out of scope: the
promotion-era modules and their schemas were deleted, not adapted.

Authority events (`ChangeApplied`, `ChangeReverted`, and the seed
`PolicyBound`) move state; observations (`ObservationRecorded`) and
annotations (`ChangeProposed`, `ChangeConfirmed`, `ChangeRevised`) do not;
command bookkeeping (`PolicyCommandIssued`/`Completed`, `PolicyCheckpointed`,
`OperationFailed`) makes commands resumable. All share one ordered stream
with distinct typed semantics. External tracing is a read-only subscriber
and never required for operation.

**A resumable policy command boundary** (`strive.policy`, `strive.kernel`).
One active orchestrating `AdaptationPolicy[Config, State]` owns timing and
lifecycle; `SurfaceStrategy` objects analyze immutable views and propose
(including coupled multi-surface proposals) but cannot mutate state.
Policies receive immutable views and emit a small closed command vocabulary
(`RequestRefinement`, `ApplyChange`, `EvaluateFork`, `ScheduleTrigger`,
`ConfirmChange`, `RevertChange`, `StopAdaptation`). The kernel is the only
mutator: it journals each command's intent and result, content-addresses the
policy's successor state as a checkpoint, and resumes exactly — a completed
command is never repeated, and a crash between an authority effect and its
completion is reconciled by detecting the effect. **`EvaluateFork` is how a
policy REQUESTS comparative evaluation; the kernel never imposes it.**

**Policy packages** are typed code + a frozen, policy-specific config
dataclass loaded from TOML (no universal DSL) + versioned Markdown
model-facing instructions; model output decodes into strict typed proposals.
A run pins the policy implementation, exact config, prompt refs, and seed;
the model/provider is reproducibility metadata, not harness identity. The
policy/strategy catalog is injected and immutable (no import-time
registration).

**The floor is enforced by the substrate and kernel, not by a policy:**
allowlisted surfaces, exact before/after content, expected-head conflict
checks, CAS integrity, append-only tamper-evident effects,
checkpoints/rollback, crash recovery, budgets, and the secure
`CandidateExecutor` sandbox boundary (ADR-0007, unchanged) with its declared
security + resource capabilities.

## Consequences

- Deleted modules: `lifecycle`, `loop`, `reader`, `dualwrite`, `experiment`,
  `selection`, `evidence`, `validators`, `datasets`, `promptgate`,
  `migrations`, `migrate`, `capability`, `store`, `stage3_contracts`,
  `monitors`, `propose`, `model_proposer`, `diagnose`, `revisions`, the old
  `policy` (AcceptancePolicy), `fakemodel`, and the promotion CLI — plus the
  promotion-era wire types in `contracts` (`Generation`, `Activation`,
  `Decision`, `ProposalRecord`, `Candidate`, `SurfaceUpdate`, `CycleRecord`,
  `Intervention`, `Diagnosis`).
- Kept (refactored): `codec`, `cas`, `framing`, `contracts` (primitives),
  `tasks`, `evaluate`, `budget`, `model`, and the whole sandbox stack
  (`sandbox`, `sandboxes`, `sandbox_backends`, `sandbox_guards`,
  `sandbox_launcher`, `strategy_runner`) — the secure executor.
- Phase A ships `manual-change@1` as the substrate proof (deterministic:
  apply + observe + checkpoint/restart + exact revert). It does NOT begin
  Pareto search or a full model refiner.

## Policy package layout

```
strive/policies/manual_change.py       # typed state machine + proposal build
strive/policies/manual_change.toml     # frozen ManualChangeConfig (TOML)
strive/policies/prompts/manual_change_refine@1.md   # versioned instructions
```

## Sources: borrowed / rejected / deferred

- **Borrowed** — exo (note 04): durable adaptation mechanisms and journaled
  update intents as the substrate, not a promotion policy; RLM (note 05):
  content-addressed resumable state so restart never repeats a model call.
- **Rejected** — the universal empirical-promotion gate (ADR-0004 as a
  ceremony); generation-native authority + mirror/dual-write/parity; the
  reader canary/burn-in; legacy migrations/backfills.
- **Deferred** — the budget-matched `hill-climb@1` vs `pareto-population@1`
  experiment (a policy comparison built on this substrate, as a journaled
  command/reducer state machine); a model-driven refiner policy
  (`RequestRefinement`); making policy prompts an ordinary self-evolvable
  surface.
