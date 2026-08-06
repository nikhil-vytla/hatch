# strive — Target Architecture

Status: designed 2026-08-06 from the v0 vertical slice plus the research corpus in
[docs/agents/research/](agents/research/00-index.md). This document describes the
platform strive is growing into; the [ROADMAP](ROADMAP.md) sequences the work and
[HANDOFF](HANDOFF.md) records the decisions and their evidence.

## Design thesis

The researched systems occupy complementary parts of the design space. Flex/GEPA does
rigorous budgeted candidate validation and persists logs, checkpoints, and candidate
programs, but — as an offline optimizer rather than a deployment harness — lacks
deployment-level activation, journaled rollback, and long-lived online generation
semantics. prime-agent, Continual Harness, and exo persist and self-modify richly but
place **no pre-activation, comparative behavioral promotion gate** in front of harness
refinements; each has other quality controls, and the omission is often deliberate
(missing ground truth, non-resettable environments, evaluation cost, delayed benefits,
cold start, Goodhart risk, product-layer boundaries — see HANDOFF, "Why embedded
acceptance gates are difficult").

strive's thesis is a **hypothesis to be tested, not a conclusion**: that combining
selected mechanisms from these systems — comparative promotion, durable lineage,
bounded online refinement — inside one small trusted kernel improves long-run
performance over any of them alone. The kernel owns evidence integrity, decision
enforcement, budgets, and history; everything else, including strive's own strategies,
prompts, skills, and memory, is evolvable cargo whose promotion requires **evidence
proportional to its risk and evaluability** — trusted behavioral evidence for durable
or broad-scope promotion; provisional, scoped, reversible, monitored, and expiring
activation for low-risk or online changes.

## Layered model

```
┌────────────────────────────────────────────────────────────────────┐
│ L2  EVOLVABLE SURFACES (allowlisted; changed only via the loop)    │
│     strategy code · prompts · policies · skills · subagent specs   │
│     · memory contents                                              │
├────────────────────────────────────────────────────────────────────┤
│ L1  PLUGGABLE TRUSTED EXTENSIONS (registered; human-reviewed)      │
│     model adapters · tools · tasks/scorers · validators            │
│     · evolution algorithms · online adaptation policies            │
├────────────────────────────────────────────────────────────────────┤
│ L0  TRUSTED KERNEL (human-changed only, never by the loop)         │
│     cycle controller · ledger · event journal · evaluator +        │
│     acceptance rules · budget meter · sandbox boundary · secrets   │
│     broker · stall/drift monitors · data splits                    │
└────────────────────────────────────────────────────────────────────┘
```

The L0/L2 distinction is enforced by **mechanism, not policy**: evolvable artifacts are
data materialized into sandboxed workspaces; they are never imported into the kernel
process and have no write path to kernel code, the ledger, or task data. (exo's
concession that its "immutable" harness is only protected by default config — RSI.md
fn.2 — is the anti-pattern; NOOA's "validators are guardrails, kernel isolation is the
boundary" doctrine is the pattern.)

## L0 — Trusted kernel

**Cycle controller** (`loop.py` today). Orchestrates the stage sequence. Stages are
protocol-typed; the controller knows nothing about their implementations. It enforces
two invariants: every stage transition emits an event, and every candidate — accepted
or rejected — is retained.

**Ledger.** Append-only journal, one shared typed codec with the in-memory types, a
`schema_version` field on every entry, and normative-rule tests (ATIF discipline, note
06). Entry kinds: `generation`, `activation`, `run`, `budget`, `intervention`. The
active configuration is *derived* from activation entries (v0 mechanism, retained).
New in the target design, from CH Table 2 (note 03): **usage accounting** — every
artifact invocation journals which generation served it, making inherited-vs-authored
usage share (the best early-warning drift signal) a free query.

**Generations become composite.** A generation is a set of per-surface CRUD deltas over
a parent — `(surface, op, before_snapshot, after_snapshot)` per prime-agent's
per-edit schema (note 02) across CH's surface decomposition (note 03) — each surface
independently activatable and rollback-able. v0's single strategy file is the
degenerate case: one `strategy-code` delta.

**Evaluator + acceptance rules.** The evaluator contract widens from booleans to
`(score: float, feedback: str)` per case (the GEPA metric contract, note 01) —
feedback text is what makes model-backed proposers effective. Failure is a score, not
an exception: unrunnable candidates receive floor scores and the loop continues.
The kernel's role here is deliberately narrow: it enforces that every promotion
decision is journaled with trusted-side evidence and that evidence requirements scale
with a change's risk, scope, and evaluability — it does **not** impose one universal
metric policy. What counts as sufficient evidence is supplied by per-surface,
per-risk-tier Validators (L1); durable or broad-scope promotions demand trusted
behavioral evidence, while low-risk or online changes may activate provisionally
(scoped, reversible, monitored, expiring — see the online rules below).
Acceptance (`decide`) gains two research-driven rules beyond v0's strict-improvement +
no-regressions:
- **Held-out discipline**: candidates must improve on cases never shown to
  diagnosis/proposal (guards the reward-hacking risk in HANDOFF).
- **Inheritance-aware thresholds**: *replacing* a proven incumbent demands evidence on
  the incumbent's historical invocation profile; *adding* a new artifact has a cheaper
  bar (the direct lesson of CH's bootstrap regression, note 03 §C.2.1).

**Budget meter.** Budgets (tokens, dollars, wall-clock, eval executions) are part of
the cycle contract, enforced and accounted **on the trusted side** — never
self-reported by evolvable code (exo's cost doc admits agent-reported usage is
untrustworthy, note 04). Budgets are hierarchical: a delegated child receives the
parent's *remaining* budget, RLM-style (note 05), so recursion is safe by construction.

**Sandbox boundary.** One interface, a registry of tiers (RLM's ladder, note 05):
1. `subprocess` — `python -I` + timeout (v0, retained as floor);
2. `restricted` — + rlimits (CPU, memory, file size) and network denial;
3. `kernel` — Landlock + seccomp self-installed post-fork with fail-closed capability
   probing (NOOA `guards.py`, note 06; Linux-only — macOS falls back to tier 2);
4. `container` / microVM (stage 6).
The runner **rejects loudly on schema mismatch** — a malformed payload is an observable
failure event, never a silent fallback (CH's 842-repetition stall was caused by exactly
that silence, note 03 §B.3). Timeouts return partial results where possible
(`partial_answer` pattern, note 05).

**Secrets broker.** Credentials live host-side only and cross into sandboxes never;
model calls made on behalf of sandboxed code go through a kernel-side proxy
(prime-agent's `host.request` bridge and RLM's Docker LM-proxy, notes 02/05). Scoping
follows exo: secrets bound to kernel/task/run scopes (note 04).

**Stall & drift monitors.** Dumb, mechanical, trusted: identical-outcome counters,
flat-score windows, inherited-usage-share tracking. CH shows self-diagnosis is
confidently wrong precisely during stalls (842 identical actions with reasoning logs
claiming success), so these monitors cannot live on the evolvable side. Monitors emit
`intervention` events and can halt the loop; they never edit surfaces.

## L1 — Pluggable trusted extensions

All L1 protocols are typed, registered by name, journaled, and replayable.

- **ModelAdapter** — provider-neutral chat/completion interface. Every request/response
  (prompt, completion, model id, seed, usage) is journaled to the run's event stream
  for offline replay. A deterministic `FakeModelAdapter` ships in core (NOOA's
  `FakeLLMClient` precedent) so the entire test suite stays offline forever.
- **Tool** — declared capability with a schema; tool calls are events; tool results
  larger than a threshold are compacted to artifacts and passed by reference (exo
  pattern).
- **Task** — cases + scorer + **split declaration**: `visible` (diagnosis/proposal may
  see), `held_out` (acceptance only), `regression` (grown from past failures, stage 4).
  Scoring is a property of the task, not the evaluator.
- **Validator** — per-surface, per-risk-tier validation strategies (note 03's key
  transferable idea): `SuiteValidator` (run the cases — v0's behavior), `HeldOutValidator`,
  `ProxyValidator` (score against a local oracle or rolling success rate, for online
  contexts where full suites are unaffordable), `StaticValidator` (schema/AST checks as
  a cheap *pre-filter*, never the gate — NOOA/prime-agent precedent).
- **EvolutionAlgorithm** — owns candidate flow control: v0's incumbent hill-climb;
  GEPA-style Pareto-frontier population with budget-capped search (note 01); others
  later. The algorithm chooses *what to try*; only kernel acceptance decides *what is
  promoted*.
- **OnlineAdaptationPolicy** — see below.

## L2 — Evolvable surfaces

Each surface registers a **SurfaceDescriptor**: artifact schema, materialization rule
(how it lands in a workspace), static pre-checks, applicable validators, blast-radius
class, and rollback semantics. The allowlist is kernel data; the loop cannot extend it.

| Surface | v0 | Target |
|---|---|---|
| strategy code | ✅ sole surface | standalone modules, workspace-materialized, sandbox-executed |
| prompts | — | versioned text artifacts consumed by ModelAdapter calls |
| policies | — | typed parameter bundles (retry counts, thresholds, cadences) |
| skills | — | callable code + usage contract; rolling success tracked via usage accounting |
| subagent specs | — | declarative role+budget+tool grants; delegation via kernel |
| memory | — | typed entries with lineage edges; **pull-rate instrumented from day one**, no self-reinforcement of retrieval (NOOA invariant); write-only memory earns no acceptance (CH C.1.4) |

**Candidate workspaces.** A candidate is materialized into an isolated workspace
directory (surfaces rendered to files), executed only through the sandbox boundary, and
destroyed after validation; the ledger keeps the deltas and snapshots, not the
workspace. This is the seam where fork-based counterfactual validation (exo's
snapshot/fork) plugs in later.

## The two evolution modes

**Offline evolution (primary; stages 2–4).**
```
collect runs → diagnose from traces → propose candidates (algorithm-driven)
→ materialize workspace → validate (static pre-filter → sandbox suite → held-out)
→ decide (explicit rules) → promote via activation entry → journal everything
```
Controlled data, resettable evaluation, full budgets. This is v0's loop generalized.
GEPA is the strongest evidence that this regime is workable — model-generated
candidates validated under explicit eval budgets, reported at up to 35× fewer rollouts
than GRPO (note 01; blog-sourced numbers, not independently reproduced) — though
whether it is the *best* backbone for a long-lived harness is part of hypothesis H1.

**Online evolution (bounded; stage 5).** During a continuing run — no resets, evidence
arriving mid-task — the loop may refine only surfaces whose descriptors are marked
`online-adaptable` (initially: memory, policies; never: strategy code, kernel config).
Rules, each traceable to a researched failure:
1. Online changes are **provisional activations** — journaled like any activation but
   flagged; they expire unless confirmed by full offline validation at the next
   boundary (prevents CH-style unvalidated permanence).
2. Validation online uses **ProxyValidators** (oracle-relative scores, rolling success)
   because full suites are unaffordable mid-run (CH §4.6 is the evidence this works).
3. **Inheritance protection**: provisional changes may add artifacts but may not
   displace proven incumbents without meeting the inheritance-aware threshold
   (prevents the Red bootstrap regression, inherited share → 6.4%).
4. Trusted stall/drift monitors run at every refinement boundary and can freeze online
   adaptation entirely (fail-safe = stop adapting, keep acting; CH's capability-floor
   result says a weak refiner must fail *rejected*, not fail *degraded*).
5. Online refinement is cadence-triggered as well as failure-triggered (CH refines
   every F steps; hypothesis H7 in note 03 — cadence finds efficiency wins that
   failure-triggering misses).
6. Trusted evaluation data, history, and safety constraints are physically out of reach
   (L0 mechanism), so online adaptation cannot corrupt them even when it goes wrong.

## Cross-cutting invariants

1. Trust boundaries are mechanisms, never conventions.
2. Every metric, budget, and score is computed on the trusted side.
3. The journal is append-only; rollback and intervention are entries, not erasures.
4. Every model interaction is journaled and replayable; tests never require a network.
5. Failure is data: floor scores, partial answers, loud schema rejections — the loop
   survives any candidate behavior.
6. Every artifact invocation is attributed to a generation (usage accounting).
7. Nothing is promoted without empirical validation; static checks and LLM judgment are
   pre-filters only.
8. Durable side effects (accept, rollback, restart) are written as intents before
   execution and resolved after (exo's guardian pattern), so crashes mid-operation
   recover cleanly.

## What this replaces in v0

| v0 element | Disposition |
|---|---|
| `loop.run_cycle` stage sequence | retained; stages become protocols |
| single-file generations | replaced by composite per-surface deltas |
| boolean evaluator | replaced by `(score, feedback)` + failure-as-score |
| `decide` strict-improvement rule | retained, extended with held-out + inheritance-aware rules |
| ad-hoc dict serialization | replaced by shared typed codec + versioned schema |
| `python -I` + timeout | retained as sandbox tier 1 of 4 |
| ledger/activation/rollback | retained; gains usage accounting + intents |
| registry proposer | retained as one EvolutionAlgorithm; model-backed added beside it |
