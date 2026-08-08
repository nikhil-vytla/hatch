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
