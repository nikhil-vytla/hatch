# strive — Roadmap

Staged maturity targets, revised 2026-08-06 after the research phase (notes 01–06,
[comparative matrix](agents/research/comparative-matrix.md), [ARCHITECTURE](ARCHITECTURE.md)).
Supersedes the charter's original six-stage sketch; the charter's non-goals still bind
stages 1–6. Every stage keeps all earlier stages' tests green and fully offline.

## Stage 1 — Thin vertical slice ✅ (2026-08-06)

Deterministic task, planted weakness, signature diagnosis, bounded registry patch,
subprocess isolation, append-only ledger, restart persistence, rollback. 23 tests,
strict mypy, committed demo lineage.

## Stage 2a — Foundations hardening ✅ (2026-08-06, phase 3)

The research phase moved several items *into* stage 2 that were previously later:
the documented failures in the corpus tie to specific missing mechanisms — CH's
inheritance regression to reuse/inheritance protection, its 842-repeat stall to loud
schema rejection and trusted stall detection — and those mechanisms are cheap now
and structural to retrofit later.

All six foundation priorities are implemented and tested (77 tests, strict mypy;
see HANDOFF "Phase 3" for verification evidence):
1. ✅ Shared typed codec + versioned contracts + golden-record compat tests.
2. ✅ Task-owned scoring with visible/held-out/regression/adversarial splits;
   `paired-deterministic@1` requires held-out discipline; holdout data is
   mechanically absent from diagnosis/proposal inputs.
3. ✅ Evaluations return per-split scores + structured feedback; failure-as-score.
4. ✅ Loud schema rejection in the runner (protocol check, dedicated exit code)
   + trusted stall detector with journaled freeze/resume.
5. ✅ Trusted budget meter in the cycle contract (wall/executions/model calls/
   tokens/output bytes/cost/recursion), exhaustion recorded as data.
6. ✅ Usage attribution: every execution event names its generation.

Also landed early: pluggable named+versioned acceptance policies (no universal
formula), provisional expiring activations, content-addressed artifacts, atomic
promotion, `ModelAdapter` + `FakeModelAdapter` with journaled metered I/O, and
the CLI suite (run/status/lineage/inspect/compare/replay/promote/rollback/
resume/history, all with `--json`). Sandbox hardening is partial: scrubbed env,
private workspace, rlimits, bounded output — network denial is NOT enforced
(documented honestly in README/ARCHITECTURE).

## Stage 2b — Model-in-the-loop offline evolution ✅ (2026-08-07, phase 4)

Implemented (see HANDOFF "Phase 4" for verification evidence):
- ✅ `ModelProposer` behind a typed `Proposer` protocol (registry proposer retained
  as the deterministic reference); structured proposal schema with strict, distinctly
  journaled rejection classification (truncated / malformed / schema-invalid /
  forbidden / stale / budget-exhausted).
- ✅ Proposer input contract: visible evidence + diagnosis + sanitized acceptance
  history (aggregate scores only) + explicit budgets; holdout contents mechanically
  absent (spy-tested down to the built prompt).
- ✅ All model I/O journaled with adapter name, model id, params, usage, latency,
  normalized finish reasons, and content-addressed prompt/completion artifacts
  (compact event metadata; contents live once in the object store). The recorded
  cycle supports *execution-and-decision replay* offline (baseline + candidate
  re-execution and recorded-policy decision check); full-cycle replay is deferred.
- ✅ Second task (`max-integers`) with a non-planted weakness (lexicographic max);
  the registry provably cannot fix it (control test), and the model *pipeline*
  promotes a fix supplied by a scripted proposal fixture — pipeline proof, not
  model reasoning.
- ✅ Env-only real adapter (`STRIVE_MODEL_PROVIDER=openai-compatible`); no test or
  default command touches a network.

Carried into stage 3 (not done):
- Regression split grown automatically from past failures (mechanism exists, empty).
- Aggregated per-proposer-model acceptance statistics (raw telemetry is journaled;
  no reporting command yet).

The milestone claim, stated precisely: Strive can accept model-path
proposals, validate and classify them, execute candidates outside the kernel
process, compare them with an incumbent, retain decisions and lineage, and
replay execution and selection. The deterministic fixture proves pipeline
correctness; real-model proposal quality remains an untested capability
question.

**Exit criteria met with honest caveats:** the "model" in CI is a scripted proposal
fixture — it proves the pipeline (validation, gating, journaling, replay), not model
reasoning or capability. Real-model capability is untested, expected to be
model-dependent (capability floor, note 03), and gated behind an explicit
`--unsafe-model-code` acknowledgement because the sandbox lacks network/filesystem
confinement. Replay is execution-and-decision replay, not full-cycle replay.

## Stage 3A — Contract design for composite evolution ✅ (2026-08-08)

Six accepted ADRs (docs/adrs/) covering revisions+surfaces, scopes,
tasks/environments, evidence/selection, evolution algorithms, and
storage/migrations — each with rejected alternatives and a
borrowed/rejected/deferred comparison against Flex/GEPA, prime-agent,
Continual Harness, exo, RLM, and NOOA. The wire schemas went through a
revision passes before freezing: revision *state* separated from evaluation
*evidence* (revision-owned ScopeManifest + run-resolved
ResolvedHarnessManifest vs ValidationBundle-owned evaluation manifests),
globally unambiguous RevisionRef(scope, id) with base vs
provenance parents, typed ScopeRef/ResolutionContext with mask-vs-delete
semantics, environment-generic task specs (FunctionTask config carries
solve(str)->int), reconstructable dataset revisions, risk computed from
descriptor+scope+op, policy-neutral dispositions (frontier_add) each
requiring evidence, resumable AlgorithmRun/AlgorithmStep state, and
append_batch/cursor/index-through-head ledger semantics. Experimental typed
contracts (`stage3_contracts.py`, additive codec kinds, unused by the live
loop) validate every scenario with round-trip tests, including one revision
evaluated under two manifests and cross-scope lineage without collisions.
The final consistency pass added the frozen RevisionActivation@1 lifecycle
seam (field-exact activation@2 mapping incl. rollback history and derivation
parity), historical descriptor pinning (registry keyed by kind@version +
current pointer), fail-closed policy-param families with trusted settings
barred, and stronger manifest invariants (same-scope base parents, explicit
resolution chains, opaque journal-head refs). No live-ledger migration;
Stage 1–2b behavior unchanged (164 tests, 25 in the spike).

## Stage 3B — Dual-write revision storage ✅ (2026-08-09)

Exactly: **dual-write revision storage + the SurfaceDescriptor registry**,
implementing only the frozen core wire types (adrs/README freeze table):
ScopeRef/RevisionRef/BindingState/SurfaceDelta/ManifestBinding/
ScopeManifest/JournalHeadRef/ScopeContribution/ResolvedHarnessManifest/
HarnessRevision/RevisionActivation/MigrationProvenance + the historical
descriptor registry and migration-registry mechanics.
- Migration registry (ADR-0006) with `migrate-legacy` as entry 0001 and the
  generation→revision **backfill** as entry 0002 (field-exact, with
  MigrationProvenance and CAS-encoded decision evidence).
- **Dual-write**: the loop keeps writing generation-native records
  (activation/replay/cycles unchanged and generation-native) while writing
  revision@1 + revision-activation@1 alongside; revision-native
  loop/activation/replay is a later parity slice, not 3B.
- NOT in this slice (each provisional until its own slice): task/dataset/
  evaluation-manifest schemas, selection envelopes and frontier semantics,
  algorithm state, backend schema details.
- Exit criteria met, with a crash-consistency correction applied before
  merge: mirrors moved to a separate append-only journal (corruption can
  never block generation-native operations — tested); mirrors matched and
  repaired by SourceRecordRef, never list position, with active-revision
  derivation following source activation order; backfill/repair run a
  durable intent→progress→completed state machine resumable at every crash
  point, with pending status based on completion rather than parity alone;
  projection planning is pure (parity and discovery are read-only) and
  stale plans are refused under the writer lock; the projector is pinned
  (`generation-to-revision@1`, explicit historical descriptors) and source
  history is validated fail-closed; evidence is operation-specific (legacy
  activations carry no inferred decision_ref); a mirror-publication failure
  after a source commit reports `source-committed-parity-incomplete`. A
  permanent control run proves mirror-disabled and mirror-enabled runs are
  generation-identical. 182 tests. The precise claim: strive mirrors
  generation-native history into field-preserving composite revision records
  and can backfill, inspect, verify, and repair revision parity —
  revision-native execution, selection, activation, and replay remain
  future work.

## Stage 3B.1 — Derived integrity + revision shadow reads ✅ (2026-08-09)

Hardened the derived side and proved shadow parity, generation-native
behavior authoritative throughout:
- Intents pin the exact canonical source prefix (count + digest-sequence
  hash); resume verifies it exactly — appended records allowed, altered
  prefix records refused. One operation-level mirror lock spans intent
  selection/creation and all state transitions; multiple unfinished intents
  and mismatched migration_id/projector_ref refuse resume.
- Planning fails closed before publishing on mismatched/duplicated/foreign/
  unsupported mirrors; parity verifies the full artifact closure (scope
  manifests, provenance, decision evidence, pinned descriptors, source
  artifacts): missing derived objects are repairable from the pure plan,
  corrupt objects fail closed and are never silently overwritten, and a
  missing canonical source artifact is reported as data loss.
- `strive parity --rebuild` quarantines the prior mirror journal
  byte-for-byte, rebuilds mirrors + CAS closure purely from canonical
  history, validates fully, then atomically installs — recording intent,
  source prefix, outcome, and the prior mirror hash. The task ledger is
  never touched.
- Revision shadow reads: active state (by source activation order), lineage,
  rollback target, and strategy source materialized from the ScopeManifest
  under pinned descriptors; each shadowed run CAS-stores a task-only
  ResolvedHarnessManifest. Shadow checks run in run/compare/replay/promote/
  rollback/restart flows; divergences are durable `shadow-divergence`
  interventions plus run events, never silent fallbacks; no active revision
  is reported while activation parity is incomplete. Differential control:
  mirror-off, mirror-on, and shadow runs are canonically identical.
- 198 tests. Exit claim: strive can reconstruct and verify the complete
  revision artifact graph, recover derived history from canonical state, and
  shadow every generation-native read with an equivalent revision-derived
  read. Revisions still do not control execution or activation.

## Stage 3B.2 — Revision-native read/activation cutover (next)

Flip reads (then activation derivation) from generation-native to
revision-native behind the proven shadow comparison: a cutover flag makes
the revision-derived value authoritative while the generation-native value
becomes the shadow, divergence semantics unchanged; retire dual-write for
reads once a burn-in period records zero divergences. Immediately followed
by **the first empirically evaluated prompt-surface composite evolution
experiment**: a `prompt` surface delta (proposal template) evolved alongside
strategy code in one composite revision, validated under the existing paired
gate with held-out discipline — the first real use of multi-surface
revisions.

## Stage 3C — Composite generations + pluggable evolution algorithms + hardened sandbox

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
  triggers, trusted state kept outside the online loop's interfaces
  (process separation + interface discipline — not physical isolation until
  OS-level confinement lands).
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
