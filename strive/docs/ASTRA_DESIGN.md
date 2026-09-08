# strive vNext — Astra design (research pass)

**Author: GPT‑6 Astra** (via `codex exec -m gpt-6-astra`, read‑only). Scribed to the
branch by the orchestrating Claude Code session. **Status: PROPOSAL — pending
human go/no‑go. No teardown has begun; no source changed and no tests were run
for this pass.** Reflects sources available 8 September 2026 plus static
inspection of `strive-astra`.

Recommendation in one line: rebuild strive around a **small verified execution
core, immutable agent bundles, and a restricted feedback channel** — keep
immediate model‑led adaptation, generalize what the agent can change and execute,
and make recovery and evidence rules easier to enforce.

## 1. The eight most relevant SOTA ideas

1. **GEPA — learn from diagnostic traces, not only aggregate scores.** Reflects on
   executions to propose targeted changes (ICLR 2026: ~6 pp avg over GRPO across
   six tasks, up to 35× fewer rollouts; `optimize_anything` extends to code +
   multiple components; July 2026 parallel‑proposal work). *For strive:* adopt
   evidence‑linked reflection + component‑specific diagnostics; keep GEPA's Pareto
   selection/acceptance OUT of the core.
   [paper](https://proceedings.iclr.cc/paper_files/paper/2026/hash/0e9e708b6f48e14fd0ac29e167413f76-Abstract-Conference.html),
   [API](https://gepa-ai.github.io/gepa/api/optimize_anything/optimize_anything/),
   [July update](https://gepa-ai.github.io/gepa/blog/2026/07/30/parallel-proposals/)
2. **DSPy — separate program structure, editable parameters, optimization
   strategy.** MIPROv2 (Bayesian search over instructions+demos) vs SIMBA
   (minibatch rules/demos) need different feedback/budgets. *For strive:* expose
   typed editable components + a common execution/evidence contract; optimizers are
   POLICIES consuming that contract, and their internal model calls must pass
   through strive's durable execution boundary.
   [MIPROv2](https://dspy.ai/api/optimizers/MIPROv2/), [SIMBA](https://dspy.ai/api/optimizers/SIMBA/)
3. **ADAS — agent architecture itself is an editable program.** Meta Agent Search
   edits control flow/tool use/decomposition, not just prompts. *For strive:*
   drop the "adaptable code = `solve(str)->int`" assumption; support versioned
   agent programs with declared entry points, deps, capabilities; retain prior
   attempts as provenance WITHOUT population selection.
   [ADAS](https://arxiv.org/abs/2408.08435)
4. **DGM / Hyperagents — separate improving task behavior from improving the
   improver.** DGM empirically evaluates self‑modified coding agents (and
   documented an agent gaming its own tool‑use logging). Hyperagents (Mar 2026)
   makes both task and meta‑agent editable. *For strive:* eventually allow
   refinement procedures to evolve as sandboxed artifacts, but keep evidence,
   scoring, budgets, permissions, verification OUTSIDE their authority — editable
   instrumentation can't certify its own change.
   [DGM](https://arxiv.org/html/2505.22954v1), [Hyperagents](https://arxiv.org/abs/2603.19461)
5. **Continual Harness / Prime Agent — adaptation belongs inside continuing
   operation.** Alternate acting + refinement without resetting the environment;
   versioned edits at turn boundaries; retained execution history vs
   non‑serializable objects needing reconstruction. *For strive:* preserve the
   operate→refine→apply→operate→review trajectory; add genuine stateful operation +
   explicit continuation state + versioned acting prompts. A persistent interpreter
   is NOT an exact‑resume spec.
   [Continual Harness](https://arxiv.org/abs/2605.09998), [Prime Agent](https://arxiv.org/html/2608.23552v1)
6. **ACE — accumulate structured knowledge via localized edits.** Separate
   generation/reflection/curation; incremental updates avoid wholesale‑rewrite
   information loss. *For strive:* make memories/skills independently addressable
   entries with evidence refs, scope, supersession; record which entries actually
   reached an invocation; summaries never gain the authority of the observations
   they summarize. [ACE](https://arxiv.org/html/2510.04618v1)
7. **Durable execution (Temporal/Restate) — recorded results + explicit effect
   identities + version pinning beat restarting a loop.** *For strive:* unify
   model, sandbox, tool, and environment calls under ONE effect lifecycle;
   preserve completed results; automatic retries require a real external
   deduplication contract (incl. billing).
   [Temporal replay](https://docs.temporal.io/workflow-execution),
   [worker versioning](https://docs.temporal.io/worker-versioning),
   [Restate](https://docs.restate.dev/references/architecture)
8. **Content addressing vs append‑only verification solve different problems.**
   Content addressing = exact artifact identity; ordered journal = which changes
   occurred and why; transparency‑log signed heads/consistency proofs make history
   independently checkable — none alone proves a claim truthful. *For strive:* keep
   artifact identity separate from command/change identity; define the verifier's
   trusted inputs explicitly; if rollback/replacement protection is needed, keep
   authenticated history heads OUTSIDE the writable artifact store.
   [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects.html),
   [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html)

## 2. KEEP / DISCARD / ADD

**KEEP** — the mission split (policies judge; core enforces integrity, permissions,
budgets, evidence eligibility); one authoritative journal + CAS, exact composite
before/after changes, atomic activation, explicit rollback; result‑driven
continuation, pinned run identity, durable reservations, honest `indeterminate`;
the pure closed verifier + preflight (an accepted append can't invalidate the
run); mechanically‑enforced sandbox capabilities + protected records vs
policy‑visible projections.

**DISCARD** —
- Function‑task assumptions in the kernel (`_run_attempt` still selects
  `strategy-code/solve` and runs `TaskCase` sequences; the neutral projection is
  good but the executor is still specialized). `src/strive/kernel.py:1564`.
- Overlapping representations / specialized lifecycle paths (canonical command
  JSON + normalized shadow fields, pipe‑delimited model identity, separate
  model/fork/operation bookkeeping) → typed command variants + shared effect
  records (keep the checks, drop the duplication). `src/strive/kernel.py:1777`.
- Broad read access disguised as isolation (`RunView` exposes all event bodies +
  a general CAS reader — fine for trusted policy code, insufficient once policy
  code is model‑authored). Give such code only authorized artifacts/projections.
  `src/strive/policy.py:47`.
- The Aug promotion‑era matrix's universal gate + population search (superseded by
  ADR‑0008 + the mission brief) — do not reintroduce via an optimizer integration.

**ADD** — generic resumable operation steps + explicit environment continuation +
immutable executable bundles with full dependency manifests; typed
`ReviewDecision` + atomic revision supersession; typed usage provenance
(measured/reserved/unknown); evidence eligibility enforced BEFORE context
construction (incl. inherited memories, summaries, scalar scores, retrieved
artifacts); component‑use attribution + prompt‑only behavioral‑change experiments;
incremental verification over an already‑verified prefix (current append refolds
the whole stream — `src/strive/substrate.py:813`).

**Concrete evidence issue to fix:** optional forks use `selection_cases()` (which
includes `held_out`), and model review receives their aggregate scores — a
conflict with the strict held‑out prohibition when forks are enabled; hiding raw
cases doesn't remove the feedback. Refinement context also carries an
undifferentiated failure count. `src/strive/tasks.py:64`,
`src/strive/policies/continual_refine.py:745`, `:678`.

## 3. Recommended non‑backward‑compatible vNext architecture

New run format, command API, policy API, artifact schema; new artifact root; no
migration/aliases/dual‑writing. Local runner first (framed journal + CAS; adopt
Temporal's execution discipline; add a Temporal/Restate adapter only if
distributed operation becomes a real requirement).

| Component | Responsibility |
|---|---|
| **Run manifest + agent bundles** | Pin trusted runtime, schemas, policy package, seed, budget, operation defs, initial state. Bundles = exact code, prompts, skills, memory bindings, dep locks, entry points. Requested capabilities cannot grant permissions. |
| **Journal + CAS** | Immutable artifacts + one authoritative sequence of commands/effects/revisions/continuations. Indexes/views rebuildable. Distinct identities for identical content across attempts. |
| **Pure verifier** | Decode a closed record vocabulary; verify references, causation, transitions, reservations, evidence eligibility, checkpoint cursors. Operation‑specific checks live in an explicitly trusted, pinned verifier distribution. Never execute model code. |
| **Effect supervisor + budget ledger** | Own dispatch, reconciliation, deadlines, cancellation, reservations, receipts, terminal results. Stable effect IDs; reject stale workers. ALL execution routes through here. |
| **Sandbox + capability broker** | Execute model‑authored acting/refinement code with restricted inputs + enforced limits. Keep credentials, protected evidence, journal writes OUTSIDE the sandbox. Broker authorized tools/model calls via the supervisor. |
| **Operation + evidence layer** | Describe resumable work, environment state, observation semantics, visibility, comparability. Convert protected receipts → bounded policy‑visible evidence. Separate behavioral vs infrastructure vs uncertain outcomes. |
| **Policy runtime** | Run the adaptation policy over authorized evidence + explicit continuation state. Preserve `ApplyChange`, optional `EvaluateFork`, review/revise/revert. Supervisor enforces legal transitions without judging improvement. |

**Refinement cycle:** operate bounded steps on one pinned bundle (journal each
external interaction + continuation) → build a durable evidence package of only
eligible observations + authorized refs → ask the model for a typed change
(persist request/response/proposal/usage via the supervisor) → validate
structure/capabilities/dep‑closure/expected‑state, atomically activate at the next
operation boundary (comparative eval optional) → operate with the new bundle,
recording which components were consumed → review eligible evidence (confirm =
decision about an already‑active change; revise atomically supersedes; revert
applies an exact inverse when preconditions hold).

**Two essential distinctions.**
- *Recovery restores recorded execution state; it does NOT recreate an unknown
  external outcome.* Crash table: before dispatch‑auth → execute once on resume;
  result durable / completion missing → finish bookkeeping from the stored result;
  dispatch authorized / result unavailable → query or dedup via a supported adapter
  contract, else retain `indeterminate` + reservation; completion durable /
  checkpoint missing → consume once, restore continuation, no repeat. An explicit
  retry is a NEW separately‑budgeted attempt unless the provider guarantees dedup;
  a deterministic seed does not justify repeating a paid model call.
- *Revision rollback restores agent configuration; it does NOT undo the world.*
  Reverting a prompt/skill can't unsend a message; environment snapshots +
  compensating operations need separate explicit semantics.

**Evidence:** distinguish the exact execution plan from its comparison contract
(workload/sampling rule, environment regime, scoring semantics, validity). Same
plan for the deterministic suite; for a changing environment, matching identifiers
alone can't establish causal improvement — if comparability can't be established,
review stays unresolved.

**Invariant mapping.** (1) Durable/resumable: journal every consequential
decision+effect; pin continuation inputs; consume results once; retain
uncertainty+reservations. (2) Verifiable: content‑addressed closure, closed
schemas, exact transitions, trusted receipts, pure verification before mutation
(consistency under declared trust, not proof of improvement). (3) Secure floor:
sandbox every model‑authored executable incl. future meta‑policies; trusted broker
owns permissions/spend/receipts/persistence. (4) Policy‑neutral+model‑led:
structurally valid changes activate immediately; policies choose timing/review/fork;
no Pareto/universal gate. (5) Behavioral evidence gates: only valid, comparable,
authorized behavioral evidence reaches adaptation; infra failures affect
recovery/scheduling not diagnosis; held‑out audits stay out of adaptive decisions
incl. via aggregates + inherited memory.

**Replacement acceptance suite (define before teardown):** crash‑boundary checks,
forged‑record rejection, sandbox‑escape checks, budget reconciliation, hidden‑data
noninterference, prompt‑only behavioral change. Keep strict typing + installed‑wheel
CLI test + fresh‑interpreter verification as release gates.

## 4. Human decisions required BEFORE teardown

1. **First real operational workload?** (stateful coding / tool‑using / simulated
   env differ in continuation + security contracts). *Astra rec: one stateful
   workload alongside the existing deterministic fixtures.*
2. **What may evolve in the first release?** *Astra rec: acting code + acting
   prompts + structured memory first; keep the refinement controller pinned.*
3. **What must "exact resume" promise for external systems?** honest suspension on
   uncertainty vs required provider auto‑recovery — name the tools/providers first.
4. **What counts as comparable online evidence?** snapshots / repeated workloads /
   controlled sampling / observational windows — don't encode causal certainty the
   environment can't provide.
5. **Where is the feedback boundary?** *Astra rec: explicitly policy‑visible dev
   data for optional forks + separate blind audits; any hidden‑score influence
   needs an explicit change to invariant 5* (this fixes the held‑out‑via‑forks leak).
6. **How does improvement transfer between runs?** *Astra rec: immutable bundle
   imports with provenance + declared scope; avoid silently changing global state.*
7. **Which threats + deployment scale must vNext cover?** untrusted generated code
   + accidental corruption vs malicious storage replacement / hostile operators /
   multi‑machine — determines authenticated history, worker fencing, sandbox
   deployment, and whether a distributed execution service is justified.
8. **What evidence justifies the teardown?** *Astra rec: a budget‑matched
   experiment (fixed behavior vs continual refinement) + the invariant acceptance
   suite; measure cumulative performance, adaptation cost, regressions, recovery.*
