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
- Completion is prefix-scoped: an open intent tolerates later canonical
  records and their live mirrors (e.g. a rollback before resume); it
  validates, repairs, and completes only its declared source prefix. A
  stage-3B-era mirror journal (`migration-intent@1`) is detected precisely
  and directed to `strive parity --rebuild`.
- **Subject-specific revision shadow reads**: each concrete generation-native
  read is paired at its point of use with the revision-derived read — cycle
  baseline/candidate, compare left/right, replay baseline/candidate,
  promotion incumbent/target, rollback active/parent, audit target, and
  status/restart reads. The derived view demands exact SourceRecordRef
  coverage, the supported projector, no duplicates, full artifact closure,
  semantic validation, and bounded cycle-free lineage; derived corruption or
  unexpected exceptions degrade to *unavailable with a reason* and never
  fail a committed canonical operation. Divergences are deduplicated durable
  `shadow-divergence` interventions, never silent fallbacks; no active
  revision is reported while the view is unavailable.
- Execution provenance: every artifact execution CAS-stores a per-subject
  ResolvedHarnessManifest *before* running, naming the baseline
  (shadow-active) revision at a tamper-evident journal head (record count +
  source-prefix digest) — a run that activates a candidate still identifies
  the baseline revision that produced its evaluation.
- Shadow coverage accounting: every attempted check is durably recorded as
  agreed/diverged/unavailable/not-applicable in a derived coverage journal;
  `strive shadow` reports eligible/checked/unavailable reads and divergence
  rate. Cutover eligibility requires complete parity, zero divergences, AND
  the declared minimum coverage (0.90) — not merely the absence of
  divergence records. Differential control: mirror-off, mirror-on, and
  shadowed runs are canonically identical.
- 207 tests. Exit claim: strive shadows each concrete generation-native
  read with the corresponding revision-derived read at the point of use,
  records exact execution manifests and coverage, and remains safe under
  derived corruption. Revisions still do not control behavior.

## Stage 3B.2 — Centralized reads + reversible revision-read canary ✅ (2026-08-09)

One read boundary (`StateReader`, `strive.reader`) with durable journaled
modes — `native` (default), `shadow`, `revision-canary`:
- **Coherent snapshot.** Each operation reads the canonical entries AND the
  bytes they were parsed from in one read (`entries_with_bytes`), and the
  native view and `SourceSnapshot` both derive from that exact capture; the
  mirror capture is paired through an optimistic read-recheck loop that
  retakes BOTH captures if the canonical journal moved, so an old native
  view is never combined with a newer mirror view. Snapshots refresh only
  after the operation's own writes. Cycle, compare, replay, audit,
  promotion, rollback, provisional resolution, proposal staleness, task/
  drift guards, proposal history, seeding, status, lineage, and restart
  reads are all routed; direct Store reads remain compatibility internals.
  Mutations carry the reader's expected head — stale activation, rollback,
  seeding, and both provisional confirm/revert paths refuse.
- **Exact candidate identity.** An immutable, unactivated candidate revision
  + manifest + provenance (native `RevisionProvenance`) is created and
  fully validated BEFORE evaluation, in every mode; the evaluated artifact
  is exactly that overlay. Overlay construction failure records
  `unavailable` (canary opens the breaker before execution) — there is no
  `derived is None → native` silent path. Retention references the exact
  evaluated candidate via a `RetentionRecord` (overlay revision + decision
  evidence + retained ids), and the retained mirror is verified
  content-identical to the overlay — never a disconnected replacement.
- **One validator.** `VerifiedRevisionSnapshot` runs parity's checks —
  complete SourceRecordRef agreement both directions (schema, journal,
  ordinal, digest) with type agreement, recomputed-projection equality,
  full artifact closure, descriptor/provenance/manifest validation, bounded
  cycle-free lineage. All revision reads use it; no weaker validator exists.
- **Tamper-evident evidence.** A locked, fsynced, task-bound reader journal
  written in crash-framed, hash-chained batches (a `ReaderFrame` closes each
  batch with its payload hash and the previous frame's hash): deletion,
  reordering, and unframed forged lines are detected and never honored.
  Each check stores its mode and exact heads AT CHECK TIME; each expected
  `(op_id, subject)` gets exactly one severity-merged terminal outcome; the
  candidate-overlay and retained-candidate subjects are distinct. Outcomes
  are recorded in `finally` (denied/rejected/stale/failing included), with
  `missing` synthesized for uninstrumented subjects. Behavioral facts count
  only from successfully completed shadow/canary operations; entering shadow
  starts a new epoch. Evidence- or run-event failure in canary opens the
  breaker; telemetry never masks the canonical result.
- **Fail-closed control.** Repair, rebuild, and reader/projector version
  changes atomically open the breaker (if canary) and reset the epoch —
  never best-effort. The canary is effective only while the current epoch
  is eligible at operation start (lost eligibility or a corrupt journal
  fails closed). `clear-breaker` requires native/shadow mode, complete
  parity, and a fresh epoch, and never reactivates a canary. Enable/clear/
  mode transitions use an expected reader-journal head and persist the
  eligibility proof they authorized. A journal-independent force-native
  override (sentinel file / `STRIVE_FORCE_NATIVE=1`) is the emergency kill
  path.
- **Threat model.** The reader journal is same-UID writable while candidate
  code runs without host-enforced filesystem confinement, so canary mode is
  refused outright for real/unsafe model-generated code; a malicious-code
  test confirms forged control lines are detected and fail closed.
- 232 tests. Exit claim: strive can run a revision-derived execution/read
  canary from a coherent snapshot, with exact candidate identity,
  tamper-evident current-epoch evidence, fail-closed control transitions,
  and an independent kill path. Activation remains generation-native.

## Stage 3B.3 — Native composite revision lifecycle ✅ (2026-08-10)

The evaluated composite revision is now retained and activated as itself —
its own append-only lifecycle, not a strategy-only generation:
- **Canonical lifecycle journal** (`strive.lifecycle`, `ledger/<task>.revisions.jsonl`),
  separate from the generation ledger and the generation→revision mirror,
  written in crash-framed, hash-chained, expected-head batches over the
  shared `strive.framing.FramedJournal`. It records native revisions
  (`RevisionRetained`, pinning the exact `HarnessRevision` by CAS ref),
  activations (the frozen `RevisionActivation`), and a durable
  `LifecycleBreaker`. Active state is the latest valid activation; lineage
  is the base-parent chain. Legacy generations stay readable; the mirror
  remains derived compatibility, never the owner of native revisions.
- **Exact candidate identity, separated from evidence.** The candidate
  overlay created before evaluation (3B.2) is retained unchanged — same
  `RevisionRef`, manifest, deltas, provenance, descriptor refs, artifacts —
  for both rejected and accepted candidates. `RevisionRetained` records
  immutable IDENTITY only; `RevisionEvaluated`/`RevisionSelected` records
  are appended per assessment (one revision can be evaluated repeatedly
  under different manifests, policies, and baselines), with every evidence
  ref validated and candidate/baseline agreement enforced. Promote-like
  activation requires the CURRENT accepted selection against the active
  baseline; rejected or evidence-free revisions activate only through a
  distinct durable `TrustedOverride`. On acceptance the SAME revision is
  activated — evaluated id == retained id == activated id; an accepted
  candidate whose identity cannot be retained is refused promotion.
- **Lossless composite state.** Active state materializes from the
  complete `ScopeManifest` (every surface), never one source field. A
  deterministic code+prompt fixture (`compose_revision`) round-trips
  retain → activate → restart → rollback with both surfaces intact (the
  prompt is lifecycle-only, with no behavioral claim). The strategy-only
  generation is an explicitly-derived compatibility projection that lists,
  but never flattens, non-code surfaces.
- **Parent-manifest state replay.** Validation loads the parent's
  ScopeManifest, requires every `delta.before` to equal the parent's exact
  binding, applies all content/mask/delete/unmask transitions, carries
  unchanged bindings over, and requires exact equality with the stored
  child manifest — undeclared changes, stale before-states, mask/absent
  confusion, and dropped surfaces all fail closed (a code-only child of a
  code+prompt parent preserves the prompt, verified).
- **One recoverable activation operation.** Identity + evidence persist
  BEFORE served behavior changes; `ActivationIntent`/`ActivationProgress`/
  `ActivationCompleted` span the generation compatibility activation and
  the lifecycle activation; every crash point resumes or reconciles
  (abandoned before behavior changed; resumed after; reverted + breaker
  when the revision no longer validates). A lifecycle failure after the
  generation activation is never swallowed — the generation activation is
  reverted and the outcome recorded. Whole-revision rollback drives BOTH
  journals (served strategy changes too), and lifecycle/compatibility
  parity is exposed (`compat_parity`). Framed journals refuse appends over
  unverified regions (errors, unframed lines, torn tails); recovery goes
  through durable quarantine + truncation to the last verified boundary.
- **Upgrade history preserved.** Migration `0003-lifecycle-backfill`
  converges the lifecycle with existing generation/mirror history — an
  identity for every generation and the full activation history replayed,
  preserving the ACTUAL active revision (never just the seed); migration
  `0004-reader-journal-upgrade` migrates the exact PR#43 reader journal
  (`reader-frame@1`, old genesis) to shared framing, preserving original
  bytes (quarantined + hashed), mode, breaker, epoch, checks, summaries,
  and ordering, and failing loudly on ambiguity. Ongoing convergence runs
  at every seeding pass, so generation-native operations (promote,
  rollback) are mirrored into the lifecycle afterwards.
- **Threat model.** The hash chains are tamper-EVIDENT, not same-UID
  secure: candidate code can read and rewrite journals under the current
  sandbox. Lifecycle authority is therefore refused for unsafe
  model-generated code (generation-native evolution only, with the gap
  visible via compat parity until kernel-side convergence backfills it).
- **Compatibility + inspection.** `strive lifecycle [status|rollback|repair]`
  shows retained revisions, per-revision evidence (evaluations, selections,
  overrides), the active revision, manifest surfaces, the compatibility
  projection, and lifecycle/compat parity. Stage 1–2b commands, replay,
  parity, migrations, canary controls, and cross-task isolation are
  unchanged.
- Exit claim: strive migrates existing history and atomically retains,
  evaluates, selects, activates, recovers, and rolls back the exact
  composite revision without losing surfaces or bypassing evidence.

## Stage 3C.1 — The prompt-surface composite evolution experiment ✅ (2026-08-11)

The first empirically evaluated prompt-surface composite evolution
experiment, exercising the 3B.3 lifecycle (no parallel substrate; no Pareto
search, policy-parameter evolution, online adaptation, task refactoring, or
new sandbox tier):
- **Operational prompt surface.** `prompt/proposal-template` is a live
  task-scoped surface: pinned descriptor (`prompt@2`, materializer
  kernel-text@1), a versioned template validator (bounded size, known
  placeholder set, output contract), and kernel resolution from the active
  revision's manifest (`resolve_active_prompt`) with the built-in default
  as the explicit fallback — no static-template assumption. Every model
  request journals the prompt ref and active revision (`prompt_resolved`
  event + content-addressed prompt bytes per model call). Restart and
  whole-revision rollback restore prompt and strategy together.
- **Exact composite candidates.** Proposals may carry a bounded
  `prompt_update` (proposal@2; changed_surfaces must agree); the loop
  builds ONE immutable candidate revision containing both deltas BEFORE
  evaluation against the parent manifest (unchanged bindings carry over),
  screened kernel-side (template validity + no hidden-split content) and
  validated by the 3B.3 parent-replay/closure machinery. The exact
  evaluated revision is retained, selected, activated, and rolled back —
  never a post-evaluation reconstruction.
- **Prompt-specific evidence (no piggybacking).** A prompt delta never
  promotes on the bundled code's task scores: the trusted `promptgate`
  validator runs matched proposer trials under candidate vs incumbent
  templates (same adapter, context, parameters, budgets, metered calls),
  task-gates each template's proposed strategy, and records validity,
  selected sources, calls/tokens/cost, and regressions. A composite
  activates only when the code passes the task gate AND the prompt earns
  `improved`; when the code passes but the prompt does not, the code-only
  sibling activates and the composite is retained as rejected evidence
  (with its `SurfaceEvidence` linked to the exact revision).
- **Two-stage self-produced composite.** Arm E is no longer manually
  assembled: the incumbent proposer proposes prompt p1; p1 generates
  strategy s1 in a fresh fixed-budget call; the immutable p1+s1 revision is
  built BEFORE evaluation and the SAME id is proposed, evaluated, retained,
  selected, activated, restarted, replayed, and rolled back. D matches E on
  task score — E activates only on its own prompt evidence.
- **Stale-safe, complete prompt state.** The default template is PINNED
  into lifecycle state at seeding (`rev-prompt-default`, a journaled
  structural override), so historical revisions never depend on the current
  build's default string and rollback restores the pinned historical text
  from CAS; the built-in fallback applies only to explicitly unmigrated
  pre-prompt history. Requests pin the parent revision, lifecycle head,
  prompt ref, and descriptor ref; after the slow model call the proposal is
  rejected as stale if prompt or lifecycle state changed even when the
  generation id did not. Corruption, missing artifacts, and invalid
  templates are structured failures, never silent fallbacks.
- **Hardened descriptor.** `prompt@3` pins the versioned validator
  `prompt-template@1` (string.Formatter parsing: exact placeholder names
  only; attribute/index traversal, conversions, format specs, positional
  fields, and excessive repetition rejected; required output fields
  enforced), invoked at retention, activation, resolution, and replay;
  rendered prompts are bounded BEFORE any provider call. Proposals carry
  generic typed `surface_updates` keyed by descriptor ref (proposal@2; no
  per-surface schema fields; proposal@1 is proven event-payload-only).
- **Reproducible experiment.** Matched arms A–E over the normal metered
  paths, an `ExperimentManifest` pinning fingerprints/refs/parameters/
  budgets/arm order/journal heads/outcomes, unique run directories (reuse
  refused), and `passed` requiring valid A/B proposals, A rejected, B
  accepted, matched configuration, prompt-consumption proof, and the
  two-stage identity chain. `--real-model` results are labeled SINGLE-TRIAL
  with tokens/latency/cost/parameters recorded.
- **Honest claim boundary.** The offline fixture proves causal PIPELINE
  WIRING — the prompt artifact is consumed and changes proposer behavior
  through the real loop. It demonstrates nothing about real-model
  prompt-following; genuine model-driven prompt improvement is claimed only
  with recorded real-model evidence, and a real-model failure is an honest
  result, never a reason to weaken the gate.
- Exit claim: strive activates a self-produced prompt-plus-code revision
  only when the exact prompt improves proposal behavior under its own
  trusted validator and the exact code passes task validation; neither
  surface may piggyback on the other's evidence. The offline fixture proves
  causal pipeline wiring; genuine model-driven prompt improvement is
  claimed only with recorded (single-trial-labeled) real-model evidence.

## Stage 3C.2A — Versioned validation evidence and policy-neutral selection (done)

The ADR-0003/0004 evidence slice, frozen and integrated:

- Frozen envelopes in `strive.evidence`: `DatasetRevision@1` (per-split CAS
  manifests, parent, reason, counts, fingerprint — persisted per task in
  `ledger/<task>.datasets.jsonl`), `EvaluationManifest@1` (resolved harness
  ref, task/dataset fingerprints, environment/scorer ids, tool versions,
  runtime, seeds, validator refs, budgets, objective spec),
  `ValidatorResult@1`/`ValidationBundle@1` (role-bound: task / prompt /
  constraint; flat metrics; per-case payloads as CAS artifacts), typed
  `DecisionEvidence@1`, policy-neutral `SelectionDecision@1` (closed
  disposition vocabulary: promote / reject / frontier_add /
  provisional_activate — every disposition requires evidence), and the
  minimal trusted `ObjectiveSpec@1`. Current tasks adapted as
  `function-task@1` (`TaskSpecVersion` with the signature/catalog in the
  config blob; spec fingerprint excludes cases).
- Trusted validator registry (`strive.validators`) resolved by name AND
  version — unknown names and unknown versions of known names both fail
  closed; task evaluation, the paired comparison, promptgate, source
  screening, and budget ceilings converted into validator results.
- The activation-evidence gate (`lifecycle.activation_readiness`): promote
  requires the latest accepted selection against the CURRENT active
  baseline, a decodable SelectionDecision naming the exact
  subject/incumbent, every changed surface's required evidence role (task +
  constraint always; prompt for prompt deltas — surfaces cannot borrow or
  relabel evidence), current-dataset manifests (stale evidence forces
  incumbent RE-BASELINING, never a task-drift acknowledgement), and all
  hard constraints passed (failed or INCONCLUSIVE blocks). Activation cites
  the exact SelectionDecision; overrides remain distinct journaled records.
- Migration `0005-evidence-backfill` (idempotent, also run by seeding
  convergence): pre-envelope evaluations/selections/surface evidence gain
  `EvidenceLink`s to synthetic-but-lossless envelopes — the ORIGINAL
  evaluation/decision refs become the bundle artifacts; nothing rewritten.
- `strive evidence` inspects manifests, bundles, decisions, roles, and
  blocking/stale reasons; `strive compare` derives the recorded verdict
  from the selection envelope; replay recomputes bundle metrics and diffs
  them against the recorded envelope.
- Exit claim: strive records reconstructable, versioned validation evidence
  and policy-neutral selection decisions for every composite candidate;
  activation is authorized only by complete current evidence for the exact
  revision and active baseline.

## Stage 3C.2A.1 — Authoritative envelopes (done)

The correction pass that makes the merged envelopes AUTHORITATIVE:

- Task/dataset identity finished: evaluation manifests (v2) pin the exact
  `TaskSpecVersion` and `DatasetRevision` by CAS ref with fingerprints
  verified against what the refs decode to; the live mutation guard now
  detects task-SPEC drift (`TaskSpecBound` in the lifecycle journal, bound
  at seeding or on acknowledged drift) — dataset growth flows through the
  REAL guard with no acknowledgement, invalidates evidence, and forces
  incumbent re-baselining; unbound legacy stores keep the case-inclusive
  guard until their first clean convergence.
- Execution provenance corrected: `resolved_manifest_ref` must decode to
  the exact `ResolvedHarnessManifest` the evaluation ran under (an
  ExecutionRecord in its place fails the typed decode);
  `execution_record_ref` is pinned separately, and the gate verifies the
  record, subject revision, effective manifest, resolved baseline, and
  journal heads agree.
- Complete evidence semantics: promote requires the exact validator set
  each role prescribes, one-to-one manifest↔results agreement (no missing,
  extraneous, or duplicate results; no duplicate roles), a PASSED paired
  comparison (a noncrashing candidate suite is not acceptance), decoded
  objective specs matching across the decision and every bundle, and
  policy/subject/incumbent/evaluation/baseline artifact agreement.
- Synthetic evidence graded honestly: preserved for inspection, replay,
  rollback, and reactivation, but inferred source-screen/zero-usage
  records never authorize a fresh promotion — a modern re-evaluation
  (`selection.record_assessment`, the shared loop/experiment/fixture
  path) is required.
- Hard constraints + storage safety: budget validation covers all seven
  dimensions with the meter's exact limit semantics; dataset revision
  creation is locked, expected-head checked, crash-safe (torn tails
  quarantined under the lock; interior corruption never auto-repairs),
  idempotent, and CAS-closure verified — with concurrent-writer and
  crash-injection tests.
- Exit claim: strive authorizes activation only from reconstructable
  evidence whose task, dataset, harness state, validators, objectives,
  budgets, subject, and baseline all match the exact evaluation that
  produced the decision.

## Stage 3C.2B — Secure local execution + the model-capability lane (done)

Secure candidate execution and a genuine model-capability lane, before
comparing algorithms (ADR-0007):

- A trusted, versioned `SandboxBackend` boundary (`strive.sandboxes`) with a
  capability report, per-execution provenance, and a fail-closed registry
  that never silently downgrades a requested backend.
- `process-fault-only@1` (renamed honestly; fixtures/trusted code only),
  `deno-pyodide@1` (the shipping SECURE local backend — DSPy's
  `PythonInterpreter` over Deno+Pyodide WASM: no host filesystem, network,
  environment, or subprocess; fresh interpreter per case; parent-side
  wall-clock hard-kill), and `linux-landlock-seccomp@1` (a NOOA-derived
  Apache-2.0 spike, available only on a probe-confirmed Linux kernel).
- Protected evaluation runs each held-out/regression/adversarial/audit case
  in a FRESH sandbox that sees only `input_text` — no repo, CAS, ledger,
  journal, task definition, credentials, home, or host socket reachable, and
  no candidate state across cases (`strive.protected`).
- Sandbox provenance pinned into `EvaluationManifest` (v3); evidence from
  different backends is distinct and replay demands the recorded backend.
  Lifecycle authority is granted for model-generated code only under a
  mechanically-secure backend.
- The model-capability lane (`strive.capability`, `strive capability`):
  repeated seeded real-model trials (OpenAI-compatible adapter, incl. local
  vLLM/Ollama) executed inside the secure backend, with honest aggregate
  verdicts (supported / inconclusive / negative). Fixtures and single trials
  are never capability evidence.
- Exit claim: strive can execute real model-generated candidates locally
  without granting host filesystem, network, secret, or cross-case access,
  and can separate deterministic pipeline tests from repeated
  model-capability evidence.

## Stage 3C.2C — Budget-matched algorithm comparison (next)

A separate experiment using the 3C.2A envelopes and the 3C.2B secure
backend UNCHANGED: `hill-climb@1` (today's loop, extracted behind the
`EvolutionAlgorithm` protocol) versus a GEPA-style `pareto-population@1`
(frontier maintained via journaled `frontier_add` dispositions) under equal
trusted budgets over the same task set — the first
pluggable-evolution-algorithm experiment (ADR-0005).

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
