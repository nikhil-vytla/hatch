# Architecture Decision Records — Stage 3A

Design-first contracts for composite, multi-surface evolution, written before
implementing Stage 3. Each ADR records the decision, rejected alternatives,
what was borrowed/rejected/deferred from the research corpus
([notes 01–06](../agents/research/00-index.md)), and its compatibility plan
with the live Stage 1–2b system.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-revisions-and-surfaces.md) | Harness revisions and evolvable surfaces | accepted |
| [0002](0002-scopes.md) | Artifact scopes: inheritance, shadowing, promotion | accepted |
| [0003](0003-tasks-and-environments.md) | Task spec versions, dataset revisions, environments | accepted |
| [0004](0004-evidence-and-selection.md) | Validation bundles and selection decisions | accepted |
| [0005](0005-evolution-algorithms.md) | Evolution algorithms and objective specs | accepted |
| [0006](0006-storage-and-schema-evolution.md) | Storage backends and migration registry | accepted |

Conventions: "accepted" means the contract shapes are settled for Stage 3
implementation; experimental spike code lives in
`src/strive/stage3_contracts.py` (registered under new codec kinds, unused by
the live loop) with round-trip tests in `tests/test_stage3_contracts.py`.
Nothing in these ADRs migrates the live ledger; migration sequencing is
ADR-0006's job and happens in Stage 3B.

## Consolidated source comparison

| Source | Chiefly borrowed | Chiefly rejected |
|---|---|---|
| Flex/GEPA (note 01) | population/Pareto retention as a *selection verdict*; evaluation budgets in manifests; objective specs feeding proposal prompts | optimizer-owned state without durable activation/rollback |
| prime-agent (note 02) | per-edit typed CRUD deltas with before/after refs; scope tiers (local/global) as blast-radius control | LLM-judgment promotion; mutable in-place harness state |
| Continual Harness (note 03) | four-surface decomposition; provenance/usage attribution; per-surface risk | ungated in-place edits; single-lineage mutation without retention of rejected candidates |
| exo (note 04) | append-only event log with head checks; durable intents; artifact/CAS separation | policy-only trust boundary; build-success as validation |
| RLM (note 05) | budget inheritance in manifests; isolation-tier registry unchanged | stateless per-run design (no retention) — opposite of strive's bet |
| NOOA (note 06) | versioned schema discipline + migration mindset (ATIF); typed trajectory protocol direction | ungated library self-authoring; OTel dependency (deferred, not needed yet) |
