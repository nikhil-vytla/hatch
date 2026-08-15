# strive — Project Charter (vNext)

**Thesis.** Strive provides **durable mechanisms for model-led adaptation**
(the Exo lineage), not a universal empirical-promotion pipeline. A policy
apply, observe, checkpoint, and revert EXACT composite changes to
allowlisted surfaces; **comparative evaluation is an OPTIONAL mechanism a
policy requests**, never a gate the harness imposes. The value Strive adds
is a substrate and a kernel that make model-led change *durable, verifiable,
and exactly resumable* — not a fixed acceptance ceremony.

## What is non-configurable: the floor

Regardless of policy, the substrate and kernel enforce:

- **Allowlisted surfaces** — a change touches only `(kind, name)` pairs in
  `SURFACE_ALLOWLIST`.
- **Exact before/after state** — every surface delta pins exact content by
  CAS ref, so a change applies and inverts deterministically; a stale before
  is a conflict.
- **Semantic verification** — nothing mutates over an unverified log: the
  whole event stream is parsed into a `VerifiedSubstrateView` (framing
  integrity, one leading `PolicyBound`, CAS closure, canonical allowlisted
  bindings, an exact apply/revert replay, command lifecycle + digest
  consistency, checkpoint agreement, change-id uniqueness). A structural or
  semantic error refuses every authority append.
- **Run-scoped, append-only, tamper-evident events** — one artifact root
  holds many runs; every event has a stable id, run/task scope, command
  causation, and timestamp.
- **Resumable kernel** — one intent, one effect, one terminal result per
  command; state advances only after the outcome; restart reconstructs the
  exact same result with no duplicated effect, model call, observation, or
  spend.
- **Budgets, sandbox, secrets, permissions** — trusted budgets charge
  executions/model-calls; candidate code runs only under the secure
  `CandidateExecutor` with declared, capability-checked sandbox provenance;
  irreversible effects are controlled.
- **Checkpoints, rollback, crash recovery, explicit repair** — recovery
  (quarantine + truncate to the last verified frame) is explicit, never
  silent; a semantically-invalid-but-intact log is refused, not
  auto-quarantined.

## What is a policy's business (not the harness's)

Whether and when to evaluate comparatively; whether to keep, revise, or
revert a change; timing and lifecycle; how many surfaces to couple; what
"better" means. These live in policy packages (typed code + frozen TOML
config + versioned Markdown instructions), pinned per run by
implementation, exact config, prompt refs, and seed. The model/provider is
reproducibility metadata, not harness identity.

## Status and next phase

Phase A shipped the substrate, the result-driven kernel, the CLI, and
`manual-change@1` (a deterministic proof: propose → optional fork → apply →
revert, exactly, resumably). The next policy is **`continual-refine@1`** — a
Prime-Agent / Continual-Harness-style end-to-end refinement loop over this
substrate (NOT Pareto search). See `docs/ROADMAP.md` and
`docs/adrs/0008-vnext-substrate.md`.

The promotion-era charter, architecture, roadmap, and handoff (Stages 1–3C)
are archived under `docs/archive/` as historical context.
