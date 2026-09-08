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

