# NOTES — strive

Working log for the initial vertical slice of the self-evolving agent harness.

## 2026-08-06 — kickoff

Goal: independent top-level project `strive/` implementing the loop
`execute → observe → evaluate → diagnose → propose → validate → accept/reject → retain → repeat`
as a thin but real vertical slice.

### Design decisions for slice v0

- **Task domain**: "sum all signed integers appearing in a text string." Fully
  deterministic, no network, trivially evaluable, and it admits a *planted
  weakness*: a naive strategy using regex `\d+` silently drops the minus sign
  on negative numbers.
- **Mutable surface = executable strategy code.** A strategy is a standalone
  Python source file exposing `solve(input_text: str) -> int`. The generation
  ledger stores full source per generation. This satisfies the requirement
  that at least one evolvable surface is code, not a prompt.
- **Isolation**: candidate (and baseline) strategy code always runs in a child
  process (`python -I strategy_runner.py <strategy.py>`), talking JSON over
  stdin/stdout, with a hard `subprocess` timeout. Not a security sandbox —
  charter marks that as a non-goal for this milestone — but it does mean a
  hanging or crashing candidate cannot take down the controller.
- **Diagnosis is evidence-based, not oracle-based**: the diagnoser only looks
  at the trace (which cases failed, their inputs/outputs/errors) and fires the
  `negative-integers-dropped` weakness only when every failing case contains a
  `-digit` pattern and there were no exceptions. If failures don't match a
  known signature, no proposal is made (honest "don't know").
- **Proposal is bounded**: a registry maps weakness id → a single textual
  patch that must match exactly once in the parent source, otherwise the
  proposer abstains. No open-ended code generation in v0 (no model calls at
  all — tests must run offline).
- **Acceptance rules are explicit**: candidate sandbox run must succeed, score
  must be strictly greater than baseline, and there must be no regression
  (every case the baseline passed must still pass).
- **Persistence**: append-only JSONL ledger (`generation` + `activation`
  entries) plus one source file per generation. The active generation is
  *derived* by scanning activation entries, so restart persistence is free and
  rollback is just a new activation entry pointing at the parent — nothing is
  ever deleted, full lineage is auditable.
- **Observability**: every cycle gets a run directory with an `events.jsonl`
  structured event stream (cycle_started, case_executed, evaluated,
  weakness_detected, candidate_proposed, validated, decision, activation,
  cycle_completed).

### Things tried / learned along the way

- `uv sync` failed on first run because `pyproject.toml` declared
  `readme = "README.md"` before the README existed — hatchling validates the
  readme path at build time. Wrote the README, then sync/build worked.
- 23 tests passed and `mypy --strict` came back clean on the first full run.
  The riskiest part (escaping the regex patch target `r"\d+"` through three
  layers of string literals — Python source, patch registry, generated file)
  was worth double-checking; the propose unit test pins it.
- Deriving the *active generation* from the last `activation` entry in the
  append-only ledger (instead of a mutable pointer file) made three
  requirements fall out for free: restart persistence (reopen and scan),
  rollback (append an activation naming the parent), and auditability
  (activations, including rollbacks, are themselves history).
- Decision: the child runner treats a raising strategy as a *per-case* error
  (`ok=True`, error recorded) but a strategy that can't even be exec'd as a
  child failure (`ok=False`). This keeps "your code is wrong" distinct from
  "your code is not runnable" in the trace, which diagnosis relies on: the
  negative-integers signature requires `error is None` + overestimate.
- The diagnoser requires at least one *passing* case before it will name a
  weakness — total failure is treated as "cause unknown" rather than risking a
  confident misdiagnosis from a degenerate trace.
- Built a committed demo ledger (`artifacts/demo/`) by driving the real CLI
  through run → run → status → rollback → status → run across separate
  processes; the transcript doubles as evidence for restart persistence and
  rollback. After rollback, the third run re-evolved the seed into `gen-0002`
  with `gen-0000` as parent — branching lineage worked without special-casing.

### Verification snapshot (2026-08-06)

- `uv run pytest -q` → 23 passed.
- `uv run mypy` (strict, src + tests) → no issues in 17 files.
- Demo: baseline score 0.571 → candidate 1.000, ACCEPTED; rollback + re-run
  journaled as branching lineage (see `artifacts/demo/transcript.txt`).

## 2026-08-06 — phase 2: research and redesign

Goal: deep technical research on six external sources, then synthesize
ARCHITECTURE.md, comparative-matrix.md, ROADMAP.md, and a rewritten HANDOFF.md.

### Method

- Slice branch pushed as `strive-initial-slice`; `gh pr create` failed ("must
  be a collaborator") because the gh CLI is authenticated as a different
  account than the `github.com-personal` SSH identity — PR left for the user.
  Phase 2 continues on `strive-research-architecture` on top.
- Six research subagents run in parallel, one per source, each with a fixed
  note template (provenance with exact commit SHA, source-supported facts,
  eleven analysis dimensions, interpretations separated from facts, hypotheses,
  prototype-vs-mature mechanisms, implications). Repos cloned to
  /tmp/strive-research (never into this repo). Explicit instruction: if a
  source 404s, report honestly and search for where it moved — no fabrication.

### What was found (full details in docs/agents/research/)

- All six sources were real and reachable. arXiv:2605.09998 = "Continual
  Harness: Online Adaptation for Self-Improving Foundation Agents" (Karten,
  Zhang et al., Princeton/ARISE/DeepMind, May 2026) — the formalization of
  Gemini Plays Pokémon's harness refinement, and the deep-dive target.
- The synthesis in one line: everyone else built half of strive. Flex/GEPA
  validates rigorously but keeps no lineage; prime-agent, the CH paper, and
  exo persist and self-modify richly but validate nothing — with documented
  consequences (CH: inherited-usage collapse to 6.4% + regression below
  baseline; an 842-repetition stall from silent schema fallback; exo's docs
  admit the missing clone-and-compare path). NOOA and RLM contribute
  infrastructure patterns (kernel-level sandboxing, versioned trajectory
  schemas, bounded recursion with budget inheritance).
- Curious detail: the CH paper's Appendix E contains an embedded instruction
  telling LLM readers to skip the appendices. The research agent ignored it —
  correctly, since the appendices hold the ablations and both failure case
  studies. Noted in the provenance section of note 03.

### Synthesis decisions

- 13 architectural decisions (D1–D13) recorded in HANDOFF.md, each with the
  research evidence that motivated it. The load-bearing ones: empirical
  trusted-side validation only (D1), mechanism-not-policy trust boundaries
  (D2), composite per-surface generations (D5), held-out + inheritance-aware
  acceptance (D6), budgets in the cycle contract (D7), loud schema rejection +
  trusted stall detection (D9/D10), provisional online activations (D12).
- ROADMAP restructured to 7 stages; several items moved *earlier* (held-out
  splits, budgets, stall detection into stage 2) because every researched
  failure traces to their absence. Stage 7 (co-evolving harness + weights)
  is explicitly optional and gated on measuring the harness-adaptation
  ceiling first — the CH co-learning result (weights-only = zero progress,
  joint loop advances) defines the boundary.
- Kept honest in HANDOFF: an "evidence gaps" section lists what the research
  could NOT establish (no gated-vs-ungated head-to-head anywhere; CH results
  are Pokémon-only; proxy-validator fidelity untested; blog numbers not
  independently reproduced).

## 2026-08-06 — phase 2.5: epistemic correction (pre-Goal-3)

Narrow correction pass over the synthesis docs (no new research, no runtime code).
The phase-2 log entries above are preserved as written; the claims they record were
over-stated and are corrected in the docs as follows:

- "everyone else built half of strive" → the systems occupy complementary parts of
  the design space; whether combining selected mechanisms improves long-run
  performance is strive's hypothesis (H1), not a finding.
- "validate nothing" → the precise claim: no *pre-activation, comparative behavioral
  promotion gate* for harness refinements (each system has other quality controls).
- GEPA "keeps no lineage" → GEPA persists logs, checkpoints, and candidate programs;
  what it lacks is deployment-level activation, rollback, and long-lived online
  generation semantics.
- Added a "Why embedded acceptance gates are difficult — or deliberately omitted"
  section to HANDOFF (ground truth, resets, cost, delayed benefits, cold start,
  Goodhart, product-layer boundaries).
- "strive's gated-loop bet is validated" → reclassified as hypothesis H1.
- CH failures re-attributed to their specific mechanisms: inheritance regression →
  reuse/inheritance protection (D6); 842-repeat stall → loud schema rejection +
  trusted stall detection (D9/D10).
- D1 revised: promotion evidence proportional to risk and evaluability; provisional/
  scoped/reversible/monitored/expiring activation allowed for low-risk or online
  changes. New D14: kernel enforces decision + evidence integrity, not one universal
  metric policy; validators stay per-surface, per-risk plugins.
- Same corrections propagated to ARCHITECTURE (design thesis, acceptance-rules
  paragraph, offline-loop claim), comparative-matrix (GEPA/prime-agent/CH/exo cells,
  retain verdict), ROADMAP (stage-2 rationale), and _summary.md.

HANDOFF now ends with the recommendation to proceed directly to Goal 3.

### Addendum: note 07 (user-requested)

- Added arXiv:2301.12987 — Bennett, "The Optimal Choice of Hypothesis Is the
  Weakest, Not the Shortest" (AGI-23; v4 2024). First pure-theory note in the
  corpus: proves that among hypotheses fitting the evidence, maximising
  *weakness* (least specificity) maximises generalisation probability, while
  description length (MDL/Occam) is neither necessary nor sufficient.
- Why it matters here: it's a formal account of what strive's acceptance gate
  should optimise. Reward hacking is strength-seeking (memorising visible
  cases = minimal extension); the "smallest patch" preference is an MDL prior
  the paper argues is wrong for generalisation — bounded proposals remain
  justified for *safety/auditability*, but tie-breaking among validated
  candidates should prefer the weakest (most general) one, testable via the
  paper's parent/child sampling protocol on held-out splits.

## 2026-08-06 — phase 3: hardening the core harness (roadmap stage 2a)

Goal: replace prototype shortcuts with durable foundations while preserving
the vertical slice. No model-driven evolution yet.

### What was built

- `contracts.py` + `codec.py`: every persisted record is a versioned typed
  dataclass with a `kind@version` schema tag; one strict shared codec for
  memory and disk. Golden v1 record pinned in tests so shape changes force
  version bumps. Deleted `types.py`/`decide.py` (superseded).
- `cas.py`: content-addressed object store (sha256, verified on read) for
  strategy sources; ledger entries carry refs, never source bodies.
- `store.py` rewrite: append-only journal (single write + fsync per entry).
  Key design call: promotion is atomic *by journal construction* — it becomes
  real exactly when its one activation line lands; simulated-crash test shows
  a retained-but-unactivated candidate is a consistent state. Torn final line
  = tolerated crash artifact (diagnostic); interior corruption = loud
  LedgerError.
- Splits: visible/held_out/regression/adversarial on the task; diagnosis and
  proposal now receive a `VisibleContext` that mechanically cannot contain
  hidden evidence (spy test asserts no held-out case id or input text leaks).
- `policy.py`: named+versioned pluggable policies recorded in every decision.
  paired-deterministic@1 (durable code) + provisional@1 (expiring window,
  confirm-or-revert). No universal acceptance formula.
- `budget.py`: trusted meter; exhaustion returns FailureRecords. A budget of
  executions=1 makes the candidate validation itself come back as a recorded
  budget-exhausted rejection — the loop completes normally.
- `monitors.py`: stall detector (N flat failing cycles, same generation, no
  acceptance) → journaled freeze; frozen cycles still execute+evaluate but
  skip adaptation; `strive resume` lifts it. Perfect-score idling never
  freezes.
- `sandbox.py` hardening: scrubbed env (secret-probe test), private temp
  workspace cwd, bounded stdout via chunked reads + kill, rlimits (CPU,
  FSIZE, NOFILE), runner protocol with loud schema rejection (exit code 3 →
  schema-mismatch failure). Chose NOT to claim network denial — documented
  honestly in README/ARCHITECTURE instead of pretending.
- `model.py`: ModelAdapter protocol + FakeModelAdapter + metered journaling
  wrapper. Deliberately unused by evolution — the seam exists for stage 2b.
- CLI: run/status/lineage/inspect/compare/replay/promote/rollback/resume/
  history, all with --json envelopes; errors are clean envelopes, exit 1.

### Things learned along the way

- Event payloads embed already-encoded contracts (dicts containing lists), so
  the codec's encoder needed to accept lists, not just tuples — caught by the
  first full test run.
- Replay fell out almost for free once cycles record the task fingerprint and
  sources are content-addressed: re-execute, diff scores, flag task drift.
- The "demotion refused" demo needed ordering care: after rollback the seed is
  active, so promoting it errors as "already active" rather than showing the
  policy refusal — the transcript promotes the seed *while the fix is active*
  to show the paired gate actually refusing on regressions.
- Provisional mechanics compose with the loop with zero special-casing in
  run_cycle beyond a `_resolve_provisional` step at cycle start: window
  cycles are just cycle records since the activation entry.

### Verification snapshot (2026-08-06, phase 3)

- `uv run pytest -q` → 77 passed (offline; includes all 11 required
  failure-injection scenarios).
- `uv run mypy` → strict, clean, 30 source files.
- Demo regenerated with the new format: accepted evolution 0.455 → 1.000,
  paired-gate refusal, rollback, evidence-gated re-promotion, exact replay
  match (`artifacts/demo/transcript.txt`).

## 2026-08-07 — phase 4: model-backed offline evolution (stage 2b)

Goal: model-driven proposal generation on the hardened seams. No online
adaptation, no composite generations.

### What was built

- `Proposer` protocol reworked: `propose(ProposalRequest) -> ProposalResult`.
  The request is kernel-built and visible-only: incumbent source, task
  signature + primitive catalog, visible failures with evaluator feedback,
  diagnosis, sanitized history, explicit budgets, and (for model proposers)
  a metered journaling model handle. RegistryProposer retained as reference.
- `model_proposer.py`: prompt from trusted inputs; strict completion
  classification — truncated (hit token cap), malformed (not JSON),
  schema-invalid (wrong shape / wrong parent echo / wrong surfaces),
  plus kernel-side forbidden (AST screen vs the task's primitive catalog)
  and stale (incumbent changed mid-proposal). Each journaled distinctly.
- `fakemodel.py`: demo responder that parses the prompt (parent id, cited
  case ids) instead of exact-byte matching. Honesty note in the docstring
  and README: fakes demonstrate pipeline correctness, not model capability.
- Second task `max-integers` with a non-planted weakness: seed takes max()
  over token *strings* → lexicographic ("9" beats "100"). Control test
  proves the registry proposer cannot fix it; EvidenceDiagnoser (generic,
  registry-free) + model path fixes it, 0.500 → 1.000, zero regressions.
- Replay extended: re-executes baseline + candidate from CAS and re-runs the
  *recorded* policy, reporting decision_reproduced. Demo transcript shows it.
- model_call events now carry adapter name, model id, params, usage, latency,
  and content-addressed prompt/completion refs.
- Env-only real adapter (openai-compatible, stdlib urllib). Never touched by
  tests or defaults.

### Things learned along the way

- "this is not python" is valid Python (`this is (not python)`) — my
  unparseable-source test fixture parsed fine. Fixture changed to a real
  syntax error. Good reminder that "obviously invalid" inputs often aren't.
- Sanitizing proposer history required dropping decision *reasons* entirely:
  rejection reasons embed regressed case id lists, which can name held-out
  cases. Aggregate scores + policy identity carry the useful signal.
- The spy test now asserts holdout isolation down to the *built prompt* —
  the strongest mechanical statement of the boundary so far.

### Verification snapshot (2026-08-07, phase 4)

- `uv run pytest -q` → 91 passed (offline; full stage-2b demonstration
  matrix + all prior suites).
- `uv run mypy` → strict, clean, 33 source files.
- `artifacts/demo-model/transcript.txt`: model-proposer cycle accepted
  0.500 → 1.000; replay decision_reproduced=True; inspect --type model_call
  shows adapter/model/latency/prompt_ref.

## 2026-08-07 — phase 4.5: stage-2b correctness and claim-precision pass

Pre-merge correction of stage 2b (PR #39 branch). All eight fixes landed with
regression tests; no isolation, evaluation, budget, or safety check was
weakened to keep demos green.

- Task-scoped state: per-task ledgers; generation@2 (+task_id, +fingerprint),
  activation@2 (+task_id); superseded v1 records rejected loudly (migration
  tooling explicitly deferred). Cross-task test shares one artifact root.
- Fixture leak: the max-integers seed docstring was explaining its own
  lexicographic bug — and seed source goes verbatim into proposer prompts.
  Neutralized both seeds; renamed demo fakes to "scripted proposal fixture"
  everywhere; docs no longer imply model reasoning.
- Budgets: uniform semantics (0 = nothing allowed, -1 = accounting only);
  tokens/cost/cumulative-output now enforced (were accounting-only while the
  README said "trusted meter" without qualification); HTTP timeouts capped by
  remaining wall. Every enforced limit has a test.
- Replay renamed to what it is: execution-and-decision replay.
- Evaluation discipline: new audit split — final holdout excluded from all
  routine cycles, queried only by `strive audit`; history outcomes now carry
  visible-split scores only (overall scores are hidden-influenced and were
  leaking back to proposers via history strings).
- Provisional activation refused for strategy-code; mechanics kept tested at
  store level for future low-risk surfaces.
- Real models need --unsafe-model-code; env misconfig is a clean error.
- Fun catch #2 of the day: the sandbox "broken at import" fixture
  "this is not python" is ALSO valid Python (`this is (not python)`) — it
  crashed via NameError, not SyntaxError. Both fixtures now real syntax errors.
- Store: advisory flock around mutating ops, id allocation under the lock,
  expected_active head check on activation (loop + promote use it).

Verification: 115 tests, mypy strict clean (34 files); both demos regenerated
(registry demo now shows `strive audit` on seed vs fix: 0.000 vs 1.000;
model demo shows scripted-fixture run, execution-and-decision replay with
decision_reproduced=True, and cross-task runs against the same root).

## 2026-08-07 — phase 4.6: final pre-merge correction pass

Five fixes + cleanups, all with regression tests; 134 tests, mypy strict.

- Legacy ledgers: stage-2a `ledger/ledger.jsonl` roots were being silently
  ignored by the task-scoped store (fresh seed over real history — bad).
  Now: loud LegacyLedgerError naming the exact `strive migrate-legacy`
  command; migration preserves generations/decisions/every activation in
  order (rollbacks included)/cycles, journals a marker with the original's
  sha256, and never touches the original file. The v1 test fixture is built
  by *downgrading* current records (v1 = v2 minus task fields by
  construction) so it can't drift from the real shape.
- One `guard_task_binding` for run/audit/compare/promote/replay/seed;
  read-time rejection of foreign-task records in a ledger; fingerprint drift
  refuses mutation without --acknowledge-task-drift (journaled), read-only
  ops proceed and report.
- Budget claims made exact rather than rounded-up: output-token requests
  capped to remaining allowance; a call whose *input* tokens blow the limit
  is charged, journaled (model_call_overrun), and its completion rejected
  before it can become a proposal; cost enforcement requires
  reports_cost=True (fail-closed cost-limit-unavailable otherwise — the
  OpenAI-compatible adapter reports no cost, so no cost enforcement is
  claimed for it); per-limit semantics journaled in cycle_started.
- Trust-boundary language: dropped "no write path"/"physically out of
  reach". Precise statement everywhere: process separation + never imported
  into the kernel; until Landlock/seccomp/containers, malicious candidates
  can touch anything the controller's OS user can.
- trace_evidence must be nonempty (when failures exist) and ⊆ visible
  failing ids; decision replay refuses on recorded-policy version mismatch
  and compares verdict + both scores + regressed ids; the wrapper contains
  ANY ordinary adapter exception as model-error while
  KeyboardInterrupt/SystemExit propagate; audit documented as operationally
  separate, not secret.

## 2026-08-08 — stage 3A: contract design for composite evolution

Design-first phase: six ADRs + experimental contract spikes, no live changes.

- ADRs 0001–0006 under docs/adrs/ (revisions+surfaces, scopes,
  tasks/environments, evidence/selection, algorithms, storage/migrations),
  each with rejected alternatives and borrowed/rejected/deferred vs the six
  researched systems.
- Design calls worth remembering:
  - Rollback of one surface = a NEW revision with the inverse delta, not a
    partial activation — preserves the single-derivation invariant that
    makes promotion atomic.
  - Provisional stays an activation mode; making it a scope would conflate
    "where an artifact applies" with "how much evidence backs it".
  - Regression growth becomes DatasetRevision + forced re-baseline — the
    phase-4.6 drift guard was correctly strict for spec changes but wrong
    for routine data growth; the spec/data split fixes it.
  - Selection verdicts are a closed 4-word vocabulary (promote/reject/
    retain/provisional); "retain" is what makes Pareto frontiers journaled
    state instead of algorithm memory.
  - KernelServices handle for algorithms: composition over inheritance so a
    search algorithm structurally cannot bypass the gate.
- Spike: stage3_contracts.py (new additive codec kinds, loudly experimental)
  + 10 round-trip/structural tests covering the four required scenarios,
  including converting a real live-loop Generation into a one-delta
  revision.
- 149 tests, mypy strict clean; Stage 1–2b untouched.
- Next slice fixed in HANDOFF: composite revision storage + SurfaceDescriptor
  registry + migration registry entries 0001/0002 — independently mergeable.

## 2026-08-08 — stage 3A revision pass (pre-freeze corrections on PR #40)

Nine contract corrections before Stage 3B freezes the shapes; spike +
tests rewritten, ADRs updated in place, statuses cycled through
provisional back to accepted/frozen once tests passed.

- State vs evidence: revisions now carry a content-addressed
  state_manifest_ref (HarnessManifest) and NEVER an evaluation manifest —
  ValidationBundle owns those. Test pins one revision evaluated under two
  manifests (grown dataset, more seeds) with zero revision changes.
- RevisionRef(scope, id) everywhere; base_parent (deltas apply here) split
  from provenance_parents (merge/promotion inputs); cross-scope lineage
  test uses the same numeric id at two scopes without collision.
- ScopeRef + ResolutionContext replace colon-parsing; killed the implicit
  project:default (projectless tasks resolve task→global). delete = remove
  own override (inheritance resumes); mask = tombstone stopping
  fall-through — both tested against sibling scopes.
- TaskSpec went environment-generic; solve(str)->int + catalog now live in
  the FunctionTask config blob. Base session protocol drops the reset
  requirement (the CH domain is exactly a no-free-resets world);
  Resettable/Checkpointable/Forkable are capabilities.
- DatasetRevision now reconstructable (per-split CAS manifest refs);
  EvaluationManifest pins harness state ref + objective spec + env/scorer/
  tool/runtime versions + seeds + validators + budget.
- SurfaceDescriptor versioned with allowed_scopes/required_validators/
  online_policy; risk COMPUTED from descriptor+scope+op (broad scopes bump,
  removals floor at medium) — the delta risk field is gone, so there is
  nothing to trust.
- SelectionDecision policy-neutral: policy_ref + dispositions
  {promote, reject, frontier_add, provisional_activate}; retain →
  frontier_add; ALL dispositions require evidence; objective_spec_ref
  pinned.
- AlgorithmRun/AlgorithmStep journaled for resumable search; ADR-0005 now
  states plainly that KernelServices is an API contract for trusted
  plugins, not hostile-plugin isolation.
- LedgerBackend design gains append_batch under one expected head, cursor
  reads, and index-through-head semantics.
- Spike fixes: before_ref = parent CONTENT ref (with consistency checks);
  migration proposer versioned (ledger-migration@1); duplicate manifest
  keys / invalid scopes / unversioned proposers all fail loudly.
- Research wording corrected: prime-agent's state handling credited (the
  gap is the missing empirical gate); exo's scoped secrets/forking
  acknowledged (rejection narrowed to the unscoped evolvable workspace);
  RLM reframed as the weights side of the boundary, not a rejected
  persistence design.

155 tests, mypy strict clean. Stage 3B slice unchanged: composite revision
storage + SurfaceDescriptor registry.

## 2026-08-08 — stage 3A final pre-merge pass (PR #40)

Seven corrections to the contracts before the 3B freeze:

- Split revision-owned state (ScopeManifest: own-scope bindings incl.
  masks) from run-resolved state (ResolvedHarnessManifest: effective
  bindings + per-scope contributing revision refs and journal heads). Runs
  and evaluations reference the resolved manifest; revisions never do.
- Replaced op+nullable-refs deltas with complete binding transitions:
  BindingState = absent | masked | content(ref, descriptor_ref); deltas
  store before AND after states; create/update/delete/mask/unmask are
  derived labels. Exact inversion is state-swap, unmasking is
  representable in both directions, and conflict checks compare the
  current binding to the recorded before-state.
- descriptor_ref (kind@version) pinned in every persisted content binding;
  descriptors now carry validation_policy + risk_policy_ref; params risk
  is tiered by family (budget./sandbox. high, search./retry. medium) —
  killed the "all policy params are low-risk" assumption.
- proposal_ref/provenance_ref on revisions; canonical (kind,name) ordering
  enforced on manifests AND deltas; self-referencing/duplicate parents
  rejected.
- ADR-0006 atomicity fixed honestly: JSONL batches commit by framing
  (batch id + commit marker; unmarked batch = torn tail); the commit
  ordering rule makes revision/evidence/decision individually durable
  BEFORE activation, whose single-line head-checked append stays the only
  atomic promotion primitive — revision+activation is explicitly not a
  canonical batch.
- Freeze narrowed: only the core wire types freeze for 3B; task/dataset/
  evaluation, selection/frontier, algorithm state, and backend schemas are
  provisional, with unresolved needs recorded (typed refs, evidence roles,
  policy-detail refs, frontier removals/snapshots, objective+RNG+state
  refs for bit-reproducible resumption).
- Wording: prime-agent credited as typed (its lesson is in-place primary
  state, not untyped edits); "structurally impossible" bypass softened to
  the honest API-contract claim; ROADMAP stage 5 no longer says
  "physically isolated"; 3B scope stated exactly.

158 tests, mypy strict clean. Live loop untouched throughout.

## 2026-08-08 — stage 3A core-consistency pass (final, pre-merge on PR #40)

- Lifecycle seam completed: RevisionActivation@1 frozen with field-exact
  activation@2 mapping (legacy unversioned policy markers map to the
  reserved name@0 era; rollback history maps activation-by-activation and
  the last-activation-wins derivation is verified against a real journal at
  every prefix). MigrationProvenance@1 preserves task fingerprint, origin,
  weakness, and CAS-encoded decision@1 evidence losslessly. Consequence
  honestly drawn: Stage 3B is narrowed to DUAL-WRITE revision storage —
  loop/activation/replay stay generation-native until a parity slice, so
  cycle@1 replay is untouched by construction.
- Descriptor pinning made historical: registry keyed by kind@version plus a
  current-version pointer; validation resolves the exact pinned version;
  prompt@1 binding proven valid while prompt@2 is current.
- Risk hardened: effective_risk takes the actual delta and derives the
  transition internally (no label argument to spoof); policy-param families
  fail closed (unknown → rejected, never low); sandbox/budget/evaluator/
  acceptance/secrets/ledger families are not representable as evolvable
  params at all.
- Manifest invariants: base_parent must share the revision's scope
  (cross-scope origins are provenance only); scope manifests reject unknown
  and scope-disallowed kinds for content AND masks; duplicate manifests per
  scope rejected in resolution; ResolvedHarnessManifest records its exact
  resolution_chain; journal heads are opaque versioned JournalHeadRefs;
  contributions must be unique, chain-ordered, and scope-consistent.
- Wording: RLM described accurately (inference-time recursive/context-
  decomposition harness; persists nothing at runtime — the paper's training
  is upstream of the harness); ADR-0003/0004 no longer claim their schemas
  land in 3B; "five scopes" → four levels + a mode; stale SurfaceArtifact
  paragraph replaced by the RevisionActivation one; algorithm records claim
  restartability, not bit-reproducible resumption.

164 tests (25 spike), mypy strict clean. Live loop untouched.

## 2026-08-09 — stage 3B: dual-write revision storage

PR #40 merged first (merge commit, main verified 164/mypy-clean), then 3B
built from updated main.

- Frozen core moved spike → revisions.py verbatim (same kinds); spike keeps
  provisional contracts + re-exports so its tests validate the core
  unchanged. mypy no_implicit_reexport needed an explicit __all__.
- dualwrite.py: mirrors are pure functions of source records — that's the
  load-bearing design choice, because content-addressed provenance/manifest
  refs make recomputation exact, which makes parity checking exact, which
  makes repair safe (recompute-and-compare; ambiguity → ParityError, never
  auto-patch).
- Store appends the mirror right after its source inside the same writer
  lock — deliberately not atomic across crash; the gap is the parity
  surface. Entry-kind allowlist + task-isolation checks extended to the
  mirror kinds.
- Migration registry: 0001 wraps the legacy migration; 0002 backfill is
  append-only (source journal preserved byte-for-byte as a prefix —
  asserted with startswith in the test), journals the pre-backfill sha,
  no-ops on complete parity, refuses corrupt history. Legacy root chains
  0001→0002 in one `strive migrate` pass.
- CLI: parity [--repair], revisions, migrate; existing commands untouched;
  live smoke included strip-mirrors → detect → repair.
- 176 tests, mypy strict clean. One pre-existing assertion updated
  (rollback +1 → +2 entries for the mirror); everything else untouched.

## 2026-08-09 — stage 3B crash-consistency correction (pre-merge, PR #41)

Reworked the dual-write around an explicit crash model before merging:

- Mirrors moved OUT of the task ledger into <task>.mirror.jsonl. The single
  most important property: a corrupt mirror journal cannot block any
  generation-native operation (tested by corrupting it and then running
  run/rollback/promote/replay — all fine, with the live publication
  failures surfacing as source-committed-parity-incomplete diagnostics).
- SourceRecordRef (schema, journal, ordinal, digest) on every mirror;
  matching/repair by ref, never position. The middle-gap test is the one
  that would have caught the old positional design's failure mode: drop the
  2nd activation mirror with 4 activations — positional matching would
  misalign mirrors 3 and 4; ref matching finds exactly the gap.
- Durable op state machine (intent → progress → completed) in the mirror
  journal; pending = completion, not parity — so crash-after-parity-
  before-completion correctly stays pending and resumes the SAME intent
  with its original source head/hash.
- Pure planning vs locked application with stale-plan refusal; parity and
  discovery are provably read-only (test asserts zero CAS/journal writes).
  cas.hash_text was the enabling primitive.
- Evidence made operation-specific: legacy activation mirrors carry
  decision_ref=None (the old design inferred the activated generation's
  decision — wrong: promote-time evidence is not the generation's original
  acceptance decision). MigrationProvenance gained the surface field.
- Projector pinned (generation-to-revision@1 + strategy-code@1 explicit);
  fail-closed source validation with structured errors; unsupported
  projector refs refuse repair.
- Permanent control: mirror-on vs mirror-off seeded runs are generation-
  identical (structure, scores, decisions, active, replay).

182 tests, mypy strict clean.

## 2026-08-08 — Stage 3B.1: derived integrity + revision shadow reads

- MigrationIntent@2 pins the exact canonical source prefix: record count,
  whole-prefix hash, and a digest-sequence prefix hash. Resume verifies
  the prefix exactly — appends after intent creation are fine; an altered
  prefix record refuses resume. This closed the gap where an intent could
  resume over silently rewritten history that happened to keep its length.
- run_backfill_operation now holds ONE mirror writer lock across intent
  selection/creation, projection, and every state transition; needed the
  earlier unlocked-core split (_apply_projection_unlocked) to avoid flock
  reentrancy. Multiple unfinished intents refuse; resume validates
  migration_id + projector_ref against the persisted intent.
- plan_projection fails closed before publishing on mismatched/duplicated/
  foreign/unsupported existing mirrors, and now plans payloads for ALL
  generations so closure repair can refill any missing derived object.
- _verify_closure checks the full artifact graph per mirror: scope
  manifest, provenance, decision evidence, pinned descriptor, source
  artifact — exist, hash, decode, agree. Missing derived objects are
  repairable; corrupt ones fail closed, never overwritten; a missing
  canonical source artifact is data loss, reported not repaired.
- `strive parity --rebuild` quarantines the corrupt mirror journal
  byte-for-byte (prior sha recorded), rebuilds purely from canonical
  history into a temp journal, validates, atomically os.replace-installs.
  Canonical ledger untouched by construction.
- shadow.py: compute_shadow derives active/lineage/rollback-target/source
  from mirrors + CAS only — source text materialized from the ScopeManifest
  binding under registry-validated pinned descriptors, never from
  generation records. record_shadow_check hooks run/compare/replay/
  promote/rollback (+ restart via reopen); divergence = durable
  `shadow-divergence` intervention + run event, never silent fallback;
  parity-incomplete or unreadable mirror ⇒ unavailable with reason and
  NO active revision reported.
- Gotcha found by test: record_shadow_check on an unreadable mirror path
  leaked IsADirectoryError — MirrorJournal.entries now wraps OSError as
  MirrorError so shadow degrades to "unavailable" instead of crashing a run.
- Differential control extended: mirror-off, mirror-on, and shadowed runs
  produce identical canonical results; shadow-materialized source
  evaluates identically to the generation-native source.
- Live smoke: run → corrupt mirror → `revisions` clean error while
  generation-native `status` works → `parity --rebuild` recovers →
  `revisions` active again.

198 tests, mypy strict clean (44 files).

## 2026-08-09 — Stage 3B.1 correction pass: subject-specific read parity

- Replaced the post-operation snapshot comparison with per-use-site checks:
  ShadowSession pairs the exact native read with its revision-derived read
  before use (cycle baseline/candidate, compare left/right, replay
  baseline/candidate, promote incumbent/target, rollback active/parent,
  audit target, status/restart + lineage). A mismatch is recorded, never
  substituted.
- build_shadow_view now demands exact SourceRecordRef coverage BOTH ways,
  supported projector, no duplicates, full derived closure (manifest/
  provenance/decision decode + registry descriptors + source artifact),
  semantic validation, and bounded cycle-free lineage. Manifests searched
  by (kind, name); every deltas[0] assumption removed. Any derived
  corruption or unexpected exception -> unavailable-with-reason; tested
  with the mirror journal replaced by a directory mid-flight — run_cycle
  still commits.
- Execution provenance: per-subject ResolvedHarnessManifest CAS-stored
  BEFORE each execution, pinning the baseline (shadow-active) revision at
  a tamper-evident journal head "count:prefix_digest" (JournalHeadRef
  value is backend-interpreted, so no frozen-type change). A cycle that
  activates its candidate still records rev-N-1 as the evaluating
  baseline.
- Intent completion is now prefix-scoped (_entries_within_prefix): an open
  intent + a later rollback's live activation mirror no longer refuses as
  "foreign history" — validated, repaired, completed over the declared
  prefix only; the later mirror survives untouched.
- Stage-3B migration-intent@1 journals: precise MirrorError naming
  `strive parity --rebuild` (peek at the raw schema field on SchemaError);
  rebuild quarantines byte-for-byte and recovers.
- Coverage: every attempted check recorded (agreed/diverged/unavailable/
  not-applicable) in ledger/<task>.shadow.jsonl; identical divergences
  deduplicated in the canonical ledger; `strive shadow` + cutover gate
  (parity complete + zero divergences + coverage >= 0.9 — absence of
  divergence records is NOT enough).
- Gotcha: the healthy-flows test initially demanded {agreed} for
  cycle-candidate/replay-candidate — a weakness-free second cycle
  legitimately records not-applicable; replay the FIRST cycle for a real
  candidate pairing.

207 tests, mypy strict clean (44 files).

## 2026-08-09 — Stage 3B.2: centralized reads + reversible revision-read canary

- New `strive.reader`: StateReader/HarnessReadSession is now THE read
  boundary. One coherent canonical+mirror snapshot per operation at
  tamper-evident heads; native derivations extracted to pure store helpers
  (derive_*) shared by Store and reader so they cannot disagree. Mutations
  take expected_head; stale activation/rollback refuse on ANY intervening
  append (stronger than expected_active).
- Honest subjects: candidate overlay revisions (immutable, unactivated,
  native RevisionProvenance origin=candidate-overlay) created BEFORE
  evaluation; ExecutionRecord pins base resolved harness vs subject
  (active-revision | retained-revision | candidate-overlay) with its own
  effective manifest + exact heads. This corrected 3B.1's dishonest
  resolved manifests that bound candidate sources under the baseline
  contribution.
- One validator: VerifiedRevisionSnapshot = parity-grade
  (_check_existing_mirrors recomputed projections + _verify_closure +
  complete-ref both-direction coverage + type agreement + bounded
  cycle-free lineage). shadow.py deleted. Design consequence: journal
  tampering now manifests as UNAVAILABLE (recomputed-projection equality
  makes a "plausible but wrong" mirror unrepresentable); DIVERGED catches
  derivation bugs (tested via snapshot fault injection). Both open the
  canary breaker.
- Evidence: locked+fsynced reader journal (mode changes, breaker events,
  epoch resets, per-check ReadCheck rows with reader/projector version +
  epoch + op id + heads + outcome, OperationSummary with status + facts).
  finish() runs in `finally` on every operation; expected subjects derive
  from OPERATION_SUBJECTS so uninstrumented paths synthesize `missing`.
  Repair resets the epoch (old evidence preserved, excluded).
- Eligibility: parity complete + zero diverged/missing/unavailable/journal
  errors + >=20 agreed + >=1 per required subject + observed facts
  {accepted, rejected, no-candidate, rollback, re-promotion, audit,
  replay, restart}. Default mode is native: no divergence records alone
  can never qualify.
- Canary: supported reads served from the verified snapshot after native
  comparison; breaker (durable) on unavailable/divergent, blocking canary
  (effective mode drops to shadow — loud, journaled, not a per-read
  fallback); kill switch -> native immediately; enable requires
  current-epoch eligibility + closed breaker. Activation and durable
  promotion remain generation-native (canary/shadow ledgers are
  canonically identical, tested deterministically).
- Gotchas: (a) test helper had to roll back before re-earning eligibility
  on an evolved store (no weakness -> no accepted-decision fact);
  (b) stale-rollback test's concurrent write must not remove the rollback
  target (activating the seed made "no parent" fire before the head
  check); (c) probe generations without an overlay are still labeled
  candidate-overlay in execution records, never retained-revision.

215 tests, mypy strict clean (45 files).

## 2026-08-09 — Stage 3B.2 correction pass (PR #43 hardening)

Six areas, all before merge:
- Coherent snapshot: Store.entries_with_bytes() reads bytes+entries once;
  snapshot_of() builds SourceSnapshot from that exact pair. Reader capture
  is canonical->mirror->recheck with retake-both on canonical movement, so
  an old native view is never paired with a newer mirror. Deterministic
  interleaving tests via a _on_capture_step hook append between every step.
- Fail-closed control: canary eligibility re-checked at StateReader init;
  repair_control_update (called by dualwrite repair/rebuild) atomically
  opens breaker + resets epoch and RAISES on failure (not best-effort);
  clear_breaker requires native/shadow + parity + fresh-epoch-after-breaker;
  enable/set_mode/clear use expected_head and persist the eligibility proof;
  force-native sentinel (STRIVE_FORCE_NATIVE / .FORCE-NATIVE file) is the
  journal-independent kill.
- Exact candidate identity: overlay revision+manifest+provenance built and
  validate_revision'd before eval in every mode; overlay_failure records
  unavailable + breaker-in-canary (no derived->native silent path);
  RetentionRecord links the exact overlay + decision; retained mirror
  verified content-identical (deltas + scope manifest). Split subjects
  cycle-candidate-overlay / cycle-candidate-retained.
- Tamper-evident evidence: reader journal now task-bound, crash-framed,
  hash-chained (ReaderFrame closes each batch: payload_hash + prev). Only
  framed+chained entries honored; unframed/forged/reordered/deleted lines
  counted as errors, never honored. ReadCheck stores mode+heads AT CHECK
  TIME; _add keeps one severity-merged terminal outcome per subject.
  Facts counted only from status==ok shadow/canary OperationSummary rows.
  Telemetry failure -> breaker in canary, never masks canonical result.
- Finished routing: status/lineage output, guard_task_binding(entries=),
  _proposal_history(reader), provisional confirm+revert, seeding all via the
  reader capture; expected_head on seed + both provisional transitions.
  Claim narrowed to "revision-derived execution/read canary" (identity reads
  agreement-gated, execution source revision-materialized).
- Threat model: canary refused for unsafe_model_code (same-UID sandbox);
  malicious-candidate test writes forged control lines from inside solve() —
  detected as errors, never honored, fails closed via force-native.

Key design realization: forged UNFRAMED lines poison subsequent framed
appends (the frame's payload_hash covers the accumulated buffer, so the
next legitimate frame fails to verify). So a corrupt reader journal cannot
be trusted to record its own breaker — the fail-closed signal for
journal_errors>0 is the journal-INDEPENDENT force-native override, which
every subsequent session recomputes. reset-journal quarantines byte-for-byte
and starts a fresh epoch in native mode.

232 tests, mypy strict clean (45 files). Reader version bumped to
state-reader@2 (framing + schema change); old epochs are not current.

## 2026-08-10 — Stage 3B.3: native composite revision lifecycle

- Extracted the 3B.2 reader journal's crash-framing/hash-chain into
  strive.framing.FramedJournal (shared FramedBatch "framed-batch@1", per-
  stream genesis label). ReaderJournal now subclasses it (translating
  FramingError->ReaderError). Fixed a latent head-hash inconsistency: the
  writer's returned head hashed the frame line WITH its trailing newline
  while read() hashed it WITHOUT — so a writer head never equaled a
  subsequent reader head. Now both hash the frame line without newline;
  expected-head threading across write->read is exact.
- New strive.lifecycle: <task>.revisions.jsonl owns native composite
  revisions. Records: RevisionRetained (exact HarnessRevision by CAS ref +
  evidence refs), RevisionActivation (reused frozen record; active = latest
  valid activation), LifecycleBreaker. retain() is idempotent by (id, ref),
  refuses redefinition; validate_composite checks identity/whole-revision/
  scope/descriptors/manifest-closure/provenance/parent-head/artifact-hashes;
  activate() revalidates + expected head + expected active, opens the
  breaker on invalid activation (no lossy fallback); rollback() re-activates
  the base parent; materialize_active() resolves the COMPLETE ScopeManifest;
  compatibility_projection() is the derived strategy-only view.
- Deadlock caught in smoke: retain/activate wrapped journal.locked() then
  called append_batch which re-locks the same flock (not reentrant across
  fds) -> self-deadlock. Fixed to optimistic read-then-append with
  expected_head (append_batch holds the only lock).
- Loop wiring: ensure_seeded seeds the lifecycle from the ROOT (parent-less)
  generation exactly once (id rev-0000); run_cycle threads the lifecycle
  active id as the overlay base parent so evaluated==retained==activated,
  retains the overlay (accepted+rejected) and activates the same revision on
  accept via _drive_lifecycle. Lifecycle failures are additive diagnostics,
  never break the generation-native cycle (the 232 pre-existing tests stayed
  green throughout).
- compose_revision: deterministic multi-surface fixture builder (code+prompt)
  used by tests; prompt surface is lifecycle-only, no behavior claim.
- CLI: `strive lifecycle [status|rollback]`.

250 tests, mypy strict clean (48 files). Generations/mirror are now
explicitly derived compatibility; the lifecycle is the native-revision owner.

## 2026-08-11 — Stage 3B.3 correction pass (PR #44 hardening)

Six areas before merge:
- Upgrade history: 0004-reader-journal-upgrade migrates the exact PR#43
  reader journal (reader-frame@1 + old genesis) — old chain fully verified
  with OLD rules first, refuses ambiguity, original bytes quarantined+hashed,
  batches re-framed in order (mode/breaker/epoch/checks/summaries exact).
  FramedJournal.legacy_frame_schemas makes pre-migration journals fail LOUDLY
  with `strive migrate` guidance instead of parsing as corruption.
  0003-lifecycle-backfill replaces the naive seed-only path: identity for
  every generation (generation-backfill@1) + full activation replay so the
  ACTUAL active revision is preserved. sync_from_generations runs at every
  seeding pass — generation-native promote/rollback and unsafe-run gaps
  converge afterwards from the authoritative ledger.
- Framing: append_batch validates entry types BEFORE writing and refuses
  unverified regions (errors/unframed/torn tail); repair_to_verified =
  durable quarantine (fsynced first) + truncate to last verified boundary,
  idempotent across a crash between the steps. Real append-after-torn-tail
  and append-after-unframed-line tests.
- One recoverable activation op: retain + RevisionEvaluated +
  RevisionSelected persist BEFORE store.activate; ActivationIntent/Progress/
  Completed span both journals; reconcile handles every crash point
  (abandoned / resumed / reverted+breaker); lifecycle failure after
  generation activation reverts the generation and raises (never swallowed).
  lifecycle.rollback drives BOTH journals — served strategy changes;
  compat_parity exposes agreement.
- Parent-manifest replay in validate_composite: before-state equality,
  transition application, carry-over, exact child-manifest equality.
  compose_revision now carries untouched parent bindings (code-only child of
  code+prompt parent preserves the prompt — the key lossless test).
- Identity vs evidence: RevisionRetained@2 is identity-only; evidence gate =
  latest selection accepted against the CURRENT active baseline (stale-
  baseline evidence refuses with "re-evaluate"); rejected/evidence-free
  activation only via durable TrustedOverride; accepted candidate whose
  overlay could not be built is REFUSED promotion (no identity-less
  replacements).
- Threat model stated: chains tamper-evident, not same-UID secure; unsafe
  model code gets NO lifecycle authority in-run (generation-native only,
  parity-visible gap, kernel convergence backfills after).

Gotchas: naive `int(x) for x in split()` fixture code fails the task's
natural-language inputs — fixtures now reuse the known-good evolved gen-0001
source; scope check had to precede the redefinition check in retain (cross-
task rev-0000 collision); crash-injection promotables must be prepared
against the weak rolled-back baseline so their selection evidence is
accepted-and-current at resume time.

257 tests, mypy strict clean (48 files).

## 2026-08-11 — Stage 3C.1: the prompt-surface composite evolution experiment

- Prompt surface operational: DEFAULT_PROPOSAL_TEMPLATE +
  validate_prompt_template (bounded, known placeholder set incl. the new
  {failing_case_ids} sparse variant, JSON contract, {parent_generation_id});
  resolve_active_prompt reads the active revision's manifest binding with
  the CAS-stored default as explicit fallback; prompt_resolved event per
  model request (ref + source + active revision); the metered adapter
  already journals consumed prompt bytes content-addressed.
- ProposalRecord -> proposal@2 with optional prompt_update (never
  codec-decoded from disk, so the strict-codec bump is safe);
  parse_completion accepts it and requires changed_surfaces agreement;
  screen_prompt_update = template validity + no hidden-split content
  (kernel knows hidden case inputs/ids; proposers never do).
- _build_composite_overlay replaces reader.candidate_subject in run_cycle:
  ONE immutable revision with strategy + optional prompt deltas via
  lifecycle.compose_revision against the active manifest (carry-over), so
  the 3B.3 parent-replay validation covers composites for free.
  check_retained_matches_overlay relaxed to strategy-binding comparison
  (the mirror is strategy-only compat; composite surfaces live in the
  lifecycle).
- The experiment (strive/experiment.py): prompt_sensitive_adapter is a
  deterministic instruction follower — signed fix iff the prompt contains
  failing-input excerpts (input= line with a negative literal); proposes a
  prompt_update when the excerpts are withheld. INCUMBENT template uses
  {failing_case_ids}; CANDIDATE uses {failing_cases}. Arms A-E matched;
  first full run passed everything: A rejected 0.455 (no excerpts), B
  accepted 1.000 (excerpts), C rejected, D accepted, E accepted+activated,
  restart serves the candidate prompt, rollback restores incumbent
  prompt+code with parity OK.
- Prompt-only changes CANNOT pass the execution-scored gate (arm C) — the
  experiment installs arm prompts via journaled TrustedOverride, which is
  the honest operator path until non-execution evidence kinds exist
  (ADR-0004 slice, next).
- Real-model path: run_real_model_arms (env adapter, unsafe_model_code=True
  -> generation-native only, lifecycle authority refused as per 3B.3);
  `strive experiment --real-model --unsafe-model-code`. Outcomes recorded
  honestly; no capability claim from the fixture.

266 tests, mypy strict clean (50 files).

## Stage 3C.1 correction pass (pre-merge, PR #45)

- No piggybacking: strive/promptgate.py is the trusted prompt validator —
  candidate vs incumbent templates under matched adapter/context/budgets,
  each template's proposed strategy task-gated, verdict = strict dominance
  on (gate_accepted, proposal_valid, -regressions). run_cycle activates a
  prompt-carrying composite only when code passes AND prompt improves;
  otherwise _activate_code_only_sibling activates rev-<cand>-code and the
  composite is retained REJECTED with SurfaceEvidence(improved=False).
  Adversarial test: harmful prompt riding on good code is demoted; a
  beneficial prompt on failing code is retained (improved=True) but
  nothing activates.
- Two-stage self-produced composite (arm E): incumbent proposer proposes
  p1 (screened), p1 generates s1 in a fresh fixed-budget call, immutable
  p1+s1 revision built BEFORE evaluation; the SAME rev-cand-two-stage id
  is proposed/evaluated/retained/selected/activated/restarted/replayed/
  rolled back. Override-installed prompts are initial conditions, not
  evolution.
- Stale-safe complete prompt state: _pin_default_prompt pins the build's
  default template as rev-prompt-default at seeding (journaled structural
  override); resolve_active_prompt reads history (CAS), never the current
  build string — rollback-to-historical-default tested against a mutated
  build default. ProposalRequest pins parent_revision_id/lifecycle_head/
  prompt_ref/prompt_descriptor_ref; post-call re-resolution rejects STALE
  even with an unchanged generation id (concurrent-activation test).
  Backfill now composes revisions carrying parent manifest bindings
  (last-wins generation→revision map) so non-code surfaces survive
  lifecycle-refused runs. Fallout: the pin adds one "promote" activation
  to every fresh store's history (test count updates in test_dualwrite/
  test_lifecycle/test_reader/test_stage3_contracts).
- Hardened descriptor prompt@3 (validation_policy prompt-template@1):
  string.Formatter parse, exact placeholder names, no traversal/
  conversions/format-specs/positional fields, bounded repetition/size,
  required output fields; invoked by validate_composite at retention/
  activation and by resolution/replay. RENDERED_PROMPT_MAX_CHARS enforced
  before any provider call (rendered_prompt_overflow, adapter not
  invoked — tested with a counting responder).
- Reproducible experiment: BudgetMeter discard removed — all arms run over
  normal metered paths; ExperimentManifest (fingerprints/refs/params/
  seeds/budgets/arm order/journal heads/outcomes) persisted in a unique
  run dir (reuse refused); `passed` = valid A/B + A rejected + B accepted
  + matched CONFIGURED budgets (consumption legitimately differs: arm A's
  gate calls) + journaled consumption proof + exact two-stage identity.
  Real-model runs labeled SINGLE-TRIAL with tokens/latency/cost.
- Generic schema: proposal@2 carries typed surface_updates keyed by
  descriptor ref (SurfaceUpdate@1); model-facing "prompt_update" JSON key
  converted by parse_completion. proposal@1 proven event-payload-only —
  never codec-decoded from disk — so no v1 migration exists by design
  (test asserts the strict refusal).

271 tests, mypy strict clean (51 files).

## Stage 3C.2A — versioned validation evidence + policy-neutral selection

- strive/evidence.py freezes the ADR-0003/0004 envelopes (moved out of the
  stage3_contracts spike, which now re-exports): DatasetRevision@1,
  EvaluationManifest@1, ValidatorResult@1 (+subject_role), role-bound
  ValidationBundle@1 (task/prompt/constraint), DecisionEvidence@1,
  SelectionDecision@1 (closed dispositions; EVERY disposition requires
  evidence), ObjectiveSpec@1, TaskSpecVersion + function-task@1 adapter
  (spec fingerprint EXCLUDES cases — data growth is not spec drift).
- strive/validators.py: registry keyed name@version, resolved exactly;
  converters wrap existing trusted mechanisms (task-suite, paired-
  comparison, prompt-comparison, source-screen, budget-within-spec).
  budget_result(None, spec) is INCONCLUSIVE, and inconclusive hard
  constraints block activation.
- strive/datasets.py: ledger/<task>.datasets.jsonl (append-only, strictly
  parsed, monotonic lineage); ensure_dataset_revision idempotent;
  materialize_split re-materializes any historical split exactly.
- strive/selection.py: manifest/bundle/decision builders + the
  synthetic-but-lossless legacy mapping (the ORIGINAL evaluation/decision
  refs become the bundle artifacts).
- Lifecycle: EvidenceLink@1; record_selection refuses envelope-less
  selections (selection_ref or task-synthesis); activation_readiness is
  the promote gate — roles per changed surface (no borrowing across
  subjects, no relabeling across roles), current-dataset manifests
  (stale ⇒ re-baseline, never drift ack), exact validator resolution,
  decodable artifacts, constraint verdicts. run_activation_op cites the
  SelectionDecision ref. Migration 0005 + seeding convergence backfill.
- Gotchas hit: the codec supports ONE version per kind, so RevisionSelected
  could not be bumped — EvidenceLink is additive instead (originals never
  rewritten, old journals stay readable). ensure_dataset_revision compares
  only the LATEST fingerprint, so tests that grow the dataset must keep
  using the grown task (monkeypatch test_lifecycle.TASK) or synthesis
  re-appends the old data as a new revision. The CLI reconverges datasets
  from the build's task, so CLI tests can't fake growth with a modified
  task — use a missing-prompt-role block instead.
- Replay now recomputes the recorded task bundle's candidate metrics and
  diffs them (bundle_checked/bundle_metric_diffs/bundle_matches); compare
  prints the RECORDED disposition/roles from the selection envelope;
  `strive evidence` prints dataset revision, bundles (roles, validators,
  staleness), selections, and readiness with every blocking reason.

288 tests, mypy strict clean (56 files).

## Stage 3C.2A.1 — authoritative envelopes (correction pass)

- EvaluationManifest bumped to @2: + execution_record_ref, task_spec_ref,
  dataset_revision_ref; task_fingerprint now = the SPEC fingerprint. The
  codec supports one version per kind, so ensure_evidence_links learned to
  RE-LINK records whose latest envelope no longer decodes under this build
  (fresh synthetic link appended; old bytes preserved).
- Live guard replaced: TaskSpecBound in the lifecycle journal; the guard
  compares pure task_spec_fingerprint (cases excluded). Bound at seeding
  ONLY when no legacy drift exists; acknowledged drift re-binds. Dataset
  growth now flows through the real mutation guard unacknowledged (tested)
  and forces re-baselining via the current-dataset check.
- Provenance: resolved_manifest_ref must decode to ResolvedHarnessManifest
  (typed decode catches an ExecutionRecord smuggled in — adversarial
  test); the ExecutionRecord must name the exact retained subject revision
  ref, its scope manifest, the same resolved baseline, and a journal head.
  The loop uses the reader's pinned record;
  selection.pin_execution_provenance pins truthful provenance for
  harness-internal paths (experiment metered gate, fixtures).
- Complete semantics in activation_readiness: ROLE_REQUIRED_VALIDATORS
  exact-set per role; manifest↔results one-to-one; duplicate roles /
  duplicate (validator, subject_role) / extraneous results block; paired
  comparison must be PASSED with its Decision artifact accepted
  (wrong-but-noncrashing candidates end at REJECTED selections); suite
  artifacts must agree with recorded scores and the journal's
  evaluation_ref; objective specs decode and match everywhere;
  policy_ref/subject/incumbent agreement.
- Honest grading: EvidenceLink.synthetic blocks fresh promotion with a
  named modern-re-evaluation requirement; selection.record_assessment is
  the one shared promote-grade recording path (loop, experiment ablation +
  two-stage arms, lifecycle fixtures all moved onto it; record_selection's
  task-synthesis remains for backfill and is now promotion-inert).
- budget_result covers all 7 dimensions with the meter's exact semantics
  (-1 accounting-only / 0 nothing-allowed / otherwise used <= limit; None
  usage inconclusive → blocks).
- datasets.jsonl hardened: flock-serialized writers, expected_head
  (dataset_head = "n:fingerprint"), torn-tail quarantine+truncate under
  the lock (interior corruption never auto-repairs), CAS closure
  (revision object + every split manifest round-trip) before the durable
  append. Concurrency + crash-injection tests.
- Gotcha: the code-only sibling's execution record can't reuse the
  composite overlay's (different revision identity) — pin fresh provenance
  for the retained sibling with an explicit detail naming the identical
  executed artifact.

300 tests, mypy strict clean (56 files).

## Stage 3C.2B — secure local execution + model-capability lane

- strive/sandboxes.py: SandboxBackend protocol (backend@version,
  capabilities(), provenance(), run()), SandboxCapabilities (closed cap
  vocabulary; .secure = secure-execution floor), SandboxProvenance,
  SandboxLimits, fail-closed registry (get_backend raises on unknown/
  unavailable — NEVER downgrades), run_protected_suite (each case in a
  fresh backend.run).
- strive/sandbox_backends.py: process-fault-only@1 (wraps run_strategy,
  honest not_enforced list), deno-pyodide@1 (DSPy PythonInterpreter, Deno+
  Pyodide WASM; fresh interpreter per run; parent wall-clock watchdog),
  linux-landlock-seccomp@1 (spike; available() only on probe-confirmed
  Linux). Backends registered at import.
- KEY GOTCHA: DSPy's interp.shutdown() sends a graceful JSON-RPC shutdown
  then blocks on deno_process.wait() — a CPU-bound infinite loop in pyodide
  never reads it, so shutdown hangs forever. Fix: run execute() in a worker
  thread with join(timeout=wall_time_s); on overrun, _hard_kill() calls
  interp.deno_process.kill() directly (SIGKILL the OS process, NOOA's
  doctrine); teardown shutdown() also runs in a watchdog thread with a
  hard-kill fallback. Verified: infinite loop returns in ~3.3s as a
  FAILURE_TIMEOUT.
- Verified escapes DENIED in pyodide: host fs read (WASM VFS, FileNotFound),
  /root/.ssh, os.environ has only web_user vars, os.fork (not implemented),
  subprocess (emscripten no processes), socket.connect (host unreachable),
  inspect.stack has no strive frames, write /etc (denied), cross-case
  builtins._leak absent (fresh interpreter). deno boots ~1.4s cached.
- strive/protected.py: evaluate_through_backend → normal Evaluation +
  SandboxProvenance, failure-as-data preserved.
- Manifest bumped @2 → @3: + sandbox_provenance_ref. selection builders +
  ExecutionProvenance + record_assessment thread it through; readiness gate
  decodes it when present (backend must be versioned). test_stage3_contracts
  manifest helper updated.
- loop: LoopConfig.sandbox_backend (default process-fault-only@1 so the 300
  existing tests stay fast); _execute_and_evaluate routes through the backend
  per-case when non-default, capturing sandbox provenance into the execution
  record dict; _backend_is_secure gates the unsafe_model_code branch — model
  code gets full lifecycle authority under a secure backend, generation-
  native only without one.
- strive/capability.py + `strive capability`/`strive sandbox`: repeated
  seeded trials, fixture vs real, honest supported/inconclusive/negative;
  real trials require a secure backend (refuse insecure). n>=2 for a verdict.
- dspy added as a dep; mypy override ignore_missing_imports for dspy.* (no
  py.typed). deno installed via brew (deno 2.9.5).
- ADR-0007 written; docs updated; next phase renamed 3C.2C (algorithm
  comparison over the secure backend).
