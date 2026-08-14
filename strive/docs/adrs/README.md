# Architecture Decision Records — Stage 3A

Design-first contracts for composite, multi-surface evolution, written before
implementing Stage 3. Each ADR records the decision, rejected alternatives,
what was borrowed/rejected/deferred from the research corpus
([notes 01–06](../agents/research/00-index.md)), and its compatibility plan
with the live Stage 1–2b system.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-revisions-and-surfaces.md) | Harness revisions and evolvable surfaces | core frozen; implemented in 3B (dual-write mirror) and 3B.3 (native lifecycle); 3C.1 made the second surface operational — `prompt/proposal-template` (`prompt@3`, Formatter-validated, pinned into lifecycle state) evolved in composite candidates with surface-specific promotion evidence (`strive.promptgate`) and empirically exercised end to end |
| [0002](0002-scopes.md) | Artifact scopes: inheritance, shadowing, promotion | core frozen; typed scopes/manifests implemented in 3B (task scope live; project/global journals future) |
| [0003](0003-tasks-and-environments.md) | Task spec versions, dataset revisions, environments | dataset revisions + evaluation manifests + the `function-task@1` spec adapter implemented in 3C.2A and made authoritative in 3C.2A.1 (manifests v2 pin exact TaskSpecVersion/DatasetRevision refs with verified fingerprints; the live guard checks SPEC drift via `TaskSpecBound`, so data growth re-baselines instead of acknowledging drift; locked/crash-safe/CAS-verified dataset creation); Environment session protocols and Trajectory remain provisional until stage 4 |
| [0004](0004-evidence-and-selection.md) | Validation bundles and selection decisions | **implemented in 3C.2A, authoritative since 3C.2A.1**: frozen role-typed envelopes, policy-neutral decisions with the closed disposition vocabulary (frontier_add structural), the full-agreement activation gate (exact validator sets, passed paired comparison, objective/policy/subject/incumbent/artifact agreement, verified execution provenance, honest synthetic grading — migrated evidence never authorizes fresh promotion), and the 0005 lossless backfill with schema-upgrade re-linking; `compare`/replay derive from bundles |
| [0005](0005-evolution-algorithms.md) | Evolution algorithms and objective specs | `ObjectiveSpec@1` implemented in 3C.2A (trusted, pinned on every manifest and decision, not evolvable); the `EvolutionAlgorithm` protocol, KernelServices, and AlgorithmRun/Step remain provisional — NEXT SLICE (3C.2C): budget-matched hill-climb@1 vs pareto-population@1 over the 3C.2B secure backend |
| [0007](0007-sandbox-boundary.md) | The pluggable sandbox boundary and the model-capability lane | **implemented in 3C.2B, made authoritative in 3C.2B.1**: one kernel-owned `CandidateExecutor` over an injected immutable `BackendCatalog` (fail-closed, conformance suite); `deno-pyodide@1` secure local backend with a hardened protected protocol (only `input_text`, separate namespace, strict single-typed result), a POSIX-rlimit launcher (`resource_limited` in the secure floor), exact runtime-digest provenance, cross-bundle provenance agreement, replay-requires-recorded-backend, and an always-unavailable Linux spike; the `strive.capability` lane with real seeds, an immutable manifest, a preregistered criterion, and resume |
| [0006](0006-storage-and-schema-evolution.md) | Storage backends and migration registry | migration registry implemented in 3B (`migrations.py`, entries 0001/0002) with durable intent→progress→completed operations; 3B.1 added prefix-pinned intents with prefix-scoped completion, operation-level locking, artifact-closure verification, quarantine+rebuild recovery, and precise detection of stage-3B-era journal schemas; 3B.2 added the reader journal — a task-bound, crash-framed, hash-chained control+evidence stream (modes, breaker, burn-in epochs, per-check evidence) that detects deletion/reordering/forgery — with fail-closed control transitions (head-checked, epoch-resetting repair, journal-independent force-native override) and expected-head mutations across activation/rollback/seed/provisional; 3B.3 added the canonical native-revision lifecycle journal (`<task>.revisions.jsonl`) — a framed, hash-chained, task-scoped stream owning identity (`RevisionRetained`), per-assessment evidence (`RevisionEvaluated`/`RevisionSelected`/`TrustedOverride`), compatibility links, recoverable cross-journal activation ops (intent/progress/completed with reconcile), and a breaker — with migrations 0003 (lifecycle backfill preserving the actual active revision) and 0004 (PR#43 reader-journal upgrade), refuse-or-repair framing recovery, and the generation ledger/mirror demoted to derived compatibility; backend schemas provisional |

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
