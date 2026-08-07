# strive — Roadmap

Staged maturity targets, revised 2026-08-06 after the research phase (notes 01–06,
[comparative matrix](agents/research/comparative-matrix.md), [ARCHITECTURE](ARCHITECTURE.md)).
Supersedes the charter's original six-stage sketch; the charter's non-goals still bind
stages 1–6. Every stage keeps all earlier stages' tests green and fully offline.

## Stage 1 — Thin vertical slice ✅ (2026-08-06)

Deterministic task, planted weakness, signature diagnosis, bounded registry patch,
subprocess isolation, append-only ledger, restart persistence, rollback. 23 tests,
strict mypy, committed demo lineage.

## Stage 2 — Foundations hardening + model-in-the-loop offline evolution

The research phase moved several items *into* stage 2 that were previously later:
the documented failures in the corpus tie to specific missing mechanisms — CH's
inheritance regression to reuse/inheritance protection, its 842-repeat stall to loud
schema rejection and trusted stall detection — and those mechanisms are cheap now
and structural to retrofit later.

Foundations (do first, in order — these are the hardening priorities in HANDOFF):
1. Shared typed codec for ledger + events; `schema_version` on every entry; normative
   schema tests (ATIF discipline, note 06).
2. Task-owned scoring with **split declaration** (visible / held-out); `decide` requires
   improvement on held-out.
3. Evaluator contract → `(score, feedback_text)`; failure-as-score floor semantics
   (note 01).
4. Loud schema rejection in the runner + trusted mechanical stall detector
   (note 03 §B.3).
5. Budget accounting (tokens/cost/wall-clock/eval-runs) in the cycle contract,
   trusted-side (notes 04/05).
6. Usage accounting: journal which generation serves each invocation (note 03, Table 2).

Model-in-the-loop:
- `Proposer` protocol: registry proposer + `ModelProposer` behind a provider-neutral
  `ModelAdapter`; deterministic `FakeModelAdapter` in core; all model I/O journaled
  and replayable.
- Proposer input contract: parent source + diagnosis + failing cases + **acceptance
  history** (prime-agent feeds past refinement results back; note 02).
- Sandbox tier 2: rlimits + network denial for candidate execution.

**Exit criteria:** a model-backed proposer (fake model in CI) fixes a *non-planted*
weakness on a second task; the candidate passes held-out validation; the full cycle
replays offline from the ledger alone; a hanging/hostile candidate exhausts its budget
and is journaled as a floor-scored rejection.

## Stage 3 — Composite generations + pluggable evolution algorithms + hardened sandbox

- Composite generation schema: per-surface CRUD deltas with before/after snapshots
  (notes 02/03); per-surface activation and rollback.
- Second and third surfaces: prompts, policies. SurfaceDescriptor registry.
- `EvolutionAlgorithm` plugin interface: incumbent hill-climb (v0) + GEPA-style
  Pareto-frontier population with explicit eval budgets (note 01).
- `Validator` plugin interface: suite / held-out / static pre-filter tiers.
- Sandbox tier 3 on Linux (Landlock + seccomp, fail-closed probing per NOOA
  `guards.py`); tier 2 remains the macOS floor.
- Inheritance-aware acceptance thresholds (replace-vs-add distinction, note 03).

**Exit criteria:** one cycle evolves prompt + policy + code deltas as a single
generation, rolls back one surface without disturbing the others; two evolution
algorithms compete on the same task under equal budgets and the ledger shows why the
winner won.

## Stage 4 — Real tasks, benchmarks, statistics

- Agentic tasks with tools; tool calls journaled; large results compacted to artifacts.
- Benchmark suites with repeated trials and statistical acceptance criteria
  (score distributions, not point estimates).
- Regression corpus grown automatically from past failures.
- Efficiency as a first-class score term (GEPA's λ-cost result — evolution should be
  able to *remove* model calls; note 01).
- Per-proposer-model acceptance statistics (the capability-floor finding, note 03:
  a weak proposer must show up as high rejection rate, not degradation).

**Exit criteria:** on a benchmark task family, an evolved configuration beats the seed
with statistical confidence under a declared budget, with zero regression-corpus
failures; a deliberately weakened proposer model yields rising rejections, not falling
held-out scores.

## Stage 5 — Durable memory, online adaptation, recursive delegation

- Memory as an evolvable surface: typed entries, lineage edges, pull-rate
  instrumentation from day one, no retrieval self-reinforcement (notes 03/06);
  write-only memory earns no acceptance.
- Online adaptation per ARCHITECTURE's six rules: provisional activations, proxy
  validators, inheritance protection, trusted freeze switch, cadence + failure
  triggers, physically isolated trusted state.
- Recursive delegation: subagent specs as a surface; kernel-mediated spawning with
  RLM-style depth caps and remaining-budget inheritance (note 05); handoff quality
  (exit/focus rates) measured per CH C.1.3.
- Standing experiment: bootstrap-frozen vs bootstrap-updating (note 03) as the
  permanent "is online refinement still adding value?" control.

**Exit criteria:** on a long-horizon task stream, online-adapted runs beat frozen-
harness runs *and* every provisional change is either confirmed offline or expired;
an induced drift attempt (candidate displacing a proven incumbent on thin evidence)
is blocked by the inheritance rule and journaled.

## Stage 6 — Hardened substrate

- Container/microVM sandbox tier; adversarial-candidate threat model.
- Scoped secrets broker (kernel/task/run scopes, exo pattern); kernel-side model proxy
  for sandboxed code.
- Durable-intent journaling for all irreversible operations; crash-recovery tests.
- Distributed/parallel candidate evaluation.
- This stage retires the charter's "production-grade sandboxing" non-goal.

**Exit criteria:** a deliberately malicious candidate (exfiltration, fork-bomb,
ledger-tampering attempts) is contained by mechanism at every tier; kill -9 during an
accept/rollback recovers to a consistent journaled state.

## Stage 7 (optional) — Co-evolving harness and model weights

Explicitly optional and outside the current charter (model-weight training remains a
non-goal until this stage is deliberately entered). The CH paper's co-learning result —
weights-only training yields zero progress, harness-only hits a capability floor, only
the joint loop advances (note 03 §4.5) — defines what sits across this boundary.

- Export ATIF-style versioned trajectories (with compaction flags filtered per the
  spec, note 06) so external training pipelines can consume strive runs without strive
  running any training itself.
- Then, if entered: alternating timescales — harness refinement within iterations,
  weight updates across them — with strive's acceptance gate extended to weight
  checkpoints (a checkpoint is a candidate like any other: validated on held-out
  data, journaled, promotable, rollback-able).

**Entry condition, not exit criteria:** stages 2–5 acceptance statistics demonstrate
the harness-adaptation ceiling for a fixed model — i.e., we can *measure* the boundary
before we cross it.
