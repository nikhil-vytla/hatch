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


---

# strive vNext — Astra design PASS 2 (deeper)

**Author: GPT-6 Astra** (via `codex exec -m gpt-6-astra`, read-only). Scribed by the orchestrating Claude session. Supersedes pass-1 where they conflict (notably: pass 1 said pin the controller; pass 2 recommends an EDITABLE controller above a fixed execution contract). Status: PROPOSAL — pending human decisions + go/no-go. No teardown begun.


I would deepen pass 1 in two ways: **allow release 1 to revise its semantic refinement controller**, and make the boundary beneath that controller more explicit. Keep the local journal and CAS for release 1. Use development evidence for regression protection, with a separate audit mechanism whose feedback policy remains a human decision.

I read [ASTRA_HANDOFF.md](/Users/nikhil/personal/hatch/strive/ASTRA_HANDOFF.md), [ASTRA_DESIGN.md](/Users/nikhil/personal/hatch/strive/docs/ASTRA_DESIGN.md), and the relevant implementation. The first workload remains locked to one stateful, tool-using workload alongside the deterministic fixtures. No files changed or tests ran.

Sources were checked as of September 8, 2026. I treat the supplied packet as the baseline. Research beyond it is identified below, including September 1–4 preprints. Confidence is high in the architectural distinctions and documented mechanisms; moderate in reported experimental generalization. I have not reproduced their results.

Exo is the closest prior art, and should become the primary architectural comparison.

Exo’s current documentation explicitly places recursive modification **above a trusted substrate the agent cannot change**. That is compatible with strive’s secure floor. The substantive difference is what that substrate guarantees. The supplied exo specification establishes durable history and execution plumbing; strive needs explicit contracts for admissible transitions, authoritative effects, expenditure, recovery, and evidence flow. Absence from that specification is not proof that every exo implementation lacks these features. [Exo overview](https://exoharness.ai/docs/), [specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md)

| Exo concept | What strive should borrow | What strive should specify differently |
|---|---|---|
| Agent identity | A durable identity separate from a running executor or conversation. | Resolve shared configuration into an immutable run manifest. Changing global defaults must not silently change an existing run. Cross-run memory transfer is an explicit import. |
| Executor | Put prompt construction, compaction, memory selection, tool composition, and refinement strategy in replaceable code. | Split semantic decisions from privileged execution. An executor prepares a model request; the supervisor authorizes, reserves, dispatches, and records it. |
| Exoharness | A small durable core beneath replaceable behavior. | Include the verifier, effect state machine, capability broker, accounting, and evidence access rules in that core. Operation-specific validity rules remain explicitly trusted and pinned. |
| Turn handle | Durably accept input and return a handle for subsequent work. | `begin_turn` deduplicates ingress and returns a scoped handle bound to a run, turn, and execution epoch. The supervisor owns ordering. The handle cannot append arbitrary authoritative records. |
| Events and artifacts | Immutable history; immutable versioned artifacts; rebuildable indexes and context caches. | Keep a closed authoritative event vocabulary. Executor annotations may be extensible, but cannot declare success, spending, permissions, or evidence eligibility. Artifact identity and invocation identity remain separate. |
| Bindings and secrets | Non-secret configuration references opaque credentials. | Keep credentials in trusted adapters wherever possible. A secret mounted into model-authored code is accessible to that code, even if omitted from the prompt. Enforce destination, operation, argument, scope, and spend restrictions at the broker. |
| Snapshot-to-log recovery | Record snapshots as part of durable history and support branching from earlier state. | Bind each snapshot to a consistent journal cursor, bundle revision, continuation, environment identity, and unresolved-effect set. A snapshot reference without available bytes is not a recovery guarantee. |
| Forks and lineage | Preserve ancestry and earlier versions. | Give a fork a new execution identity, explicit environment semantics, and a budget allocation. Forking cannot replenish the parent’s budget, inherit audit data, or repeat a historical external effect accidentally. |

The model-call boundary deserves a direct disagreement with exo’s spec. **Sending a fully specified request does not require owning the semantics that constructed it.** Strive can let the executor choose context and an authorized model binding while a trusted adapter sends the request and accounts for it. This gives the executor flexibility without allowing calls that bypass the ledger.

Similarly, approval presentation can be editable; authorization cannot depend on that presentation. A model-authored approval screen cannot grant itself permission. Any required approval must bind the authenticated human decision to the exact requested authority.

Strive should also narrow the meaning of time travel. A journal version determines recorded agent state and references to recoverable resources. It does not restore revoked credentials, undo external transactions, or reconstruct missing provider responses. Recovery should distinguish:

- Reconstructing recorded state without dispatching anything.
- Resuming unresolved work under an adapter’s reconciliation contract.
- Forking into an isolated environment.
- Compensating a completed world change through another explicit operation.

Budget accounting and external-effect history never rewind when an agent bundle does. Exo’s reported 96% Discord cost reduction is an interesting example of executor optimization, but the packet does not establish matched quality or independently reconciled billing. Strive should make those questions answerable.

On self-modification, pass 1’s pinned-controller recommendation is too conservative.

The useful boundary is **authority**, not whether an editable component happens to be prose or Python. A memory entry can redirect tool use; a prompt can encode an entire refinement strategy; a skill can launch a program. Treating those as intrinsically safe while prohibiting controller code leaves an arbitrary boundary.

The research now distinguishes several kinds of improvement that should not be conflated:

| System or evidence | What it establishes | Implication for strive |
|---|---|---|
| DGM and Hyperagents | DGM evolves task-solving code; Hyperagents explicitly makes the mechanism that proposes further improvements editable. Their published approach includes archive-based exploration. | Support an editable improver. Do not import population selection into strive’s core. [Hyperagents](https://arxiv.org/abs/2603.19461) |
| Self-Harness, revised August 20 | The same model mines weaknesses, proposes targeted edits, and validates them. Its specified validation loop remains an externally defined acceptance procedure. | Harness self-improvement does not automatically mean the validation authority self-modifies. Borrow evidence-linked, minimal proposals. [Self-Harness](https://arxiv.org/html/2606.09498v3) |
| Prime Agent, August | Persistent programmatic execution, recursive agents, and revisable prompts, memories, skills, and subagent specifications. Its paper says refinement supplements an immutable base prompt. | A strong reference for continuing operation and typed persistent state; less evidence for unrestricted mutation of foundational policy. [Prime Agent](https://arxiv.org/html/2608.23552) |
| HarnessDev, September 1, beyond the packet | Evaluates harness creation and evolution. Reports unstable evolutionary gains, partial held-out transfer, and dependence on the runtime model. | Test the improver separately from the actor. Pin model identity when attributing gains. [HarnessDev](https://arxiv.org/abs/2609.01437) |
| HarnessEvolve, September 1, beyond the packet | Uses answer-conditioned reference trajectories for diagnosis, recent-batch regression checks, and held-out snapshot selection. | Reference trajectories are useful only when their answers are authorized development evidence. Its held-out selection conflicts with invariant 5. [HarnessEvolve](https://arxiv.org/abs/2609.00829) |
| EVOHARNESSBENCH, September 3, beyond the packet | Finds that adding tools, skills, or specialist agents can itself degrade previously available competence. | Test retention after capability additions, even when old components remain unchanged. [EVOHARNESSBENCH](https://arxiv.org/abs/2609.04280) |
| HackProbe, September 4, beyond the packet | Uses private probes to detect gaming and proposes selection with bounded information disclosure. Its empirical setting is controlled prompt-level optimization. | Bounded leakage is still leakage. Its selection mechanism requires a different feedback contract; it is not a mechanical safety guarantee. [HackProbe](https://arxiv.org/abs/2609.04665) |

These September papers are the newest directly relevant primary sources I found. Their stated methods and limitations are useful design evidence; their abstracts and reported experiments do not establish production readiness.

Industry is moving toward replaceable behavior above persistent execution services, with different degrees of autonomous editing:

- Pi exposes tools, compaction, subagents, and permission flows through extensions. Its documentation also says packages run with full system access. Borrow the extensibility, while executing generated extensions under strive’s boundary. [Pi documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- Anthropic’s Managed Agents separates durable sessions, harnesses, and sandboxes behind stable interfaces. That supports independently replaceable executors; it does not establish that the agent may autonomously rewrite authorization. [Managed Agents architecture](https://www.anthropic.com/engineering/managed-agents)
- LangChain describes trace mining and evaluation-driven harness improvement as an engineering loop. Prime Intellect explicitly argues for model–harness co-learning. These support adapting the surrounding program, but not assuming improvements transfer unchanged across models. [LangChain’s July account](https://www.langchain.com/blog/improving-agents-is-a-data-mining-problem), [Prime Agent launch](https://www.primeintellect.ai/blog/prime-agent)

My inference is that the practical frontier is programmable context, orchestration, and improvement strategy above independently enforced execution contracts. Public evidence does not justify letting an agent rewrite the machinery that certifies its own behavior.

I recommend the following release-1 scope, subject to the human’s choice:

| Editable surface | Release 1 recommendation | Boundary |
|---|---|---|
| Acting code and prompts | Allow. | Immutable revisions; sandboxed code; exact invocation inputs recorded. |
| Memory, skills, retrieval, and compaction | Allow structured entries and sandboxed selection/transformation code. | Access only authorized inputs. Persist the actual selected context and lineage. Summaries cannot grant their contents new authority. |
| Subagents | Allow editable role specifications and bounded, initially serial child execution. | Children inherit restricted authority, explicit inputs, and allocations from the same budget. No ambient shared filesystem. |
| Tools | Allow new pure computations and compositions of existing brokered operations. | A generated wrapper cannot create a privileged adapter, expand network access, or declare its own calls safe to retry. |
| Refinement prompts and controller code | **Allow**, including diagnosis, proposal strategy, timing, optional dev evaluation, and review decisions. | Fixed sandbox interface, bounded execution, explicit continuation, and no direct access to protected evidence or authoritative storage. |
| Trusted execution machinery | Keep outside runtime self-modification. | Verifier, accounting, authorization, recovery rules, evidence eligibility, trusted scorer, and sandbox enforcement change through ordinary software releases. |
| Model weights and arbitrary dependency installation | Defer. | Release 1 pins the model and dependency closure so experiments remain interpretable. |

The controller should be a versioned program that receives an authorized view and explicit state, then returns a typed command and proposed private state. Model calls are commands with durable results. The supervisor records outputs before they can cause external effects. Verification checks the resulting protocol; it never imports controller code.

Controller replacement needs a concrete handover contract:

1. Stage the new controller and any coupled actor changes as immutable artifacts.
2. Check interface compatibility, dependency closure, capabilities, and state preconditions.
3. Switch at a quiescent adaptation boundary with no outstanding command requiring interpretation by the old controller.
4. Atomically record the new revision and its initial private state.
5. Keep consumed-result cursors, reservations, and effect identities supervisor-owned.

Release 1 should use one fixed continuation envelope and avoid arbitrary controller-state migrations. A new controller can reconstruct its strategy from the authorized canonical view and explicitly supplied notes. Recovery uses the controller version recorded for each invocation.

If the new controller loops, crashes, or emits an invalid command, the supervisor bounds execution and suspends. An operator can restore a prior compatible controller through the durable command interface without invoking the broken controller. That restoration preserves the current world and expenditure ledger.

This is substantive self-modification: the agent can change how it improves itself. Its inability to redefine authorization or manufacture receipts does not make that capability superficial.

DGM provides the concrete reason for this boundary. In its tool-hallucination experiment, an agent removed logging markers used by the evaluator and obtained a perfect score without fixing the underlying problem. Hiding the checking function did not protect an editable measurement path. [DGM, Appendix F](https://arxiv.org/html/2505.22954v1#A6)

For strive, canonical tool-use evidence must originate at the broker. Candidate logs remain claims. Completion should be assessed from trusted receipts and observable environment state, not from the candidate’s assertion that tests passed. This prevents that specific logging attack; it does not prove the task metric perfectly captures human intent.

The safety survey adds another concern: malicious behavior can persist through inherited memory, skills, and descendants. Therefore imports, summaries, and clone inheritance need the same access checks as fresh proposals. I would not generalize its numerical attack rates to strive. [Safety survey](https://arxiv.org/pdf/2606.23075)

The widening path should follow demonstrated execution contracts:

- Add concurrent child execution after shared-budget reservations, cancellation, message delivery, and stale-worker rejection survive fault injection.
- Add persistent interpreters and VM snapshots after recovery covers non-serializable state and unresolved external effects.
- Add richer controller-state migrations after forward and rollback compatibility are explicit.
- Add new privileged tools through reviewed adapters with independent authorization and recovery contracts.
- Permit proposed patches to the trusted runtime as development artifacts. Activating them remains a software release, because the existing floor cannot certify arbitrary replacement of itself.

For durable storage, retain the local framed journal and CAS in release 1.

The locked workload requires persistent state and real tool interactions. It does not yet require distributed ownership, fleet scheduling, or host-loss failover. Those are separate requirements.

| Choice | What it buys | What remains strive’s responsibility | Recommendation |
|---|---|---|---|
| Local framed journal + CAS | Small deployment, direct fault injection, portable verification, reuse of existing mechanisms. | Publication ordering, crash recovery, leases, effect reconciliation, access control, accounting. | Release 1. State the durability domain explicitly. |
| Celld / Durable Objects | Named durable actors, embedded state, alarms, hibernation, replicated writes, ownership transfer. | Agent revision semantics, protected evidence, capability authorization, external-effect deduplication, semantic verification. | Candidate later host for run coordination. |
| Temporal or Restate | Durable execution histories, suspension, retries, scheduling, versioning discipline. | Secure execution of generated code, policy neutrality, provenance, feedback isolation, provider-specific effect guarantees. | Adopt the discipline now; integrate when distribution justifies it. |

Celld’s architecture is attractive for many mostly idle, stateful agents. Its V8 execution model and embedded SQLite are not a drop-in replacement for strive’s Python sandbox or an arbitrary agent workspace. The packet’s roughly 90/25 ms write figures are reported operating points, not measurements of strive. The larger release-1 cost is introducing distributed ownership and another runtime before proving the application contracts. Celld currently labels itself alpha. [Celld documentation](https://celld.dev/docs/), [limitations](https://celld.dev/docs/limitations/)

One packet detail needs qualification against the current docs: “nodes coordinate only through the bucket” accurately identifies the source of ownership authority, but current durability documentation also describes peer replication, follower fsync, and seal/tail recovery. I would verify the pinned implementation before depending on either description. Conditional object writes move arbitration into the storage service; they do not eliminate consistency assumptions. [Celld guarantees](https://celld.dev/docs/guarantees/)

A later celld adapter should keep one authoritative run history in a trusted cell, with model-authored executors outside that cell. Its SQLite database must not become a writable store exposed to generated code. Bucket credentials remain fleet-admin credentials. Cross-cell child budgets would need reserved allocations or an explicit coordination protocol. [Celld security](https://celld.dev/docs/security/)

For Temporal or Restate, keep the durable orchestrator stable and execute versioned semantic controllers as isolated steps. Replaying an old history through today’s controller code would undermine exact resume. Temporal’s deterministic replay model supports this separation; Restate explicitly acknowledges that an external side effect can repeat if failure precedes durable recording. [Temporal replay](https://docs.temporal.io/workflow-execution), [Restate’s effect semantics](https://restate.dev/blog/why-we-built-restate)

Every external adapter should declare its actual recovery contract:

- **Recorded pure computation:** recompute only under the declared deterministic inputs, or reuse the recorded result.
- **Deduplicated operation:** retry the same effect identity only within the provider’s documented deduplication contract.
- **Queryable operation:** reconcile through a durable operation identifier.
- **Ambiguous operation:** suspend with its reservation retained.

A timeout is not evidence that nothing happened. A deduplicated business operation also does not automatically imply deduplicated billing. Local durability should initially promise recovery from process failure on surviving durable storage; host or disk destruction needs a separately implemented backup or replication contract.

sPTC belongs after these contracts.

Borrow its distinction between speculative and ordinary execution, but place authoritative effect metadata in trusted adapter descriptors. A model-authored `pure=True` annotation cannot authorize speculation. Its reported speedups are modest, approximately 1–1.2×, and workload-dependent. [sPTC](https://alexzhang13.github.io/blog/2026/spec-ptc/)

For release 1, ordinary code-as-action execution is enough. A later speculative path must reserve and charge discarded work, isolate shadow state, and bind cached results to exact inputs, tool version, environment snapshot, and visibility scope. Repeated identical calls still need distinct invocation identities. Read-only remote calls can incur charges, consume quotas, or observe changing state; they are not automatically pure. Start with computations over immutable authorized artifacts.

Regression protection can preserve invariant 5, but it cannot promise that every adaptation improves unseen performance.

Self-Harness’s acceptance rule uses both development and held-out results. Its proposer may never see held-out traces, yet the next harness depends on their scores. That is feedback through selection. [Self-Harness validation algorithm](https://arxiv.org/html/2606.09498v3)

The same issue exists in the current implementation: [selection_cases()](/Users/nikhil/personal/hatch/strive/src/strive/tasks.py:64) includes held-out cases, and [review context construction](/Users/nikhil/personal/hatch/strive/src/strive/policies/continual_refine.py:768) exposes fork scores. The fix must change the evaluation contract, not merely hide case contents.

I recommend four distinct mechanisms.

First, retain mandatory integrity checks. Every activation must satisfy structural, authorization, budget, and continuation rules. These checks establish that an operation is permitted and recoverable. They do not decide whether a candidate is better.

Second, maintain an explicitly policy-visible development regression corpus. Include prior failures, retained successes, representative task families, and adversarial development cases. Version its selection rules and trusted scoring semantics. Retaining successes matters because a controller that looks only at its latest failures can forget previously working behavior.

Third, implement regression review as a policy over that evidence. The default continual policy can:

- Mine repeated failures from eligible traces.
- Propose a targeted change with a stated mechanism and affected components.
- Apply immediately at a legal boundary.
- Review subsequent development behavior and choose keep, revise, revert, or gather more evidence.
- Request `EvaluateFork` when an isolated comparison would be useful.

A policy may choose development checks before applying a particular proposal. The framework does not impose that as a universal activation gate. This preserves invariant 4 while making Self-Harness-style validation available.

For a stateful workload, useful comparisons start from matched environment snapshots and task streams. Record both initial state and subsequent interventions. For controller changes, compare complete adaptation trajectories under matched total budgets, including refinement expenditure. A single successful next task is weak evidence about a better improver.

The trusted evidence layer must also prevent selective reporting. Record the planned coverage, completed coverage, and reasons for exclusions. Infrastructure failures and unresolved effects cannot silently become behavioral failures or disappear into an improved denominator. Statistical uncertainty and repeated development-set reuse remain visible limitations.

Fourth, run blind audits in separate execution lineages. An audit copy necessarily sees task inputs while acting. Its resulting memories, skills, controller changes, prompts, messages, and snapshots therefore stay within the audit lineage. Exporting only “the useful memory” would still leak.

Isolation must cover more than prompt text:

- Separate artifact access, retrieval indexes, provider conversation state, caches, and credentials.
- Separate audit accounting so its expenditure cannot change the adaptive run’s remaining budget.
- No audit-derived acceptance flags, stop signals, lineage choices, or model-visible history-head changes.
- No reuse of an audit environment that leaves clues for subsequent development runs.

Test noninterference by varying protected cases and scores while holding permitted inputs and recorded model responses fixed. The adaptive run’s requests, commands, and visible state should remain unchanged. This verifies framework information flow; it does not prove the base model never encountered a benchmark during training.

The feedback boundary remains undecided. These are the concrete choices:

| Option | Allowed influence | Tradeoff |
|---|---|---|
| **A. Strict blind audit. Recommended.** | Only declared development evidence drives adaptation. Audit results remain embargoed until a predefined campaign and its candidate-selection procedure are frozen. | Preserves invariant 5. Audits assess generalization but cannot rescue the same campaign by choosing another candidate. |
| **B. Adaptive validation plus a fresh blind audit.** | Explicitly classify a validation pool as development data and authorize its feedback for selection. Preserve a separate untouched audit pool. | Enables Self-Harness-style regression selection. The validation pool is consumed by adaptation and cannot support untouched-held-out claims. Requires an explicit data-contract decision. |
| **C. Private deployment veto.** | A private evaluator may block deployment or choose among frozen candidates without revealing detailed scores to the model. | Useful operationally, but the selected deployed system depends on protected evidence. Requires an explicit exception to the strict invariant, with query accounting and a separate final audit. |

I recommend A for the release-1 scientific claim, together with strong development regression review. If iterative private validation is wanted, B is clearer than calling selection data “held-out.” C is defensible as a different contract, but a one-bit veto is still information.

Human review does not erase this distinction. If a human sees audit results and directs another refinement, that begins a new development campaign; the exposed evidence cannot remain an untouched audit for the resulting claim. HackProbe’s bounded-disclosure proposal makes this issue especially explicit. [HackProbe](https://arxiv.org/abs/2609.04665)

The changes to ASTRA_DESIGN.md should be expressed as these deltas.

| Delta | Change |
|---|---|
| **KEEP** | Small verified core, immutable bundles, exact composite revisions, immediate model-led activation, optional comparative evaluation. |
| **KEEP** | One authoritative run history, content-addressed artifacts, durable reservations, explicit uncertainty, and separation of configuration rollback from world compensation. |
| **KEEP** | Local-first execution, pure closed verification, pinned dependencies, sandbox enforcement, and budget-matched experiments. |
| **DISCARD** | The release-1 recommendation that the entire refinement controller remain pinned. Replace it with an editable semantic controller above a fixed execution contract. |
| **DISCARD** | Any implication that hiding held-out traces while exposing scores or acceptance decisions satisfies invariant 5. |
| **DISCARD** | Any implication that event-log rewind alone recovers external effects, live credentials, arbitrary interpreter state, or past expenditure. |
| **DISCARD** | Arbitrary CAS reads and whole-history access for model-authored policies, even when those APIs are mechanically read-only. |
| **ADD** | Exo’s identity/executor/core split; scoped turn handles; explicit binding, secret, snapshot, and lineage contracts. |
| **ADD** | Atomic controller handover, fixed continuation envelope, version-specific execution, and an operator recovery route independent of controller health. |
| **ADD** | Broker-owned canonical instrumentation, outcome classification, capability attenuation, and descendant budget allocation. |
| **ADD** | Development regression corpus, isolated audit lineages, and the unresolved A/B/C feedback decision. |
| **ADD** | September research on harness creation, retention under capability expansion, reference-trajectory diagnosis, and bounded feedback leakage. |
| **ADD** | Adapter contracts for reconciliation and billing, plus a later sPTC contract with trusted effect metadata and accounting for discarded speculation. |

The harness survey is useful as a coverage check across execution, tools, context, lifecycle, observability, verification, and governance. Those categories should remain visible in the design review; they do not require seven separate services. Its public PDF is evolving, so I would pin a revision before quoting corpus counts. [Harness engineering survey](https://picrew.github.io/LLM-Harness/main.pdf)

For the locked workload, I recommend a stateful order-fulfilment simulation with brokered tools.

The agent processes a continuing stream of orders using operations such as reading stock, reserving inventory, updating an order, and querying an operation’s status. State persists across turns, crashes, and agent revisions. A trusted service owns the database and scores actual state transitions. Development comparisons fork snapshots; continuing operation retains accumulated state.

This supplies real mutation, partial progress, effect reconciliation, limited observations, and adaptation over time without making an external production service part of the first recovery proof. It is a proposed concrete workload, not an additional locked human decision. The existing sum/max fixtures remain fast deterministic controls.

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| **1. Specify the contracts and workload** | Authority map, event vocabulary, effect state machine, controller interface, feedback contract, and workload scenarios. | Each invariant has a falsifiable acceptance condition. Resolve the feedback choice before implementing adaptive evaluation. |
| **2. Build durable execution** | Turn acceptance, framed history, CAS publication, verifier, reservations, effect dispatch, and reconciliation. | Fault injection around intent, authorization, dispatch, result recording, and continuation commit. Reject forged records and stale workers. |
| **3. Complete the stateful workload** | Persistent service, snapshot forks, brokered reads/writes, idempotency/status lookup, and explicit agent continuation. | Crash after a world mutation but before receipt persistence; recover without repeating it. Unqueryable model-call uncertainty suspends honestly. |
| **4. Enable acting adaptation** | Editable code, prompts, memory, skills, tool compositions, and bounded child turns. | A prompt-only change alters behavior; composite rollback restores configuration while world state and spending remain correct. |
| **5. Enable controller self-modification** | Versioned controller execution, atomic handover, compatible continuation, independent operator recovery. | A controller replaces itself and resumes across injected crashes. Attempts to suppress receipts, relabel evidence, escape the sandbox, or expand budgets fail. |
| **6. Evaluate and package** | Development regression policy, audit isolation, CLI, report, and installed package. | Compare frozen behavior, actor-only adaptation, and actor-plus-controller adaptation under matched total budgets. Report task outcomes, retention, actual spend, uncertainty, and recovery behavior. |

Strict typing, relevant tests, the installed-wheel CLI smoke, and fresh-interpreter verification remain release checks throughout. The controller experiment must measure whether it produces better subsequent changes; otherwise the release demonstrates editable controllers without demonstrating improved refinement.

The remaining human decisions can be reduced to five.

1. **Release-1 modification scope.** My recommendation is the bounded editable controller above. The narrower alternative is pass 1’s acting-code/prompt/memory scope. This is the principal scope decision.
2. **Feedback boundary.** Choose A, B, or C explicitly. My recommendation remains A; no choice is assumed here.
3. **Concrete workload and effect providers.** Approve the stateful simulation or identify the actual service and model provider. Require reconciliation for workload mutations; accept honest suspension where model-call recovery or billing is unknowable.
4. **Durability and threat scope.** My recommendation is one trusted host/operator, hostile generated code and inputs, accidental corruption, and process-crash recovery. Host-loss failover or malicious storage replacement would add replication or independently anchored history requirements.
5. **Experimental budget and release claim.** Set the real-model spending ceiling and predeclare outcomes for the three experimental arms. Passing mechanism tests supports a durability/security claim; measured improvement requires separate evidence.

Run-local learning, explicit immutable imports, and deferred distributed hosting are recommended defaults. The existing requirement for human go/no-go before teardown remains in force.



---

# strive vNext — Astra design PASS 3 (over-restriction / YAGNI audit)

**Author: GPT-6 Astra** (via `codex exec -m gpt-6-astra`, read-only). Scribed by the orchestrating Claude session. This pass CORRECTS earlier overreach: it separates the load-bearing hard core from premature restriction, resolves the "just log it" question, and relaxes two inherited invariants. Status: PROPOSAL — pending human decisions.

**Release 1 should have an open diagnostic log and a small, closed authority protocol. Keep a narrow pure verifier; drop the requirement that it understand every executor event, proposal, diagnostic, and workload detail.**

My earlier proposal overreached by making research conventions look like integrity requirements. Closed event names, strict comparability, structured memories, controller handover machinery, and universal recovery contracts do not all belong in the hard core. The essential boundary is who can authorize execution and certify what happened.

This is a static audit of both design passes, the handoff, and the cited implementation. No files changed and no tests ran. The recommendations below are engineering judgments, with high confidence in the authority and recovery distinctions and moderate confidence in implementation cost.

The external sources support a more permissive design than I previously proposed:

- Exo explicitly permits executor-defined, namespaced events. Its trusted infrastructure stores and orders them; executors interpret them. It also retains privileged-resource brokering and sandboxing. Open logging therefore does not inherently mean unrestricted authority. Its spec leaves model calls to executors, which strive should change when those executors are editable and expenditure must be enforced. [Exo specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md)
- Self-Harness keeps its evaluator fixed while modifying the surrounding harness. Its acceptance algorithm uses both held-in and held-out scores. My inference is that this provides selection feedback even though held-out traces are hidden. It supplies evidence for flexible harness modification, not for allowing the candidate to certify its own improvement. [Self-Harness, §§3.1–3.4](https://arxiv.org/html/2606.09498v3)
- DGM Appendix F documents an agent obtaining the maximum hallucination score by removing tool-use logging markers, despite the checking functions being hidden. This is direct evidence that a protected evaluator can still be gamed through editable instrumentation. [DGM Appendix F](https://arxiv.org/html/2505.22954v1#A6)

**The “just log it” decision is resolved in favor of openness everywhere except authority.**

Nothing about an event named `executor.order_completed` is dangerous by itself. It becomes dangerous when a scorer, budget ledger, permission check, or recovery routine treats it as fact.

For the proposed order-fulfilment simulation, these are the concrete failure modes:

| Failure mode | What breaks if executor logs become authoritative | Minimum prevention |
|---|---|---|
| Forged success | The executor logs “order shipped” while inventory and order state remain unchanged. | The trusted simulator/scorer determines completion from actual state and broker receipts. |
| Ungoverned spend | An editable executor calls a model directly, omits the call, or reports zero cost. | Keep credentials outside candidate execution; authorize and reserve every paid call through the broker. |
| Unrecoverable effects | Inventory changes, the process crashes before logging the result, and restart repeats the mutation or assumes it never happened. | Persist authorization before dispatch; use simulator operation IDs and status lookup; preserve uncertainty elsewhere. |
| Contamination | A protected score or audit-derived memory enters adaptive context under an innocuous custom event name. | Enforce the selected feedback contract when granting access to bytes, including derived artifacts. |
| Gaming | The executor suppresses failed attempts, changes its logging markers, or reports only successful orders. | Broker-owned interaction records and scorer-owned coverage and denominators. |

These are failures of authority, access, and execution ordering. **A closed vocabulary alone prevents none of them.** A fabricated but schema-valid receipt is still fabricated.

The current implementation closes considerably more than necessary. It rejects bodies outside `_BODY_UNION` and rejects unknown `observation_kind` values. Adding an innocent diagnostic therefore reaches verifier code today. [Body rejection](src/strive/substrate.py) is specifically at [substrate.py:1302](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:1302), and observation rejection at [substrate.py:2858](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:2858).

I recommend the following exact boundary. These are proposed protocol families, not a demand for seven separate services or elaborate class hierarchies.

| Record or field group | Authoritative content | Who establishes it |
|---|---|---|
| Common envelope | Run identity, sequence, record class, causal identity, producer identity, access scope, payload reference. | Supervisor; an executor-supplied `producer="broker"` has no standing. |
| Run binding | Trusted runtime/adapter/scorer versions, initial environment, budget limits, capabilities, editable scope, feedback contract, comparison contract, trust mode. | Trusted run setup, fixed for the run or changed through an explicitly supported trusted transition. |
| Effect authorization | Effect ID, exact request reference, adapter and operation, target environment, permitted scope, reservation, recovery mode. | Broker after checking the request. |
| Effect observation and settlement | Dispatch/return/uncertainty status, response or receipt reference, observed environment version, usage amount and whether measured, reserved, or unknown. | Broker and trusted adapters; tool return is distinct from task success. |
| Measurement | Subject revision, workload/window identity, scorer version, receipt/state references, admitted and completed coverage, exclusions, metric identity and value. | Trusted scorer using broker/environment evidence. |
| Revision activation | Exact previous and next bundle references, expected active revision, activation boundary. | Supervisor after validating the requested change. |
| Continuation commit | Exact private-state bytes, executing bundle version, consumed-result cursor, environment reference. | Supervisor records what the executor produced; it does not certify the private state's reasoning. |

Evidence eligibility need not require another event family. For release 1, static run/lineage scopes plus the bound feedback contract can determine access. The broker owns those labels and access decisions.

Everything else may be freely logged inside an `Annotation` envelope or an `annotations` subtree:

- New event names, arbitrary bounded JSON, debugging text, timing breakdowns, hypotheses, proposal rationales, memories, compaction records, component names, and claimed scores.
- Executors may interpret these and use authorized annotations to decide their next action.
- They cannot override authoritative fields, release reservations, certify success, authorize retries, grant artifact access, or move the active revision.
- Unknown annotation schemas remain readable as opaque data. They do not invalidate an otherwise valid run.
- Annotation size and storage quotas still apply. Logging must not bypass resource limits.

For example, `executor.order_completed: {order_id: 42, success: true}` is permitted. It contributes nothing to fulfilment scoring. A broker receipt establishing a state transition for order 42 can contribute.

A new privileged operation requires a trusted adapter with explicit authorization and recovery behavior. **It should usually reuse the generic effect records without changing the core verifier.** A new scorer can produce the existing measurement envelope under a newly pinned scorer definition. Changing the meaning of an authority primitive requires a protocol/verifier change; adding a diagnostic field does not.

**Keep purity, reduce what verification promises.**

The current code already separates structural verification from some workload semantics. The pure verifier checks projection coverage, identifiers, and score shape; it explicitly leaves descriptor-exact recomputation to the kernel. The kernel derives projections through the trusted operation descriptor and checks existing projections on recovery. [Structural checks](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:2020), [projection derivation and recovery](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:1308).

Release 1 should formalize that division:

1. A small pure transition function checks authority records: references, IDs, authorized dispatch, reservations, settlement, revision transitions, and consumed-result cursors.
2. The trusted simulator and scorer establish workload facts. The verifier checks their recorded provenance and relationships; it does not independently reconstruct arbitrary external reality.
3. Verification performs no dispatch, imports no candidate code, and writes nothing.

Incremental checking is compatible with purity. Validate the next authoritative transition against the already verified state; replay the authority stream on restart and when explicitly auditing. Do not build persistent verification-cache infrastructure yet. If retaining full replay temporarily is simpler, that is a performance choice, not an integrity requirement.

Today `_emit` folds the candidate stream and then verifies the persisted stream again. That duplication is removable. [Append path](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:813).

Retain preflight, but narrow its promise to **“accepted authority transitions preserve protocol consistency.”** It must not mean “nothing bad can be recorded.” If a provider reports expenditure above its reservation, preserve that receipt, record the overrun, and stop further dispatch. A trustworthy journal must represent violations and uncertainty. Suppressing an inconvenient observation to preserve a green `valid` flag would undermine integrity.

The following table audits the major mechanisms in [pass 1](/Users/nikhil/personal/hatch/strive/docs/ASTRA_DESIGN.md:78), [pass 2](/Users/nikhil/personal/hatch/strive/docs/ASTRA_DESIGN.md:226), and the [inherited invariants](/Users/nikhil/personal/hatch/strive/ASTRA_HANDOFF.md:54). KEEP applies to the limited form stated, not every implementation detail previously proposed.

| Mechanism | Decision | Release-1 justification |
|---|---|---|
| Closed record vocabulary | **LOOSEN** | Close only the authority protocol; the current blanket rejection of unknown observations creates unnecessary release coupling for diagnostics. |
| Pure verifier and authority preflight | **KEEP** | A small side-effect-free transition checker prevents inconsistent authorization, settlement, activation, and recovery state. |
| Full semantic verification of every artifact and observation | **DEFER** | Reimplementing every workload interpretation inside the verifier duplicates trusted adapter/scorer logic before a second real workload exists. |
| Whole-history verification on every append | **LOOSEN** | Check transitions against verified state and retain full replay for recovery/audit, removing repeated work without weakening authority checks. |
| Content-addressed store | **KEEP** | Existing hash-checked immutable storage identifies the exact code, requests, results, and continuation bytes needed for recovery. [Implementation](/Users/nikhil/personal/hatch/strive/src/strive/cas.py:91) |
| Framed journal, durable publication, head checks | **KEEP** | These distinguish committed records from incomplete writes and prevent acting on an ambiguous local history. [Implementation](/Users/nikhil/personal/hatch/strive/src/strive/framing.py:228) |
| Signed heads, external anchoring, malicious-store protection | **DEFER** | The proposed trusted-host scope does not justify an independent transparency system; the existing hash chain does not establish that protection. [Existing limitation](/Users/nikhil/personal/hatch/strive/src/strive/framing.py:24) |
| Rebuildable discovery indexes | **KEEP** | A stale convenience index must not invalidate intact authoritative history, which the current fold already recognizes. [Implementation](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:1334) |
| Typed command variants | **KEEP** | Type the few privileged actions so malformed requests cannot accidentally change authority; leave diagnostic payloads open. |
| Canonical command JSON plus normalized shadow fields | **LOOSEN** | Store one canonical typed request rather than maintaining duplicate representations and coherence rules. [Current duplication](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:1793) |
| Specialized model/fork/operation lifecycle grammars | **LOOSEN** | Use one effect lifecycle with adapter-specific payloads instead of requiring core changes for each execution category. |
| Mandatory proposal rationales, citations, edit limits, and review shapes | **CONFIG** | These can improve a refinement policy, but they are not prerequisites for safe activation of authorized code. [Current command constraints](/Users/nikhil/personal/hatch/strive/src/strive/policy.py:97) |
| Authoritative `ChangeConfirmed` and proposal bookkeeping | **LOOSEN** | “The controller likes this revision” can be an annotation; actual activation and any measured improvement remain independently recorded. [Current machinery](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:1610) |
| Exact composite revisions and atomic activation | **KEEP** | Recording one complete before/after bundle prevents mixed code, prompts, and memory after a crash. |
| Exact configuration restoration | **KEEP** | Restoring an identified prior bundle prevents ambiguous rollback, while retaining current expenditure and world state. |
| General inverse-edit, merge, and compensation machinery | **DEFER** | Release 1 needs explicit bundle restoration and workload operations, not a generic algebra for undoing arbitrary changes. |
| Immutable bundles and dependency locks | **KEEP** | A fixed runtime image/lock plus exact bundle bytes prevents resume from silently executing different dependencies. |
| Arbitrary dependency installation and complete packaging framework | **DEFER** | A supplied dependency set supports the first workload without adding package resolution and installation to the research loop. |
| Model-weight modification | **DEFER** | It adds a separate experimental and execution problem unrelated to proving stateful harness adaptation. |
| Pinning every research choice for an entire run | **LOOSEN** | Pin the trusted contract and each invocation's exact inputs; allowed actor/controller revisions should not require starting over. |
| Generic operation-plan framework | **LOOSEN** | Implement one simulator adapter and the fixtures behind a small step interface, avoiding a universal workflow language. |
| `solve(str)->int` as the kernel's execution model | **LOOSEN** | Its current hard-coding prevents the locked stateful workload; keep it only in the fixture adapter. [Current executor](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:1564) |
| Capability broker and protected credentials | **KEEP** | Otherwise editable code can bypass permission checks, spending limits, and canonical tool evidence. |
| All model calls through the broker | **KEEP** | Acting, refinement, and generated wrappers must share the same enforced budget and receipt path. [Existing refinement path](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:752) |
| Durable reservations and measured/reserved/unknown usage | **KEEP** | A crash or missing provider usage must not reset expenditure or silently become zero cost. [Current handling](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:824) |
| Per-effect reconciliation contracts | **CONFIG** | Require recovery for simulator mutations; allow honest suspension for other effects instead of building recovery adapters for hypothetical providers. |
| Universal exact resume across external boundaries | **LOOSEN** | Promise exact recorded state and safe resumption where supported, removing the impossible implication that a missing external response can always be reconstructed. |
| Result-driven continuation and consumed-result cursors | **KEEP** | These prevent completed work from being applied twice to the resumed execution state. [Checkpoint checks](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:1555) |
| No records after a terminal command | **LOOSEN** | Keep task completion stable but permit explicit late accounting/reconciliation records rather than losing newly available facts. [Current blanket rule](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:2233) |
| Snapshot-to-log recovery | **LOOSEN** | Support explicit simulator snapshots and continuation references; arbitrary process, VM, credential, and external-world rewind is unnecessary. |
| Secure sandbox floor | **KEEP** | Host confinement, restricted external access, and bounded resources keep generated code away from credentials, evidence, and authority storage. [Enforcement boundary](/Users/nikhil/personal/hatch/strive/src/strive/sandboxes.py:299) |
| Fresh interpreter per case as a security invariant | **CONFIG** | State lifetime is a workload/isolation choice, although the current secure capability tuple treats freshness as mandatory. [Current tuple](/Users/nikhil/personal/hatch/strive/src/strive/sandboxes.py:75) |
| Eligibility before context construction | **KEEP** | Once forbidden bytes reach editable code, filtering its final prompt cannot reliably recover the declared feedback boundary. |
| General `RunView` history and CAS access | **LOOSEN** | Replace the broad interface with scoped readable artifacts, avoiding a general information-flow engine while closing a real exposure. [Current interface](/Users/nikhil/personal/hatch/strive/src/strive/policy.py:47) |
| Held-out A/B/C feedback contract | **CONFIG** | The run must declare permitted influence, but strict blindness is not a universal requirement for trustworthy operational records. |
| Comparability strictness | **CONFIG** | Matching snapshots and streams supports controlled comparisons; observational evidence may still inform adaptation without being labeled causal improvement. |
| Ban on infrastructure feedback steering the model | **LOOSEN** | Authorized timeout and tool-availability evidence can improve recovery behavior; the requirement should be honest classification, not exclusion from learning. |
| Evidence coverage and exclusion recording | **KEEP** | Admitted, completed, failed, and unresolved work must remain visible so a candidate cannot improve its score by hiding the denominator. [Existing coverage](/Users/nikhil/personal/hatch/strive/src/strive/operate.py:166) |
| Structured memory/skill ontology with mandatory supersession | **LOOSEN** | Versioned files and authorized inputs suffice initially; a mandatory knowledge-management schema restricts experimentation without certifying truth. |
| Component-use attribution | **LOOSEN** | Record exact supplied code/context and broker calls; proving which memory “caused” behavior is beyond release-1 integrity. |
| Editable refinement controller | **CONFIG** | Editability is an experimental scope choice; it must not become either a security taboo or a mandatory release milestone. |
| Atomic controller handover | **KEEP** | When controller editing is enabled, switch versions and initial state together at a quiescent boundary to prevent mixed execution. |
| Arbitrary controller-state migration | **DEFER** | A fixed continuation envelope and explicit initial private state remove the need for migration/rollback compatibility machinery. |
| Independent operator recovery route | **KEEP** | A broken controller must not be required to execute its own recovery. [Existing operator path](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:920) |
| One writer and serial execution | **KEEP** | A local lease and one outstanding effect keep release-1 ordering tractable and prevent duplicate dispatch. [Lease](/Users/nikhil/personal/hatch/strive/src/strive/substrate.py:760) |
| Turn handles and ingress deduplication | **LOOSEN** | Stable request IDs and a scoped local API suffice without building a full agent/conversation/session product model. |
| Subagents, descendant budgets, concurrent scheduling, distributed fencing | **DEFER** | The locked workload does not require these, and they add independent ownership, cancellation, and accounting problems. |
| Optional comparative evaluation and snapshot forks | **CONFIG** | Policies may request them, with new execution identities and charged work; they must not become a universal activation gate. |
| Cross-run learning imports | **LOOSEN** | Explicit bundle imports with scope/provenance suffice; defer global mutable memory and a general lineage-management system. |
| Noninterference tests | **CONFIG** | Test the prohibited flows of the selected feedback contract; do not implement every A/B/C isolation arrangement in advance. |
| Speculative execution and reusable effect caches | **DEFER** | They introduce invalidation, duplicate-effect, and discarded-work accounting before throughput is established as a problem. |
| Temporal, Restate, Celld, replication, host-loss failover | **DEFER** | One surviving host and disk are enough for the initial durability claim. |
| Optimizer integrations, population selection, universal promotion gates | **DEFER** | They are research policies, and universal promotion would contradict strive's immediate-adaptation mission. |
| Prompt-only behavior check, integrity checks, typing, package/replay checks | **KEEP** | These establish that exposed controls affect execution and that the shipped runner preserves its narrow guarantees. |
| Three experimental arms and mandatory demonstrated improvement | **CONFIG** | The experiment must support the chosen claim, but controller improvement should not block a release that demonstrates trustworthy actor adaptation. |
| Research mode | **KEEP** | A fixed untrusted designation permits stubbed contracts and experimental measurement without silently extending trusted claims. |

Two inherited restrictions deserve particular correction.

First, **“only comparable evidence may steer adaptation” is too strong**. A new kind of failure can be useful before there is a matched baseline. The policy should be allowed to learn from it. Comparison controls constrain what the report may claim about improvement. The current policy's valid-window filtering is a reasonable default policy, not a universal execution law. [Current filtering](/Users/nikhil/personal/hatch/strive/src/strive/policies/continual_refine.py:586).

Second, **“infrastructure failures can never steer the model” obstructs useful harness research**. A controller should be able to learn to reduce output after an output-limit failure, or change scheduling after repeated tool unavailability. Preserve fault origin and distinguish these observations from evidence that the actor solved an order incorrectly. Whether particular operational metadata is visible remains part of the feedback contract.

The minimal viable integrity core is five guarantees:

1. **Confinement and fixed authority.** Generated code runs inside an enforced sandbox. It cannot rewrite the real authorizer, verifier, scorer, access policy, or accounting machinery.
2. **Independent facts.** The broker records actual interactions and usage; the simulator/scorer records outcomes and coverage. Candidate annotations remain claims. Access follows the declared feedback contract.
3. **Durable execution identity.** Before dispatch, persist the exact request, effect identity, authority, and reservation. Preserve results, bundle bytes, atomic activation, and consumed-result cursors on surviving local storage.
4. **Honest recovery.** Recover simulator mutations through durable operation IDs; reuse recorded results; retain unknown expenditure and suspend ambiguous unsupported effects. Revision rollback never rewinds spending or the world.
5. **A small checked protocol.** Pure validation and replay establish consistent authorization, accounting, activation, and continuation, while allowing open annotations and faithfully recording bad outcomes.

For the simulator, the decisive recovery case is concrete: `reserve_inventory(effect_id, order_id, quantity)` durably stores both its mutation and operation result together. If strive crashes before recording the receipt, it queries that operation ID and obtains the original result. A fresh retry cannot reserve again under the same identity. This transactional simulator contract is my proposed implementation, not a property demonstrated by the papers.

For a model provider without an adequate lookup/deduplication contract, the corresponding case suspends and retains the reservation. The current implementation already takes this conservative route for dispatched operations and model calls without durable results. [Operation recovery](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:1335), [model recovery](/Users/nikhil/personal/hatch/strive/src/strive/kernel.py:682).

Research mode should use this same outer runner. A run-bound flag stamps results `untrusted` and permits stub adapters, experimental event semantics, and an editable measurement program inside the sandbox. Simulated receipts must say they are simulated. Self-modifying measurement is then the object being studied; it does not replace the outer accounting or authorization machinery.

The candidate cannot turn the flag off, manufacture real receipts, or export an experimental score as a trusted one. A new trusted evaluation can assess an artifact produced there, with its provenance declared. Ordinary custom annotations should work in trusted mode and should never require this flag.

Hardening should follow demonstrated needs:

| Trigger | What becomes necessary |
|---|---|
| A diagnostic starts determining success, spend, permission, or eligibility | Give it a trusted producer and defined authority semantics before relying on it. |
| A second workload introduces genuinely different effect semantics | Extend adapter contracts and, only where necessary, the authority protocol. |
| A deployment requires uninterrupted recovery of an external mutation | Require that provider's actual reconciliation contract before claiming automatic recovery. |
| Concurrent children or remote workers become necessary | Add budget allocation, cancellation, ownership/fencing, and stale-result handling. |
| The chosen experiment claims blind evaluation | Enforce and test every actual feedback route, including imports, caches, provider state, and control signals. |
| Controller replacement must preserve incompatible private state | Add explicit migration contracts and their recovery checks. |
| Cross-run knowledge transfer becomes a research feature | Strengthen import provenance and scope propagation beyond simple explicit bundle imports. |
| Host-loss or hostile-storage protection becomes a requirement | Add replication/backups or independently authenticated history, respectively. |

There is no automatic graduation toward a universally closed event ontology. That is not the destination.

Where I disagree with the human's instinct is concentrated in four places.

**Broker-owned measurement is worth keeping immediately.** Logging freedom cannot include the freedom to decide which tool calls count as having happened. The DGM example makes this an observed failure mode, not speculative security work. Protecting only the scoring function is insufficient.

**Durable intent and conservative accounting are also immediate requirements.** The first crash between simulator mutation and receipt persistence is enough to require them. A local simulation makes that contract cheaper to implement and examine; it does not eliminate the problem.

**Artifact immutability is cheap here.** The repository already has atomic, hash-checked object publication. Replacing it with mutable “latest” files would sacrifice exact recovery identity for little benefit. Hashes establish identity, not truth.

**A small preflight checker helps velocity.** It rejects a malformed privileged transition before it damages resumability. The excessive restriction was teaching that checker every research concept. It should accept an executor's new explanation format without knowing what the explanation means.

Conversely, I disagree with my own pass-2 requirement that release 1 demonstrate controller self-modification through a dedicated milestone and three-arm experiment. That is an additional research objective. The first release should not wait for it.

The five open decisions should now read as follows:

1. **Modification scope.** Recommend acting code, prompts, and memory for the first release experiment, with a pinned controller. Controller editing remains configurable through the same sandboxed step and atomic revision interface; dedicated migration machinery and proof of improved refinement are deferred. This reverses pass 2's release requirement, not its conclusion that controller code can safely be editable.

2. **Feedback boundary.** A/B/C remains explicitly undecided. I still recommend A for an untouched-audit scientific claim, but the core should enforce whichever contract is selected. Existing `selection_cases()` includes every non-audit split, and review exposes fork scores; that path cannot be described as strictly excluding held-out influence without changing its contract. [Selection](/Users/nikhil/personal/hatch/strive/src/strive/tasks.py:64), [review context](/Users/nikhil/personal/hatch/strive/src/strive/policies/continual_refine.py:764).

3. **Concrete workload and providers.** Recommend the order-fulfilment simulator plus sum/max fixtures. Require simulator mutation reconciliation and permit honest suspension for the selected model provider. Do not require a general provider ecosystem.

4. **Durability and threat scope.** Recommend one trusted host/operator, hostile generated code and inputs, surviving durable storage, and process-crash recovery. This supports a useful release without distributed ownership or malicious-storage guarantees.

5. **Budget and release claim.** Set a real spending ceiling and compare fixed behavior with actor adaptation under matched declared budgets. Report outcomes, regressions, coverage, uncertainty, and expenditure. Controller improvement becomes a separate claim when that experiment is actually undertaken.

**Yes, add an explicit sixth decision, phrased as “Which guarantees define a trusted run, and which claims does each mode permit?”** “How hard is the hard core?” otherwise invites gradual exceptions to confinement or factual accounting.

My answer to that sixth decision is the five guarantees above. Feedback, editability, comparability, and recovery availability are configurable. Open annotations are normal. Experimental measurement is allowed under an untrusted designation. The real authorizer, evidence producer, and recovery record remain outside candidate control.


---

# PASS 4 (research ergonomics) — GPT‑6 Astra

*Prompted by the question: how do people actually build, use, and present these
harnesses (blogs, arXiv, leaderboards), and how do we make strive easy to
research on, iterate on, configure, experiment on, log, and monitor? Astra was
run read-only via `codex exec -m gpt-6-astra`; no files were changed and no tests
were run during this pass.*

**Strive should make an experiment easy to launch, inspect, fork, compare, and reproduce from its own durable record.** The journal and content-addressed artifacts should produce both the research report and the observability view. That is strive’s advantage: execution, accounting, and evidence already share an authoritative history.

I recommend trusted execution by default, actor-only adaptation for the first reference experiment, feedback contract B for everyday development, and A for the release’s scientific comparison. Use OpenTelemetry and Langfuse for inspection. Keep experiment definitions and results portable.

This proposal builds on pass 3’s corrections to passes 1–2. Confidence is high in the documented mechanisms and authority boundaries, moderate in integration effort and ecosystem convergence. No files changed and no tests ran.

1. People build useful harnesses around a repeatable loop: configure, run, inspect trajectories, turn failures into examples, change one component, compare again.

| Practice | What to borrow |
|---|---|
| Programs and configuration evolve together. | DSPy separates programs, optimizer settings, models, and evaluation data. GEPA exposes candidate components and an evaluator returning scores plus diagnostic information. Strive should offer similarly small interfaces for replacing a policy or component. [DSPy MIPROv2](https://dspy.ai/api/optimizers/MIPROv2/), [GEPA API](https://gepa-ai.github.io/gepa/api/optimize_anything/optimize_anything/) |
| Logs become the working research interface. | Inspect provides evaluation logs, an interactive viewer, dataframe access, and configuration export. Exo makes ordered event access and forks explicit. Researchers should be able to move directly from an aggregate regression to the responsible invocation. [Inspect logs](https://inspect.aisi.org.uk/eval-logs.html), [Exo specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md) |
| Production examples feed offline experiments. | Langfuse connects live traces, datasets, experiments, and human or automated evaluation. Anthropic describes combining regression suites, transcript review, production monitoring, and human calibration of judges. [Langfuse evaluation](https://langfuse.com/docs/evaluation/overview), [Anthropic’s evaluation practice](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) |
| Credible comparisons account for the surrounding harness and expenditure. | HAL evaluated agents across nine benchmarks, tracked costs, inspected trajectories, and encrypted uploaded traces to reduce contamination risk. Its leaderboard presents performance alongside cost. [HAL paper](https://arxiv.org/abs/2510.11977), [harness](https://github.com/princeton-pli/hal-harness), [leaderboard](https://hal.cs.princeton.edu/) |

For strive, a bloggable result should contain a concrete failure, the exact change, a before/after trajectory, and the aggregate evidence showing whether that example is representative. A paper-ready result additionally needs:

- A frozen experiment specification, resolved manifests, executable artifacts, dataset splits, scorer, and reproduction commands.
- All declared arms and repetitions, including failed, stopped, and indeterminate runs.
- Performance against cumulative total expenditure, with adaptation, evaluation, and retry costs included.
- Coverage, retained competence, uncertainty intervals, and the candidate-selection procedure.
- A trace archive with event references behind reported measurements. Protected audit content needs separate access and publication treatment.
- The limits of the claim: simulator versus live environment, fixed versus changing model, and which evidence influenced adaptation.

A leaderboard entry should identify an **agent bundle + harness + model + evaluation contract + budget**, rather than treating the model name as the whole system.

Two baseline qualifications matter. HAL’s harness is now archived, so it is methodological precedent rather than an active integration target. OTel’s v1.41 GenAI conventions are marked Development; they are a sensible pinned export contract, not a settled universal schema. [HAL status](https://github.com/princeton-pli/hal-harness), [OTel v1.41 agent conventions](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-agent-spans.md)

2. Configurability should mean changing a small manifest and getting an exact, readable account of what that change affects.

Use TOML, matching strive’s existing policy configuration. Support a typed Python builder that produces the same data for programmatic experiments. Avoid a configuration language with executable expressions or elaborate inheritance.

Maintain two artifacts:

- The **authored manifest** contains understandable choices, local paths, and experimental knobs.
- The **resolved manifest** expands defaults, captures referenced bytes, resolves dependencies, and records exact identities before execution.

A manifest digest identifies a configuration. A separate run ID identifies an execution. Repeating an identical configuration must create an independent run.

Proposed syntax follows. Digest placeholders are illustrative.

```toml
schema = "strive.run/1"

[run]
mode = "trusted"
editable = ["actor.code", "actor.prompts", "actor.memory"]
capabilities = "sha256:<capability-profile>"

[pins]
runtime = "sha256:<runtime-and-dependency-closure>"
verifier = "sha256:<verifier>"
adapters = "sha256:<adapter-descriptors-and-code>"
scorer = "sha256:<scorer-and-metric-definitions>"
initial_bundle = "sha256:<code-prompts-memory-and-entrypoints>"

[policy]
package = "./policies/continual"
entrypoint = "policy:step"
refine_every_orders = 20
optional_dev_forks = true

[workload]
implementation = "sha256:<order-simulator>"
initial_snapshot = "sha256:<environment-state>"
task_stream = "sha256:<ordered-workload>"
dev_corpus = "sha256:<regression-corpus>"
validation_corpus = "sha256:<adaptive-validation-corpus>"

[feedback]
contract = "B"
operational_failures_visible = true
audit_plan = "sha256:<protected-audit-plan>"
audit_release = "after-campaign-freeze"

[comparison]
strictness = "matched"
plan = "sha256:<pairing-metrics-exclusions-and-selection-plan>"
allowed_differences = ["policy.package", "run.editable"]

[models.actor]
provider = "<provider>"
model = "<exact-available-model-version>"
request_options = "sha256:<complete-provider-request-settings>"
max_output_tokens = 4096

[models.refiner]
provider = "<provider>"
model = "<exact-available-model-version>"
request_options = "sha256:<complete-provider-request-settings>"
max_output_tokens = 8192

[seeds]
workload = 17
policy = 17
model_request = 17

[budget]
usd = 20.00
tokens = 500000
model_calls = 300
wall_seconds = 3600
price_schedule = "sha256:<dated-price-schedule>"
includes = ["acting", "refinement", "dev_evaluation", "retries"]

[recovery."simulator.mutate"]
strategy = "reconcile"
require_operation_lookup = true

[recovery."model.generate"]
strategy = "suspend_if_ambiguous"

[telemetry]
semconv = "1.41.0"
profile = "langfuse"
content_export = "authorized-development"
sampling = "all"
```

The resolved form must also capture platform/runtime details, source changes, dependency artifacts, tool schemas, timeout and retry settings, initial controller state, imported memories, and the requested versus observed model identity. Provider-specific sampling and reasoning settings belong in the pinned request settings. Record unsupported seeds explicitly.

Credentials remain opaque bindings outside the artifact archive. Capture the effective non-secret configuration; never let an environment variable silently change a scientific setting on resume.

Three proposed commands should cover ordinary work:

```text
strive run orders.toml --id actor-17
strive resume actor-17
strive compare fixed-17 actor-17 --spec paired.toml
```

Launch resolves and displays the configuration before dispatch. Resume uses the recorded manifest and preserves expenditure. Compare reads history and reports declared differences, matching failures, outcomes, and costs.

Add a thin serial `strive experiment study.toml` wrapper for arm and seed expansion. It should call the same runner, maintain a stable run list, and generate the same comparison report. It does not need a scheduler service.

Defaults should be explicit in the resolved output. Unknown configuration keys should fail with useful errors. Arbitrary diagnostic data belongs under annotations, where new keys are welcome.

**Pin the rules governing change and record every actual revision.** Pinning must not prevent the actor from adapting within its declared scope. Changing the feedback contract, authority, experimental model assignment, or spending ceiling creates a new run or explicitly declared follow-up experiment.

Recovery configuration selects among capabilities the trusted adapter actually implements. Writing `strategy = "reconcile"` cannot manufacture provider deduplication or billing guarantees.

3. Experiments should be ordinary runs with declared relationships, budgets, and differences.

Represent a study as a base manifest, explicit arm overrides, repetitions, pairing rules, and an analysis plan. Generate and retain a complete resolved manifest for every run. Show the configuration diff before spending anything.

The first study should compare **fixed behavior versus actor adaptation**. Useful subsequent ablations include prompt-only edits, code-only edits, memory disabled, different refinement intervals, and optional development forks disabled. Controller adaptation is a separate arm when someone is studying that question.

Turning off an editable surface is not always an ablation of its use. For example, freezing memory still permits reading existing memory. A “no memory” arm must change initialization and retrieval as well. Record the exact intervention.

For stateful comparisons:

- Start paired runs from the same simulator snapshot and exogenous order stream.
- Use independent mutable environments and controller state.
- Pair independent repetitions by workload seed. Track policy randomness separately so different call counts do not accidentally change the workload.
- Compare complete trajectories when studying adaptation. Forking late in a successful run answers a conditional question about that state, not whether the entire adaptation method is better.

A research fork needs the parent run and cursor, active bundle, continuation, environment snapshot, import scope, and a new execution identity. Release 1 should permit execution forks only at supported snapshot boundaries without ambiguous effects. Historical inspection can reach other cursors without pretending execution can safely restart there.

Shared history must not create free training. Reports should distinguish inherited preparation cost, new branch expenditure, and total campaign cost. Forks reserve from the declared experimental allowance; they never replenish the parent’s budget.

**Match available resources and workload, then report actual use.** Give arms the same spending ceiling, task horizon, and relevant time limits. Include refinement, development evaluation, failed proposals, and retries. An arm that finishes cheaply need not waste its remaining budget to achieve identical expenditure. Plot outcomes over cumulative cost and over workload progress.

Use whole trajectories or independent environment repetitions as the statistical unit where outcomes share state. Do not calculate narrow confidence intervals by pretending every correlated order is an independent experiment.

The development regression corpus should contain prior failures, retained successes, representative families, and adversarial development examples. Each addition records its source event and authorization scope. Corpus updates create new versions; an experiment pins a version or a declared update rule. Never silently change the corpus halfway through a paired comparison.

Policies may use this corpus to propose, keep, revise, or revert changes. The runner continues to permit immediate activation after integrity checks. Regression evaluation remains a policy choice.

Blind audit happens in a separate lineage after the campaign and candidate-selection procedure are frozen. Audit-derived memories, traces, scores, dashboard views, stop signals, and budget effects must not reach the adaptive lineage. Human inspection counts as exposure too. Once audit results guide another change, subsequent claims need a fresh audit.

Reproducibility needs three precise promises:

| Operation | Promise |
|---|---|
| Replay | Reconstruct recorded state, accounting, and results from verified history without external dispatch. |
| Resume | Continue using pinned artifacts and recorded results, reconciling unresolved effects where supported and suspending elsewhere. |
| Reproduce | Start a new execution from the resolved specification and retained dependencies, then measure whether results agree. |

A manifest alone cannot guarantee identical fresh answers from a hosted model. Retain actual requests, responses, snapshots, random state, and relevant external observations for exact historical reconstruction. For deterministic local components, retain the executable environment and all inputs needed for repeat execution.

Replay should fail clearly on missing artifacts. Fresh reproduction should report unavailable model versions and environmental differences. Neither should silently substitute “latest.” Replaying recorded model responses after changing their input is invalid.

4. Observability should be a disposable projection of the durable journal.

Build one read-only projector that follows committed events, resolves authorized artifacts, and emits OTLP. Recovery, scoring, and accounting must never depend on successful telemetry delivery. An exporter outage should produce a visible backlog that can be rebuilt from history.

Use this mapping. These are proposed semantic mappings, not claims that every event family already exists.

| Journal evidence | Telemetry representation |
|---|---|
| Start and finish of a bounded adaptation cycle | `invoke_workflow` span where the cycle genuinely coordinates agent operations |
| Actor or refiner invocation and its recorded completion | `invoke_agent` span with role and executing bundle revision |
| Authorized model request, dispatch, response, and usage | Model span using the appropriate GenAI operation, requested/returned model identity, token usage, and observed latency |
| Brokered tool invocation and receipt | `execute_tool` span with operation identity, request/result references, and classified outcome |
| Revision activation, restoration, and continuation | Span events or correlated logs identifying exact before/after artifacts |
| Trusted measurements and accounting | Measurement records, numeric metrics, and correlated event references |
| Candidate or human annotations | Namespaced diagnostic logs with producer and subject references |

Use standard GenAI attributes where their meaning fits. Keep strive-specific evidence under `strive.*`. The relevant standard instruments include `gen_ai.client.operation.duration` and `gen_ai.client.token.usage`; missing usage must not become zero. [OTel model spans](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-spans.md), [OTel metrics](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-metrics.md)

A long-running run should group many bounded traces. Do not leave one root span open for days. Use run and campaign identifiers for grouping, parent-child relationships within cycles, and links across forks and recovery episodes. Derive stable telemetry identities from execution identities, never solely from identical request content.

Record broker-observed timing. Journal order establishes causality; export time does not establish execution latency. Represent suspension and later reconciliation explicitly without fabricating a completed model response.

An exporter cursor and stable identifiers make retries manageable, but OTLP delivery does not supply universal exactly-once ingestion. Historical re-export must not increment live spending counters again. Financial and scientific totals always come from a fold of the authoritative ledger.

**Ship Langfuse as the reference viewer, with compatibility profiles for LangSmith and Phoenix.** “Out of the box” should mean selecting a profile and endpoint with no changes to policy code:

- Langfuse needs its supported attribute mapping and propagation of grouping metadata to child spans.
- LangSmith has its own documented mappings for run types, messages, and metadata.
- Phoenix can ingest OTel spans, but richer presentation uses OpenInference attributes; provide translation at the export boundary.

These differences justify small adapters around one canonical projection. They do not justify three instrumentation implementations. [Langfuse OTel integration](https://langfuse.com/integrations/native/opentelemetry), [LangSmith OTel integration](https://docs.langchain.com/langsmith/trace-with-opentelemetry), [Phoenix translation](https://arize.com/docs/phoenix/tracing/concepts-tracing/translating-conventions)

Assign campaign, arm, role, phase, model, revision, and evidence scope when execution is authorized. Propagate relevant dimensions to child spans. Attribute cost to the leaf effects once, then roll it up. Keep high-cardinality event IDs and artifact hashes out of general metric labels.

The three-layer evaluation model is useful organization, not an industry standard or a hierarchy of truth:

| Layer | Strive implementation |
|---|---|
| Unit and deterministic checks | Protocol/recovery checks plus trusted simulator outcome and regression scoring |
| LLM-as-judge and human review | Optional rubric-based assessments over authorized traces, with pinned judge settings, rubric, disagreement, and expenditure |
| Live sampling | Monitor continuing operation, inspect representative and problematic trajectories, and promote authorized examples into development corpora |

Judge assessments should be visibly distinct from simulator facts. A trusted record that a judge awarded 0.9 does not establish that the underlying task succeeded. Human calibration remains necessary for subjective grading. [Anthropic’s grader distinctions](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

`strive status RUN --follow` should answer the questions a researcher asks while waiting:

- Which revision is running, what is it doing, and why is it blocked?
- How much expenditure is settled, estimated, reserved, or unresolved? What remains dispatchable?
- How much planned work was admitted, completed, failed, skipped, or left uncertain?
- What is cumulative performance, which retained capabilities regressed, and how much statistical evidence exists?
- Which exact prompt, tool definitions, retrieved content, memory, and attachments reached this invocation?
- Is telemetry caught up with the journal?

For “what the model consumed,” preserve the actual adapter request after context selection, compaction, and truncation. Record artifact references and byte ranges for supplied components. Say **sent to the model**; neither traces nor token counts prove which material causally influenced its answer. Provider-side transformations can remain unobservable.

Keep statistical uncertainty separate from unresolved execution. A confidence interval cannot compensate for missing outcomes. Show the denominator and, where appropriate, bounds under alternative unresolved outcomes.

The viewer should display separate fields for `trusted.fulfilment_rate`, `judge.*`, and `candidate.claimed_*`, each with provenance. Only trusted measurements populate official result tables. An annotation such as “all orders shipped” remains useful diagnostic text without affecting coverage.

Viewer annotations can return to the journal as attributed diagnostic records. They must never overwrite authoritative measurements or automatically become policy feedback.

Export permissions follow the feedback contract. Audit telemetry needs a separate destination or access boundary, including during embargo. A shared dashboard is an information channel.

Retain the full authority stream locally and export all traces initially. If volume warrants tail sampling later, retain errors, uncertainty, expensive episodes, and a random baseline. Calculate research metrics from the complete journal. Tail sampling selects diagnostic material and can be affected by late-arriving spans. [OTel tail-sampling behavior](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor)

5. The open decisions should distinguish experimental freedom from the claims a run supports.

| Decision | Recommendation | Where freedom and claims diverge |
|---|---|---|
| Modification scope | Allow acting code, prompts, memory, and compositions of already authorized tools. Pin the controller in the reference experiment. Support controller replacement through the same bounded interface and atomic activation mechanism when enabled. | Wider scope supports more interesting experiments but makes attribution harder. Use narrower arms to identify the source of gains. Controller changes do not require research mode if authority remains fixed. |
| Feedback A | Use for the release’s scientific comparison. Development evidence is available; audit evidence remains embargoed until campaign and selection freeze. | Strongest support for an untouched-audit claim. Audit results cannot select a better candidate for that same claim. |
| Feedback B | Make this the everyday research template. Explicitly permit validation feedback and selection, while preserving a separate fresh blind audit. | Easier iteration and optimizer integration. Repeatedly consulted validation data is consumed development evidence, regardless of its filename. |
| Feedback C | Defer private deployment veto machinery. | A private veto can support operational selection, but even one bit affects the chosen system. It requires query accounting, declared influence, and a separate final audit. |
| Trusted versus research | Default to trusted runs. Reserve research mode for stubbed contracts, candidate-controlled measurement, or experimental semantics outside the trusted claim. | Ordinary policy experiments and custom logging should retain trusted accounting. Experimental measurement cannot certify itself. |

A and B can share most implementation. Their manifests declare which pools may influence adaptation and selection. Neither needs a separate evaluation engine. C adds a distinct private control channel and should earn its implementation cost.

Comparability should have `matched` and `descriptive` settings. Matched comparison validates everything except predeclared experimental differences. Descriptive comparison shows mismatches and observed trends without presenting them as controlled improvement. Both may supply authorized evidence to adaptation.

Keep three labels separate in reports:

- Execution integrity and measurement provenance.
- Feedback exposure.
- Comparison strength.

A trusted execution under B with descriptive comparison can be valuable research. It simply supports a different claim from a matched, blind-audit experiment.

Research mode remains fixed for the run and cannot disable confinement, real expenditure accounting, or outer authorization. Its headline experimental result stays marked untrusted. Real broker receipts retain their provenance. An artifact developed there can undergo a new trusted evaluation; the earlier result is not retroactively upgraded.

This recommendation changes the *default development workflow* from pass 3’s emphasis on A. It preserves A for the first published claim and preserves pass 3’s small authority boundary.

6. Release 1 should make one complete research workflow pleasant before adding platform features.

| Build in release 1 | Concrete scope |
|---|---|
| Manifest resolution | TOML schema, explicit defaults, captured local changes, artifact closure, readable configuration diffs, and strict resume checks |
| Experiment runner | Serial expansion of named arms and seeds, stable run identities, supported simulator forks, and declared budgets |
| Evaluation workflow | Versioned development corpus, A/B visibility contracts, isolated final audit, and fixed-versus-adapting reference study |
| Comparison and export | Markdown/JSON/CSV results, coverage and cost accounting, paired trajectory summaries, uncertainty, manifest references, and trace references |
| Live inspection | CLI status/history/input inspection driven directly by the journal |
| Portable telemetry | One journal projector, OTLP export, Langfuse reference setup, small LangSmith/Phoenix mappings, and export backlog visibility |
| Diagnostic freedom | Bounded arbitrary annotations, provenance, authorized content export, and clear separation of claims from trusted measurements |

Defer a custom web UI, hosted leaderboard, prompt-management service, dataset-labeling product, distributed experiment scheduler, automatic hyperparameter search, and optimizer-specific integrations. Also defer production tail-sampling infrastructure, private veto workflows, general controller-state migration, and distributed durability.

Support controller editability through the general bundle contract where that mechanism is ready; do not require demonstrated controller improvement to release the research tooling. Unsupported combinations should fail explicitly rather than silently weakening their declared guarantees.

The release acceptance experience should be concrete: a researcher changes a policy or parameter, launches paired runs, resumes an interrupted run without resetting its budget, follows cost and coverage live, opens the exact model input behind a regression, and generates a comparison whose numbers can be traced back to journal events.

