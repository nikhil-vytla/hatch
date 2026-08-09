# Architecture Decision Records — Stage 3A

Design-first contracts for composite, multi-surface evolution, written before
implementing Stage 3. Each ADR records the decision, rejected alternatives,
what was borrowed/rejected/deferred from the research corpus
([notes 01–06](../agents/research/00-index.md)), and its compatibility plan
with the live Stage 1–2b system.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-revisions-and-surfaces.md) | Harness revisions and evolvable surfaces | core frozen; implemented in 3B as dual-write mirror (`revisions.py`) |
| [0002](0002-scopes.md) | Artifact scopes: inheritance, shadowing, promotion | core frozen; typed scopes/manifests implemented in 3B (task scope live; project/global journals future) |
| [0003](0003-tasks-and-environments.md) | Task spec versions, dataset revisions, environments | design accepted; schemas provisional |
| [0004](0004-evidence-and-selection.md) | Validation bundles and selection decisions | design accepted; schemas provisional |
| [0005](0005-evolution-algorithms.md) | Evolution algorithms and objective specs | design accepted; schemas provisional |
| [0006](0006-storage-and-schema-evolution.md) | Storage backends and migration registry | migration registry implemented in 3B (`migrations.py`, entries 0001/0002) with durable intent→progress→completed operations; 3B.1 added prefix-pinned intents, operation-level locking, artifact-closure verification, and quarantine+rebuild recovery; backend schemas provisional |

## Freeze scope for Stage 3B

**Frozen core wire types** (Stage 3B implements exactly these): `ScopeRef`,
`RevisionRef`, `BindingState`, `SurfaceDelta` (binding transitions),
`ManifestBinding`, `ScopeManifest`, `ScopeContribution`,
`ResolvedHarnessManifest`, `HarnessRevision`, plus the `SurfaceDescriptor`
registry shape and the migration-registry mechanics.

**Provisional until their own slices** — TaskSpec/Dataset/EvaluationManifest
(FunctionTask slice), ValidationBundle/SelectionDecision + frontier
semantics (selection slice), AlgorithmRun/AlgorithmStep (algorithm slice),
detailed backend schemas (storage slice). Recorded unresolved needs those
slices must settle: typed object refs instead of bare ref strings; typed
evidence roles on bundles (baseline vs candidate); policy-detail refs on
decisions; frontier *removal* and snapshot records (frontier_add alone
cannot express eviction); objective + RNG-state + algorithm-state refs so
resumed searches are bit-reproducible, not merely restartable.

Conventions: experimental spike code lives in
`src/strive/stage3_contracts.py` (registered under new codec kinds, unused by
the live loop) with round-trip tests in `tests/test_stage3_contracts.py`.
Nothing in these ADRs migrates the live ledger; migration sequencing is
ADR-0006's job and happens in Stage 3B.

## Consolidated source comparison

| Source | Chiefly borrowed | Chiefly rejected |
|---|---|---|
| Flex/GEPA (note 01) | population/Pareto retention as a kernel *disposition* (`frontier_add`); evaluation budgets in manifests; objective specs feeding proposal prompts | optimizer-owned state without durable activation/rollback |
| prime-agent (note 02) | per-edit typed CRUD deltas with before/after refs; scope tiers (local/global) as blast-radius control | promotion on LLM judgment without behavioral evidence (its snapshots/version counters/invertible rollback are solid — the gap is the missing empirical gate, not its state handling) |
| Continual Harness (note 03) | four-surface decomposition; provenance/usage attribution; per-surface risk | ungated in-place edits; single-lineage mutation without retention of rejected candidates |
| exo (note 04) | append-only event log with head checks; durable intents; artifact/CAS separation; scoped secrets and conversation forking informed ADR-0002/0003 | policy-only trust boundary; build-success as validation; the single global mutable workspace for *evolvable* state |
| RLM (note 05) | recursive subcalls with remaining-budget propagation (mirrored in manifests/budgets); context-as-environment; isolation-tier registry unchanged | nothing rejected as such: RLM is an inference-time recursive/context-decomposition harness (optionally with persistent environments) — it does not persist runtime improvements at all, in weights or otherwise; the separate paper's model *training* is upstream of the harness, not a runtime mechanism |
| NOOA (note 06) | versioned schema discipline + migration mindset (ATIF); typed trajectory protocol direction | ungated library self-authoring; OTel dependency (deferred, not needed yet) |
