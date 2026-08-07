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
