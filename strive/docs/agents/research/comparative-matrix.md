# Comparative matrix — researched systems vs. strive v0

Synthesized 2026-08-06 from notes 01–06 (see [00-index.md](00-index.md) for provenance;
each cell is backed by the numbered note). Systems:

- **Flex/GEPA** — `dspy.Flex` + GEPA optimizer (cmpnd.ai blog; note 01)
- **prime-agent** — Prime Intellect, commit `0e0d233` (note 02)
- **CH paper** — arXiv:2605.09998 "Continual Harness" (note 03)
- **exo** — exoharness/exo, commit `8f78866` (note 04)
- **RLM** — alexzhang13/rlm `72d6940` + arXiv:2512.24601 (note 05)
- **NOOA** — NVIDIA-NeMo/labs-OO-Agents, commit `bfb347b` (note 06)
- **strive v0** — this repo's vertical slice

## Dimension-by-dimension

| Dimension | Flex/GEPA | prime-agent | CH paper | exo | RLM | NOOA | strive v0 |
|---|---|---|---|---|---|---|---|
| **Runtime/task/state model** | DSPy module whose full source is the parameter; batch task datasets | TS monorepo; persistent IPython kernel is the model's only built-in tool | Emulated RPG, 8-button action space, milestone sequence, persistent savestates | Rust substrate (agents/sessions/turns/events) + TS executor owning semantics | Context-as-REPL-variable; model writes code each turn | Agents are Python objects: fields=state, methods=capabilities, docstrings=prompts | Deterministic case suite; strategy file = `solve()` |
| **Traces/persistence** | Execution traces feed reflection; no durable store | Session JSONL + global `refinements.jsonl`; atomic temp+rename writes | Full-episode trajectory is the Refiner's evidence; harness files persist across runs | Append-only per-event JSON files (UUIDv7, optimistic head-check); log immutability justified by anti-looping | Stateless per run; hierarchical spend accounting up the recursion tree | OTel + ATIF v1.7 versioned trajectory schema with per-step cost; SHA-dedup'd prompt journal | JSONL event stream per run; append-only ledger |
| **Trusted vs evolvable surfaces** | Trusted optimizer/metric; evolvable module source, bounded by primitive allowlist | Mechanically immutable base prompt; typed validated edits to 4 state kinds; two-tier (metadata vs code) | Evolvable p/G/K/M; trusted refiner+eval — but boundary implicit, sandbox loophole exploited | **Policy, not mechanism**: agent can technically edit "immutable" harness (RSI.md fn.2); only event log is truly immutable | Trusted scaffold names re-asserted after every REPL execution | AST validators = guardrails; Landlock+seccomp+rlimits = boundary; stated verbatim as doctrine | Explicit charter allowlist; kernel/evaluator/ledger trusted |
| **Decomposition/subagents/context** | Decomposition emerges as an optimization pattern | `rlm(...)` spawns real child sessions, fire-and-forget | 1-level orchestrator→sub-agent; handoff quality measured (exit/focus rates); sub-agent cost ~10× below orchestrator | Conversation `fork(up_to_inclusive)` with provenance | **Specialty**: bounded `max_depth`, children inherit *remaining* budget; silent degrade to plain LM at cap | CodeAct in REPL with `self`; subagent refs in ATIF | None yet |
| **Candidate generation / self-modification** | GEPA rewrites whole module source via NL reflection on traces | `/refine` LLM pass emits JSON CRUD edits, validated by trusted TS code | LLM Refiner emits per-surface CRUD every F steps; single lineage, no population | Agent edits own repo read-write; `rebuild_and_restart` via guardian; gate = `cargo build` only | None (improvement = offline weight training) | Agents author Python libraries; gate = lint + self-run pytest | Registry patch, exactly-once match, else abstain |
| **Evaluation/selection/promotion/rollback/lineage** | Score+feedback metric; Pareto frontier retention; eval budgets; **no durable lineage/rollback** | Per-edit before/after snapshots, version counters, journaled invertible rollback; **no empirical validation** (LLM judgment) | **No acceptance gate**; behavioral triage only; documented catastrophic drift (inherited share → 6.4%) + 842-repeat stall | **No evaluator/acceptance at all**; SELF-CONTROL.md admits the gap and names clone-and-compare as missing | Not applicable (per-run engine) | Library changes ungated by incumbent comparison; eval runs checkpointed | Explicit rules: strict improvement + zero regressions; journaled decisions; derived active pointer; rollback |
| **Sandboxing/secrets/budgets/recovery** | Sandboxed interpreter, allowlisted primitives, JSON-only boundary, `max_predictor_calls` cap | Fault containment only (disclaimed); secrets host-side behind typed `host.request`; real turn/token/time budgets in autonomous mode | `run_code` with a documented escape (celebrated, not contained); budgets measured not enforced | Sandbox snapshot/rewind/teleport; AES-256-GCM secrets scoped root/agent/conversation; durable update intents | Isolation ladder behind one interface (exec→ipykernel→Docker+LM-proxy); credentials never enter sandbox; typed limits carry `partial_answer` | Landlock+seccomp+rlimits self-installed post-fork, fail-closed probing, parent hard-kill; secret scrubbing at export | `python -I` subprocess + timeout; no rlimits/network block; no secrets story |
| **Online vs offline** | Offline (reset-based batch optimization) | Online (auto-refine every 25 turns / on compaction) | **Squarely online, reset-free**; offline warm-ups alone behaviorally inert | Online (live self-rebuild) | Neither (per-run) | Offline consolidation passes for memory | Offline only |
| **Harness vs weights** | Harness (beats GRPO with up to 35× fewer rollouts) | Harness only | **Both, coupled**: weights-only = zero progress; joint loop advances; capability floor below which harness learning is net-negative | Harness only | Weights branch (rejection fine-tuning, +28.3% median) | Harness runtime; ATIF explicitly feeds external weight training | Harness only (charter non-goal) |
| **Genuinely self-improving?** | Yes offline: validated, budgeted, selected — but improvements aren't durable artifacts with lineage | No — persistence + self-modification without validation | Yes with evidence (oracle-convergent skills, in-episode repair, transferable harness) *and* documented regressions from ungated edits | No — self-modification without evaluation | No — persistent/configurable engine; learning is in weights | Closest: memory graph with lineage edges + no-self-reinforcement invariant; libraries merely persistent | Yes, narrowly: validated, journaled, reversible — but planted weakness only |

## What each system has that strive lacks — and vice versa

| System | Has, strive lacks | Lacks, strive has |
|---|---|---|
| Flex/GEPA | Model-generated whole-source candidates; score+feedback metric contract; Pareto retention; eval budgets; failure-as-score | Durable lineage, journaled decisions, rollback, replayable model I/O, online operation |
| prime-agent | Multi-surface typed CRUD edits; snapshot/invertible rollback; scope tiers; plan/apply concurrency check; acceptance-history feedback to proposer | Any empirical validation; incumbent comparison |
| CH paper | Reset-free online refinement; four-surface decomposition; per-surface proxy oracles; usage/provenance accounting; bootstrap transfer protocol | Acceptance gate, rollback, stall detection, drift protection |
| exo | Trusted substrate (events/artifacts/sandboxes/secrets) that *cannot* call an LLM; durable update intents; fork/snapshot; scoped secrets | Evaluator, acceptance, promotion, mechanical trust boundary |
| RLM | Bounded recursion with budget inheritance; isolation ladder; typed limits with partial results; errors-as-values | Ledger, evaluation, acceptance, retention (stateless by design) |
| NOOA | Production observability (OTel, ATIF, cost per step); unprivileged kernel-level sandbox; FakeLLMClient; harness-intervention telemetry; memory lineage graph | Incumbent-gated promotion, decision journal, rollback for code artifacts |

## Verdicts for strive v0: retain / replace / harden / generalize

**Retain (validated by the research):**
- The gated loop itself. Three researched systems (prime-agent, CH, exo) independently
  lack empirical acceptance and two of them document or admit the resulting failure
  (CH's drift + stall; exo's SELF-CONTROL gap). strive's gate is the differentiator.
- Append-only ledger with derived active pointer and journaled rollback — strictly
  stronger than every researched system except prime-agent's snapshots, and simpler.
- Proposer abstention on unknown signatures (CH's confidently-wrong self-diagnosis is
  the counterexample this prevents).
- Offline-first, deterministic, fake-model-compatible tests (NOOA ships `FakeLLMClient`
  in core for the same reason).

**Replace:**
- Single-artifact generations → composite generations: per-surface CRUD deltas with
  before/after snapshots (prime-agent schema + CH's four surfaces).
- Boolean pass/fail evaluator contract → `(score, feedback_text)` (GEPA contract), with
  failure-as-score semantics (floor scores for unrunnable candidates).
- Hard-coded "run the case suite" validation → pluggable `Validator` per surface/risk
  tier (CH proxy oracles; held-out splits from GEPA practice).

**Harden:**
- Runner: reject loudly on schema mismatch (CH's 842-repeat loop came from silent
  fallback); add rlimits + network denial now, Landlock/seccomp (Linux) at stage 3
  (NOOA's two-layer doctrine: validators are guardrails, kernel mechanisms are the boundary).
- Trust boundary must remain mechanism, not policy (exo's RSI.md concession is the
  anti-pattern); all metrics/budget accounting computed on the trusted side (exo's own
  cost doc admits agent-reported usage is untrustworthy).
- Ledger/events: one shared typed codec, versioned schema with normative-rule tests
  (NOOA's ATIF discipline).
- Add trusted-side mechanical stall/drift detectors (identical-outcome counters,
  inherited-usage share) — the failure class trace-driven diagnosis is blind to.

**Generalize:**
- Budgets (tokens, cost, wall-clock, eval runs) plumbed through the cycle contract with
  RLM-style inheritance for future recursive delegation.
- Evolution algorithm as a plugin (incumbent hill-climb today; Pareto-frontier
  population per GEPA later).
- Sandbox as a tier registry behind one interface (RLM's ladder, NOOA's guards).
- Usage/provenance accounting on every artifact invocation (CH Table 2: inherited-share
  is the best early-warning drift signal).
