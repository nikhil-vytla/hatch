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

The L0/L2 distinction is enforced by **mechanism, not policy**, stated precisely:
evolvable artifacts are data materialized into sandboxed workspaces and are never
imported into the kernel process. That is process separation, not confinement —
until Landlock/seccomp or containers exist (stages 3/6), malicious candidate code
can access anything available to the controller's OS user, including the ledger
and task files on disk. The kernel never *trusts* anything a candidate produces
(all metrics and decisions are computed kernel-side), but tamper-resistance of
at-rest state against a hostile candidate is future work. (exo's concession that
its "immutable" harness is only protected by default config — RSI.md fn.2 — is
the anti-pattern; NOOA's "validators are guardrails, kernel isolation is the
boundary" doctrine is the pattern strive is building toward.)

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
1. `subprocess` — `python -I` + timeout (v0 floor);
2. `restricted` — + scrubbed environment (no inherited secrets), private temp
   workspace as cwd, bounded stdout/stderr, POSIX rlimits (CPU, file size, open
   files). **Implemented in phase 3** as the default. Honest limits: network
   denial is NOT enforced (no reliable unprivileged cross-platform mechanism),
   RLIMIT_AS is unreliable on macOS, and filesystem confinement is absent — a
   candidate that guesses absolute paths can touch anything the controller's
   UID can. Fault containment, not a security sandbox (see README).
3. `kernel` — Landlock + seccomp self-installed post-fork with fail-closed capability
   probing (NOOA `guards.py`, note 06; Linux-only — macOS falls back to tier 2);
4. `container` / microVM (stage 6).
The runner **rejects loudly on schema mismatch** (implemented: protocol-checked
payloads, dedicated exit code, recorded `schema-mismatch` failure) — a malformed
payload is an observable failure event, never a silent fallback (CH's
842-repetition stall was caused by exactly that silence, note 03 §B.3).

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
6. Trusted evaluation data, history, and safety constraints are outside the online
   loop's *interfaces* — online refinement has no kernel API that reaches them. (Until
   OS-level confinement exists this is interface discipline plus process separation,
   not physical unreachability; see the trust-boundary statement above.)

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

## Stage 3A: contract design for composite evolution

Stage 3's contracts are settled in six ADRs under [adrs/](adrs/README.md),
written design-first with experimental spikes (`stage3_contracts.py`) proving
the shapes round-trip before anything migrates:

- **ADR-0001** `HarnessRevision` replaces one-generation-one-file:
  `RevisionRef(scope, id)` identity, `base_parent` distinct from
  `provenance_parents`, optional `proposal_ref`/`provenance_ref`, and
  deltas as **complete binding transitions** — `BindingState = absent |
  masked | content(ref, descriptor_ref)` with before/after states, making
  exact inversion, unmasking, and conflict checks representable
  (create/update/delete/mask/unmask are derived labels). A revision owns a
  content-addressed `ScopeManifest` (its scope's bindings incl. masks);
  runs/evaluations reference a `ResolvedHarnessManifest` (effective bindings
  + contributing revision refs/journal heads). Versioned
  `SurfaceDescriptor`s (artifact schema, materializer, allowed scopes,
  validation policy, risk-policy ref, online policy) form the trusted
  allowlist (historical: registry keyed by kind@version + a current
  pointer, so old bindings stay valid across upgrades); content bindings
  pin `descriptor_ref`; **risk is computed from the delta itself (no label
  argument to spoof); policy-param families fail closed, and trusted
  settings (sandbox/budget/evaluator/acceptance/secrets/ledger) are not
  representable as evolvable params**. The lifecycle seam is frozen too:
  RevisionActivation@1 preserves every activation@2 field with derivation
  parity, and MigrationProvenance keeps task fingerprint/origin/weakness/
  decision evidence lossless.
- **ADR-0002** typed `ScopeRef` + explicit `ResolutionContext` (no colon
  parsing, no implicit default project): global → project → task → run with
  nearest-scope shadowing over scope manifests; `delete` removes this scope's override
  (inheritance resumes) while `mask` is a tombstone stopping fall-through;
  every run journals its resolved-manifest ref for exact replay;
  provisional is an activation *mode*, not a scope; cross-scope promotion is
  a gated selection with cross-task evidence.
- **ADR-0003** environment-generic `TaskSpecVersion` (adapter, action/
  observation schemas, scorer, config ref — `solve(str)->int` lives in the
  FunctionTask config blob) vs. fully reconstructable `DatasetRevision`
  (per-split CAS manifests); `EvaluationManifest` pins harness state ref,
  objective spec, task+dataset fingerprints, environment/scorer/tool/runtime
  versions, seeds, validators, budgets — and is owned by ValidationBundles,
  never revisions; base `EnvironmentSession` protocol with optional
  Resettable/Checkpointable/Forkable capabilities (reset is not assumed);
  regression growth = new dataset revision + forced re-baseline.
- **ADR-0004** policy-neutral `SelectionDecision`: `policy_ref`
  (name@version) + a closed kernel disposition vocabulary
  {promote, reject, frontier_add, provisional_activate} — **every
  disposition requires evidence bundles**; each decision pins its
  `objective_spec_ref`; policy detail lives in CAS evidence artifacts.
- **ADR-0005** algorithms request propose/validate/submit through a narrow
  `KernelServices` handle under a trusted budget — bypass prevention is an
  **API contract for trusted L1 plugins, not hostile-plugin isolation**
  (stated honestly); search state is resumable via journaled
  `AlgorithmRun`/`AlgorithmStep` records; prompts render a versioned
  `ObjectiveSpec`; frontiers are journaled `frontier_add` decisions.
- **ADR-0006** backend protocols (ledger/artifact/event/index): JSONL stays
  the transparent authoritative journal; `append_batch` commits by *framing*
  (batch id + commit marker; an unmarked batch is torn tail), cursor reads,
  index-through-head semantics — and the commit ordering rule: revision,
  evidence, and decision are individually durable *before* activation is
  attempted, so a lost activation head-race orphans nothing; a sequential
  migration registry generalizes `migrate-legacy`.

Freeze scope: only the core wire types are frozen for 3B (adrs/README has
the authoritative table); task/dataset/evaluation, selection/frontier,
algorithm-state, and backend schemas stay provisional until their slices.
Stage 3B landed exactly that narrow slice: **dual-write revision storage**
with an explicit crash-consistency model — canonical history in the task
ledger, derived mirrors in a separate journal matched by `SourceRecordRef`;
pure projection planning split from locked, head-checked application;
durable intent→progress→completed operations for backfill/repair (pending is
determined by completion, not parity); a fail-closed projector pinned to
`generation-to-revision@1` and explicit historical descriptors; and the
`source-committed-parity-incomplete` condition when a source commit's mirror
publication fails. The loop, activation, cycles, and replay remain
generation-native until a later parity slice.

## Implementation status (after phase 3 hardening)

| Architecture element | Status |
|---|---|
| versioned typed contracts + one shared codec, loud rejection | **implemented** (`contracts.py`, `codec.py`; golden-record compat tests) |
| append-only ledger, atomic activation, journaled rollback, lineage | **implemented** (`store.py`; torn-tail tolerance, interior corruption loud) |
| content-addressed artifacts with read-time verification | **implemented** (`cas.py`) |
| task-owned scoring; visible/held-out/regression/adversarial splits | **implemented** (`tasks.py`) |
| `(score, feedback)` evaluator + failure-as-score | **implemented** (`evaluate.py`) |
| holdout isolation (mechanical: `VisibleContext`) | **implemented** (`diagnose.py`, `loop.py`; spy-tested) |
| trusted budget meter, uniform semantics (0 = none, -1 = accounting-only); wall/executions/model-calls/cumulative-output hard-enforced; tokens enforced between calls + requested-output cap, with post-call overruns rejected and journaled (one call's input tokens can overshoot); cost enforced only against adapters that report trustworthy cost (fail-closed otherwise — the OpenAI-compatible adapter does not) | **implemented** (`budget.py`, `model.py`; every enforced limit tested; per-limit semantics journaled each cycle) |
| usage attribution per invocation | **implemented** (execution events carry `generation_id`) |
| trusted stall detector + freeze/resume interventions | **implemented** (`monitors.py`) |
| pluggable named+versioned acceptance policies, recorded per decision | **implemented** (`policy.py`: `paired-deterministic@1`, `provisional@1`) |
| provisional activations: scoped, monitored, expiring, reverting | **implemented** (`loop.py::_resolve_provisional`) — refused for executable strategy-code until risk-aware surface descriptors exist |
| provider-neutral ModelAdapter + deterministic fake + journaled metered I/O | **implemented** (`model.py`; latency + content-addressed prompt/completion artifacts; env-only real adapter) |
| model-backed proposer (stage 2b) | **implemented** (`model_proposer.py`): visible-evidence prompt, structured proposal schema, strict classification (truncated via normalized finish reasons / malformed / schema-invalid incl. trace-evidence citation checks / forbidden / stale / budget), kernel-side staleness + source screen; offline demos use a scripted proposal fixture (pipeline proof, not model reasoning) |
| generic evidence diagnoser (registry-free) | **implemented** (`diagnose.EvidenceDiagnoser`) — packages visible failure evidence without naming a weakness |
| sandbox tier 2 (scrubbed env, workspace, rlimits, bounded output) | **implemented** (`sandbox.py`) — network denial NOT enforced; see honest limits |
| task-scoped state: per-task ledgers, task id + fingerprint on generations/activations, task-bound stores, one shared binding guard on every public operation, read-time foreign-record rejection, fingerprint-drift refusal (`--acknowledge-task-drift`), advisory writer lock + activation head checks | **implemented** (`store.py`, `loop.py`) — single-writer per task; concurrent multi-host writers out of scope |
| legacy stage-2a ledger: loud detection + `strive migrate-legacy` (history preserved, original file untouched, migration journaled) | **implemented** (`migrate.py`) |
| evaluation discipline: visible (train) / selection (held-out, regression, adversarial) / audit (final holdout, on-demand only) | **implemented** (`tasks.py`, `loop.audit_generation`); proposer history carries visible-split scores only |
| execution-and-decision replay (baseline + candidate re-execution, recorded-policy decision check) | **implemented** — full-cycle replay (diagnosis, prompt reconstruction, completion injection, proposal parsing, screening) is pending |
| composite per-surface generations | **frozen core implemented as a crash-consistent dual-write mirror** (`revisions.py`, `dualwrite.py`): mirrors live in a separate append-only journal keyed by `SourceRecordRef` (never position); pure projection plans with stale-plan refusal; durable intent→progress→completed operations; fail-closed pinned projector (`generation-to-revision@1`, historical descriptors); operation-specific evidence; explicit `source-committed-parity-incomplete` condition. Stage 3B.1 added prefix-pinned intents with prefix-scoped completion, op-level locking, fail-closed planning, full artifact-closure verification, quarantine+rebuild recovery (with precise detection of stage-3B-era journal formats), subject-specific revision shadow reads at every native read's point of use with durable deduplicated divergence events and coverage accounting (`strive shadow`), per-execution ResolvedHarnessManifest provenance at tamper-evident journal heads, and an explicit cutover-eligibility gate. Stage 3B.2 centralized every operation's reads behind one boundary (`strive.reader.StateReader`) with durable journaled modes (native default / shadow / revision-canary): coherent one-read canonical+mirror captures (native view and SourceSnapshot from the same bytes; optimistic read-recheck loop), stale-head-refusing mutations (activation/rollback/seed/provisional), exact evaluated-subject identity (immutable unactivated candidate overlay revisions created+validated before evaluation, retention linked back and verified content-identical), one parity-grade `VerifiedRevisionSnapshot` validator, a locked+fsynced task-bound reader journal in crash-framed hash-chained batches (deletion/reorder/forgery detected), fail-closed control (repair/version-change atomically breaker+epoch-reset; eligibility re-checked at operation start; head-checked transitions; journal-independent force-native kill), and a reversible **revision-derived execution/read canary** refused for unsafe model code. Stage 3B.3 added the canonical native-revision lifecycle (`strive.lifecycle`, `<task>.revisions.jsonl`): an append-only crash-framed journal — the owner of native composite revisions (generations/mirror are derived compatibility) — separating identity (`RevisionRetained`, the exact evaluated overlay by CAS ref) from per-assessment evidence (`RevisionEvaluated`/`RevisionSelected`, validated refs, repeated assessment supported) with evidence-gated activation (`TrustedOverride` for anything else); activation is ONE recoverable cross-journal operation (intent/progress/completed + reconcile: abandon/resume/revert+breaker) so identity+evidence persist before served behavior changes and lifecycle failures after generation activation are never swallowed; validation replays the parent ScopeManifest exactly (stale before-states, undeclared changes, dropped surfaces fail closed); whole-revision rollback drives both journals and `compat_parity` exposes agreement; framed journals refuse appends over unverified regions with durable quarantine+truncate recovery; migrations 0003/0004 preserve pre-3B.3 lifecycle and PR#43 reader-journal history (actual active revision kept, bytes quarantined). Hash chains are tamper-evident, not same-UID secure; lifecycle authority is refused for unsafe model-generated code. Stage 3C.1 made the prompt surface operational with surface-specific evidence: the default template is pinned into lifecycle state at seeding (`rev-prompt-default`; resolution reads history, never the current build's string), the hardened `prompt@3` descriptor validates templates by exact string.Formatter parsing at retention/activation/resolution/replay and bounds rendered prompts before any provider call, requests pin parent revision + lifecycle head + prompt ref with post-call staleness rejection, proposals carry generic typed `surface_updates`, and the trusted `strive.promptgate` comparison (matched candidate-vs-incumbent proposer trials, strict-dominance verdict) gates every composite carrying a prompt delta — code that passes with a non-improving prompt activates only as its code-only sibling while the composite is retained rejected, so neither surface piggybacks on the other's evidence. The matched-arm causal experiment (incumbent prompt fails, candidate prompt flips the outcome with everything else equal, ablations isolate the effect, and a two-stage self-produced prompt+code composite is evaluated/retained/activated/restarted/replayed/rolled back as one exact revision) runs over normal metered paths with a persisted manifest in a unique run directory; offline fixture = causal pipeline wiring, real-model runs opt-in and labeled single-trial. Stage 3C.2A froze the evidence/selection envelopes (`strive.evidence`): dataset revisions with per-split CAS manifests persisted per task; evaluation manifests owned by role-bound validation bundles (task/prompt/constraint — flat metrics, per-case CAS artifacts); a trusted validator registry resolved by exact name@version; policy-neutral SelectionDecisions with typed evidence roles and a closed disposition vocabulary (frontier_add structurally supported, no frontier algorithm); an activation-evidence gate demanding complete CURRENT evidence for the exact revision and active baseline (missing roles, borrowed subjects, relabeled roles, stale datasets, unknown validator versions, corrupt artifacts, and failed/inconclusive hard constraints all block; dataset growth forces incumbent re-baselining, never drift acknowledgement); activation citing the exact SelectionDecision; and migration 0005 linking pre-envelope history to synthetic-but-lossless envelopes without rewriting a byte. Revision-native execution and the algorithm comparison remain future work |
| EvolutionAlgorithm plugin (Pareto population) | **designed** (ADR-0005) — implementation stage 3C |
| inheritance-aware replace-vs-add thresholds | pending (needs usage-share history to act on) |
| Landlock/seccomp tier, containers, secrets broker | pending (stages 3/6) |
