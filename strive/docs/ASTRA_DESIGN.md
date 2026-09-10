<!-- TEMPORARY SCAFFOLDING — remove on completion. This file (and
strive/ASTRA_HANDOFF.md and any other ASTRA_* artifacts) is handoff/design
scaffolding for the rebuild; delete it once the redesign lands and fold durable
content into README/ARCHITECTURE/ADRs. This is the CONSOLIDATED spec; the four
incremental design passes it supersedes live in git history (dbab76b, 2961f3a,
2fc1ec3, 410fef5). Authored by GPT-6 Astra via `codex exec -m gpt-6-astra`. -->

# strive vNext specification

Status: teardown authorized (2026‑09‑08). Amendment 1 (harness pluggability &
τ²-bench workload) must be frozen before the effect/executor boundary is built;
see the amendment appended at the end of this document, which supersedes the
sections it names.  
Date: 8 September 2026.

This document supersedes all earlier Astra design drafts. Read it together with
Amendment 1 at the end. The one remaining human input is the funded USD ceiling
and protected-audit allocation for the reference campaign (§9.6 / Amendment 1).

## 1. Mission and scope

Strive provides **durable mechanisms for model-led adaptation**. An agent operates in a continuing environment, changes its executable behavior, and evaluates subsequent experience. Strive preserves the exact execution history and enforces permissions, accounting, recovery, and declared evidence access.

Policies decide what to change and whether a change helped. The execution core establishes what was authorized, what was observed, what remains uncertain, and which revision is active.

Release 1 provides a local Python runner, immutable executable bundles, stateful operation, model-led actor adaptation, controlled experiments, and journal-backed inspection.

Strive is not:

- An optimizer with a mandatory selection or promotion algorithm.
- A proof that an agent improved or that a task metric captures human intent.
- A general workflow language, distributed agent platform, or hosted experiment service.
- A mechanism for undoing external actions by rewinding agent configuration.

The rebuild is intentionally incompatible with existing run formats, commands, policy interfaces, and artifact schemas. It uses a new artifact root. There is no migration, compatibility alias layer, or dual-writing requirement. Existing histories remain interpretable through their original implementation.

## 2. The five integrity guarantees

These guarantees define the fixed execution core. Their threat and durability assumptions are specified in section 9.

| Guarantee | Precise requirement | Enforcement | What breaks if violated |
|---|---|---|---|
| **1. Confinement and fixed authority** | Candidate code cannot change authorization, accounting, evidence access, trusted measurement, verification, or recovery semantics. | Enforced sandbox, broker-only external access, protected credentials and storage, pinned trusted runtime. | Generated behavior can escape its permissions or rewrite the machinery checking it. |
| **2. Independent facts** | Authoritative interactions, usage, outcomes, and coverage originate from the broker, adapters, and trusted scorer. Candidate claims cannot replace them. Access follows the bound feedback contract. | Producer-specific append interfaces, scoped artifact access, broker instrumentation, scorer-owned coverage. | Candidates can manufacture success, hide expenditure or failures, or consume prohibited feedback. |
| **3. Durable execution identity** | Before external dispatch, the exact request, effect identity, authorization, and reservation are durable. Results, executable bytes, activation, and consumed-result cursors remain reconstructible. | Immutable CAS publication, framed journal commits, stable execution IDs, atomic continuation and revision transitions. | Recovery can execute different code, lose expenditure, repeat work, or consume a result twice. |
| **4. Honest recovery** | Recovery reuses recorded outcomes, reconciles supported mutations, and preserves unsupported uncertainty. Configuration restoration never rewinds spending or world state. | Adapter recovery contracts, durable simulator operation IDs, retained reservations, explicit suspension. | A timeout becomes a false failure, an ambiguous mutation repeats, or an unknown charge becomes zero. |
| **5. A small checked protocol** | Every accepted authority transition preserves protocol consistency. The protocol can represent failures, overruns, and uncertainty without inventing success. | Pure preflight transition checking and full replay of committed authority records. | Authorization, settlement, activation, or continuation can become internally inconsistent. |

A protocol-consistent history can contain failed tasks, exhausted budgets, provider overruns, and indeterminate outcomes. Reports must expose those conditions separately from protocol validity.

## 3. Architecture

These are responsibility boundaries within one local implementation, not seven separately deployed services.

| Component | Responsibility and interface |
|---|---|
| **Run manifests and bundles** | Resolve configuration into retained artifacts before execution. Bundles identify exact actor and controller code, prompts, memory files, entry points, and dependency closure. Requested capabilities describe needs; they do not grant authority. |
| **Journal and CAS** | Maintain one authoritative ordered history per run and immutable content-addressed bytes. Publish referenced objects durably before committing records that reference them. Discovery indexes, reports, and context caches are rebuildable. Content identity remains distinct from command, invocation, and effect identity. |
| **Pure verifier** | Check envelopes, references, producer authority, causation, effect transitions, reservations, settlement, revision activation, and result consumption. Treat diagnostic payloads as opaque. Perform no dispatch, execute no candidate code, and write nothing. |
| **Effect supervisor and budget ledger** | Own execution ordering, reservations, dispatch, deadlines, cancellation, reconciliation, receipts, and accounting. Accept results only for the current execution identity and epoch. All model calls, sandbox invocations, and tool operations use this execution boundary. |
| **Sandbox and capability broker** | Run candidate programs with bounded resources and scoped inputs. Keep credentials, authoritative storage, protected evidence, and privileged adapters outside candidate access. Check destination, operation, arguments, environment, access scope, and available budget before granting an effect. |
| **Operation and evidence layer** | Provide a small resumable step interface, simulator snapshots, trusted scoring, coverage accounting, and authorized evidence projections. Keep workload semantics in pinned adapters and scorers rather than duplicating them in the verifier. |
| **Policy runtime** | Execute a versioned policy over authorized evidence and explicit private state. Policies choose operation, refinement, optional comparison, activation, review, and restoration. Policy judgments remain distinct from authoritative measurements. |

The separation between replaceable executor semantics and trusted execution infrastructure follows the useful distinction in the [Exo specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md). Strive places model dispatch and accounting inside the trusted boundary while leaving request construction to the executor.

### 3.1 Execution and adaptation

An actor or controller runs as a bounded sandbox step:

```text
step(authorized_view, private_state, recorded_result)
    -> command, proposed_private_state, annotations
```

The outer runner owns invocation identity, executing bundle, input references, result delivery, and continuation cursors. Candidate programs cannot supply authoritative values for those fields.

The privileged command interface covers:

| Command | Meaning |
|---|---|
| `ExecuteEffect` | Request one operation from a pinned adapter using exact arguments and an authorized binding. |
| `ApplyChange` | Request activation of a complete new bundle against an expected active revision. |
| `RestoreBundle` | Request activation of an identified prior bundle against the current revision. |
| `EvaluateFork` | Request a charged, isolated comparison at a supported snapshot boundary. |
| `Continue`, `Suspend`, `Finish` | Return control with explicit continuation status. Finishing execution does not certify task success. |

Store one canonical typed command. Do not maintain a second normalized representation with independent meaning.

The supervisor durably accepts step output before acting on its command. A continuation commit binds the private state, consumed result, and any pending command so that recovery cannot consume a result while losing the resulting command.

The ordinary refinement cycle is:

1. Operate bounded steps under the active bundle.
2. Construct an evidence view using authorized artifacts and observations.
3. Obtain a proposed change through brokered model calls.
4. Check structure, dependency availability, editable scope, requested capabilities, and expected revision.
5. Activate the complete bundle atomically at a legal operation boundary.
6. Continue operating and let the policy keep, revise, restore, or gather more evidence.

Comparative evaluation is optional. A policy may request development checks before activation, but the core imposes no improvement test.

Proposal rationales, edit-size limits, citations, review formats, and statements such as “confirmed improvement” are policy conventions or annotations. They are not authority primitives.

### 3.2 Revision and controller boundaries

Every activation records exact previous and next bundles. No invocation observes a mixture of their components.

Controller replacement uses the same mechanism, with these additional preconditions:

- The controller implements the fixed step and continuation interface.
- No pending command or unconsumed result requires interpretation by the old controller.
- The new controller and its explicit initial private state activate atomically.
- Supervisor-owned effect identities, result cursors, and accounting survive unchanged.

There is no arbitrary controller-state migration in release 1. A replacement can reconstruct its strategy from authorized canonical history and explicitly supplied notes.

A looping, crashing, or invalid controller causes bounded failure and suspension. An operator can restore a compatible bundle through the durable command interface without executing the broken controller.

Memory and skills are versioned files. A mandatory knowledge ontology is unnecessary. Imports retain provenance and access scope; summaries do not acquire greater authority than their inputs.

### 3.3 Effect lifecycle and recovery

Release 1 has one writer per run and serial execution, with at most one externally in-flight effect in the active execution path. A local lease and execution epoch prevent concurrent mutation and stale result acceptance.

The lifecycle is:

```text
accepted request
    -> durable authorization and reservation
    -> dispatch
    -> recorded return or uncertainty
    -> settlement and result consumption
```

Outcome status and accounting status are separate. A known response can still have unresolved usage.

| Durable state at interruption | Recovery action |
|---|---|
| Request accepted; dispatch not authorized | Validate and authorize before executing. |
| Dispatch authorized; no durable outcome | Treat execution as potentially performed. Reconcile through the adapter or suspend. |
| Return recorded; settlement or continuation incomplete | Complete bookkeeping from the recorded return. Do not redispatch. |
| Result consumed in committed continuation | Restore that continuation and proceed beyond the result. |
| Execution finished; later receipt becomes available | Append permitted reconciliation or accounting records without reopening completed task execution. |

An adapter declares which recovery mechanisms it implements:

- Recompute a declared deterministic local computation from retained inputs.
- Query an operation by durable identity.
- Retry the same identity under a documented deduplication contract.
- Suspend when the outcome cannot be established.

Business-operation deduplication does not imply billing deduplication. A timeout, cancellation request, or deterministic seed does not prove that an external action did not occur.

An explicit retry outside a supported deduplication contract is a new effect with a new reservation. It does not erase the unresolved predecessor.

This adopts recorded-history execution discipline from [Temporal](https://docs.temporal.io/workflow-execution), without requiring a distributed execution service.

### 3.4 Accounting

For each limited resource, admission checks:

```text
settled usage + outstanding reservations + proposed reservation <= limit
```

Each effect contributes once. Settlement replaces or adjusts its reservation; it does not add a second copy of the same expenditure.

Usage records distinguish:

- **Measured:** usage reported through the trusted adapter, with its provenance.
- **Reserved:** capacity withheld against possible expenditure.
- **Unknown:** actual usage is unavailable; the associated obligation remains.

Cost calculated from measured tokens and a pinned price schedule must be identified as calculated cost, not provider-reconciled billing.

A finite spending ceiling requires a defensible reservation bound. Reject dispatch when the adapter cannot establish one. Reserve paid calls before dispatch, including refinement, evaluation, failed proposals, and retries.

If a provider reports usage above the reservation, record the receipt and overrun, then stop further dispatch. Never reject a real observation merely to keep the ledger within its planned limit.

Resource accounting survives suspension and restart. `wall_seconds` bounds cumulative active execution time across sessions; offline suspension is reported separately. Per-effect deadlines bound individual operations.

## 4. The authoritative record

The following field groups form the closed protocol. Adapter payloads and scorer definitions can evolve behind pinned references without adding a core event family.

| Group | Authoritative fields | Owner |
|---|---|---|
| **Envelope** | Run ID, sequence, record ID and class, causal identity, producer identity, access scope, payload reference, integrity linkage. | Supervisor. Producer identity comes from the append interface, never a candidate-supplied string. |
| **Run binding** | Resolved manifest, trusted runtime/verifier/adapter/scorer identities, initial environment and bundle, model bindings, limits, capabilities, editable scope, feedback contract, comparison contract, trust mode, and declared lineage. | Trusted run setup. |
| **Effect authorization** | Command and effect IDs, exact request reference, executing bundle, adapter and operation, target environment, permitted scope, reservation, recovery contract, execution epoch. | Broker and supervisor. |
| **Effect observation and settlement** | Dispatch, return, failure or uncertainty status; response and receipt references; observed environment version; usage quantities and provenance; reservation disposition; reconciliation references. | Broker and trusted adapters. |
| **Measurement** | Subject run/window and revision references, workload identity, scorer version, supporting receipt/state references, planned and admitted coverage, completed coverage, exclusions, metric identity and value. | Trusted scorer. |
| **Revision activation** | Exact previous and next bundle references, expected active revision, activation boundary, and coupled controller-state reference when applicable. | Supervisor after validation. |
| **Continuation commit** | Exact private-state bytes, executing bundle, consumed-result cursor, pending command reference, environment reference, and execution status. | Supervisor. It certifies the recorded bytes and transition, not the quality of the private state's reasoning. |

Trusted measurement records establish what the pinned scorer reported from its inputs. They do not prove that the scorer is correct or that external providers told the truth.

The pure verifier checks this recorded provenance and its relationships. It does not independently reconstruct arbitrary external reality. Offline verification relies on the trusted storage and producer assumptions in section 9; a schema-valid `producer="broker"` field is not authentication.

### Open annotations

An `Annotation` envelope or `annotations` subtree accepts namespaced events, bounded JSON, text, hypotheses, memories, compaction descriptions, proposal explanations, component labels, timing diagnostics, and claimed scores.

Unknown annotation schemas remain readable as opaque data. They do not invalidate an otherwise valid run.

Annotations cannot:

- Authorize execution or access.
- Change the active revision or consumed-result cursor.
- Settle expenditure or release a reservation.
- Certify workload success, coverage, or evidence eligibility.
- Authorize a retry.

For example, `executor.order_completed` may claim that order 42 shipped. Only simulator state and trusted receipts can establish its scored outcome.

This separation addresses the logging attack documented in [DGM Appendix F](https://arxiv.org/html/2505.22954v1#A6), where changing evaluator-visible logging produced a high score without fixing the underlying behavior.

Annotation size and storage quotas apply. A diagnostic becoming relevant to success, permissions, spending, or recovery requires a trusted producer and defined authority semantics before the core relies on it.

### Access and verification

Release 1 uses static run and lineage scopes plus the bound feedback contract. The broker checks access before bytes reach candidate code, including before retrieval, compaction, or context construction.

Candidate programs receive scoped artifact handles and filtered views. They receive neither a general CAS reader nor unrestricted history access. Derived artifacts retain the producing scope; arbitrary annotations cannot relabel them.

The verifier checks each new authority transition against an already verified state. Restart and explicit audit replay the complete authority stream. Persistent verification caches are deferred.

Missing required artifacts, malformed committed records, or inconsistent transitions stop mutation. An incomplete or damaged tail requires explicit recovery handling; it must not silently become a different accepted history.

## 5. The original invariants

| Original invariant | Final treatment |
|---|---|
| **Durable and exactly resumable** | Preserve exact reconstruction of committed execution state and consume recorded results once. Automatic recovery across an external boundary is conditional on its adapter contract. Unsupported ambiguity suspends rather than producing a fictitious exact outcome. |
| **Verifiable** | Preserve pure checking, content identity, and rejection of forged or inconsistent authority transitions. Verification establishes protocol consistency under declared trust assumptions, not semantic truth for every artifact or proof of improvement. |
| **Secure floor** | Preserve mechanically enforced confinement and fixed outer authority. Sandbox lifetime is an isolation choice; a fresh interpreter for every case is not itself the invariant. |
| **Policy-neutral and model-led** | Preserve the policy's authority over adaptation strategy and the activation behavior in section 3. Research algorithms remain replaceable programs above the core. |
| **Behavioral-evidence gates** | Replace universal evidence exclusion with declared access, provenance, outcome classification, and honest comparison claims. The two relaxations below are explicit parts of this specification. |

The two relaxed evidence restrictions are:

1. **Evidence need not be comparable before informing adaptation.** An unmatched failure can motivate a change. Comparability constrains the resulting improvement claim.
2. **Infrastructure observations may inform adaptation.** Authorized timeout, output-limit, and tool-availability evidence can help a policy change its behavior. They cannot silently become evidence of task success or behavioral failure.

The replacement classification is:

| Dimension | Required distinction |
|---|---|
| Fault origin | Task behavior, candidate execution, infrastructure/provider failure, or unresolved outcome. |
| Provenance | Trusted environment/scorer measurement, attributed judge assessment, or candidate claim. |
| Exposure | Which pools and operational observations could influence adaptation or selection. |
| Comparison | Matched evidence or descriptive observation, with mismatches disclosed. |
| Uncertainty | Statistical uncertainty versus missing or unresolved execution outcomes. |

Scoring follows the pinned workload contract. Exclusions, infrastructure failures, and unresolved effects remain visible in coverage; a candidate cannot improve its denominator by hiding them.

## 6. Config-as-code

### 6.1 Authored and resolved manifests

The authored manifest contains readable choices, local paths, and experimental parameters. A typed Python builder may produce the same data. Configuration contains no executable expressions or inheritance language.

The resolved manifest expands defaults, captures referenced bytes and local source changes, resolves package references, and records effective non-secret settings before dispatch.

| Identity | Meaning |
|---|---|
| Configuration digest | Hash of the canonical resolved configuration. |
| Run ID | Independent execution identity. Identical configurations can produce different runs. |
| Bundle digest | Exact executable configuration at a revision. |
| Invocation/effect ID | One execution occurrence, even when its input bytes match another occurrence. |

The resolved closure includes runtime and platform details, dependency artifacts, controller package and initial state, actor artifacts, imported memory, tool schemas, timeout and retry settings, model request settings, price schedule, and workload/scorer definitions.

`pins.initial_bundle` supplies the initial actor components. Resolution combines them with the resolved policy package into the complete active bundle.

Requested model identity belongs in the resolved configuration. Observed model identity belongs in each response record. Unsupported request seeds are recorded explicitly.

Credentials remain opaque external bindings. Environment variables cannot silently alter scientific settings on resume. Duplicate settings, such as conflicting token limits in a request-settings artifact and the manifest, fail resolution.

### 6.2 Run schema

The following is the concrete development template. Digest and provider placeholders must resolve before execution. Its example budget is not authorization to spend.

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
initial_bundle = "sha256:<actor-code-prompts-memory-and-entrypoints>"

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

Schema rules:

- Unknown core keys fail with a useful error. The pinned policy validates its own parameters.
- References resolve to retained, hash-checked artifacts. Local paths are authoring inputs, not runtime identity.
- Monetary accounting uses exact fixed units internally.
- `budget.includes` must cover every cost-bearing phase enabled for that run. Omitting a phase cannot exempt its expenditure.
- Recovery settings can select only capabilities implemented by the pinned adapter.
- The comparison plan defines horizon, pairing, metrics, exclusions, stopping, and candidate selection.
- The audit-plan reference does not grant candidate access to its protected contents.
- Arbitrary diagnostic keys belong in annotations, not unvalidated configuration fields.

The trusted contract stays fixed for the run. Changing permissions, feedback exposure, model assignment, spending ceiling, or trusted implementations requires a new run. Authorized bundle revisions remain part of the existing run.

### 6.3 Commands

The ordinary workflow uses three commands:

```text
strive run orders.toml --id actor-17
strive resume actor-17
strive compare fixed-17 actor-17 --spec paired.toml
```

| Command | Contract |
|---|---|
| `run` | Resolve, validate, retain, and display configuration before dispatch. Reject an existing run ID rather than restarting it. |
| `resume` | Load recorded configuration, artifacts, accounting, and continuation. Reject conflicting scientific overrides. |
| `compare` | Read histories without dispatch. Validate the comparison contract and generate Markdown, JSON, and CSV results with evidence references. |

A thin serial wrapper provides study execution:

```text
strive experiment study.toml
```

The study schema contains a base run manifest, named arm overrides, repetitions and seeds, pairing rules, per-arm and total allocations, a separate audit allocation, and an analysis plan. It records a stable mapping from each arm/repetition to its run ID before dispatch.

Restarting the wrapper resumes that mapping. It does not create fresh executions for already allocated repetitions. Arm expansion calls the same runner and comparison implementation; it introduces no scheduler service.

## 7. Experiments

Amendment 3 governs telecom split assignment. The adaptive study and its matched fixed control use a Strive-derived whole-base-scenario split. A separate initial fixed-agent run uses tau2's stock `test` split; its results never enter adaptation or the adaptive comparison. Retain actual split sizes and keep these two result populations separate.

### 7.1 Studies and the reference comparison

A study is a set of ordinary runs with declared relationships. Every run retains its complete resolved manifest.

The first reference study compares:

| Arm | Intervention |
|---|---|
| **Fixed behavior** | Initial actor code, prompts, and memory remain fixed. Ordinary task continuation and environment state still evolve. |
| **Actor adaptation** | The same initial actor may revise its declared code, prompts, and memory using the pinned continual controller. |

Use feedback contract A for this study. The B template's adaptive validation pool is not granted to the reference runs.

Paired repetitions start from identical simulator snapshots and exogenous order streams in independent mutable environments. Actor model assignment, scorer, capabilities, initial actor components, and available resources match. Differences in policy and editable scope are declared.

Workload randomness is independent of policy and model randomness. Different model-call counts must not change the exogenous order stream.

Compare complete trajectories. A fork from a successful intermediate state answers a conditional question about that state.

### 7.2 Resources, metrics, and analysis

Arms receive the same spending ceiling, task horizon, and relevant time limits. An inexpensive arm need not spend its remainder.

Count acting, refinement, development evaluation, failed proposals, retries, and policy-requested forks against the arm's allocation. Report inherited preparation cost, new branch expenditure, and total campaign expenditure separately, without double counting shared history.

The analysis plan fixes:

- Cumulative correctly fulfilled orders and fulfilment rate over the declared horizon.
- Planned, admitted, completed, failed, excluded, and unresolved coverage.
- Retention and regressions on the development corpus.
- Outcomes over cumulative expenditure and workload progress.
- Settled usage, calculated costs, outstanding reservations, and unresolved billing.
- Stopping rules, candidate selection, and uncertainty estimation.

Use paired trajectories or independent environment repetitions as statistical units. Correlated orders within one stateful trajectory are not independent repetitions.

Report all declared runs, including stopped, failed, and indeterminate runs. Statistical intervals do not absorb missing outcomes; show unresolved counts and appropriate outcome bounds separately.

### 7.3 Ablations and comparison strength

Useful subsequent ablations include prompt-only adaptation, code-only adaptation, memory removal, refinement interval, and development forks disabled. Controller adaptation is a separate research question.

Specify the actual intervention. Freezing memory does not disable reading existing memory. A “no memory” arm must change initialization and retrieval as well.

| Comparison setting | Required behavior |
|---|---|
| `matched` | Check workload, snapshots, scorer, model settings, budgets, pairing, and other bound conditions except predeclared experimental differences. Report unexpected differences and refuse a matched-improvement claim. |
| `descriptive` | Report observed outcomes and configuration differences without presenting them as a controlled estimate of improvement. |

Expected derived digest changes must be explained by declared leaf-level interventions. An allowed policy change must not become blanket permission to ignore unrelated bundle differences.

Either setting may supply authorized evidence to a policy.

### 7.4 Development corpora and forks

For telecom, assign whole base scenario roots across development, validation, and audit before running either arm. Target 60/14/40, retain every selected base task, and report the closest feasible nonempty partition. The pinned pool yields 49/29/36 under Amendment 3. The full-inventory stock train/test overlap scan is informational.

The development regression corpus contains prior failures, retained successes, representative families, and adversarial development examples. Additions identify their source events and access scope.

A study pins a corpus version or an explicit update rule. Corpus changes cannot silently alter a paired comparison.

Execution forks require:

- Parent run and committed cursor.
- Active bundle and explicit continuation.
- Available simulator snapshot.
- Authorized import scope.
- New execution identity.
- Reserved allocation from the declared experimental budget.

Fork only at supported snapshot boundaries without ambiguous effects. Historical inspection can reach other cursors without implying that execution can restart there.

Policy-requested development forks charge the requesting arm. Independent study branches receive declared campaign allocations. Neither operation replenishes the parent's budget.

### 7.5 Audit lineage

Predeclare the candidate-selection procedure before the campaign. Freeze the completed campaign and exact selected artifact references before running the blind audit.

For the reference study, audit the selected frozen actor bundles from both arms under the same audit contract. The audit measures transfer of those bundles; it does not by itself establish that the entire adaptation procedure improves on unseen streams.

Audit execution uses separate lineage, environment state, artifact access, retrieval indexes, caches, provider conversation state, and accounting. Ordinary task state may evolve inside that lineage, but audit artifacts cannot flow back into development.

Isolation includes traces, memories, prompts, scores, dashboard views, acceptance flags, stop signals, budget effects, and messages. The audit runner exposes results only through the authorized reporting path after the freeze and audit procedure.

An audit score cannot select a different candidate for the same untouched-audit claim. If a human uses audit findings to direct further development, the next claim requires a fresh audit.

Noninterference tests vary protected inputs and scores while holding permitted inputs and recorded model responses fixed. The adaptive lineage's requests, commands, and visible state must remain unchanged. This checks framework information flow, not whether a pretrained model previously encountered benchmark material.

### 7.6 Replay, resume, and reproduce

| Operation | Promise |
|---|---|
| **Replay** | Reconstruct recorded state, results, revisions, and accounting from verified history without external dispatch or candidate execution. |
| **Resume** | Continue the same run using pinned artifacts and recorded results, following section 3's recovery rules. |
| **Reproduce** | Start a new execution from the resolved specification and retained dependencies, then measure agreement. |

Retain actual model requests and responses, simulator snapshots, random state, and relevant external observations. Replaying an old model response against changed input is invalid.

Missing artifacts cause a clear replay failure. Unavailable model versions or changed environments cause an explicit reproduction limitation. Neither operation substitutes “latest.”

A publishable result includes the study specification, resolved manifests, executable artifacts, split and scorer identities, all run outcomes, cost and coverage tables, reproduction commands, and event references behind reported measurements. Protected audit material remains subject to separate access and publication rules.

## 8. Observability

### 8.1 Journal projection

One read-only projector follows committed history, resolves authorized artifacts, and emits OTLP. Telemetry is never on the critical path for dispatch, recovery, scoring, or accounting.

Exporter failure creates a visible backlog. Rebuilding the projection from history restores inspection without changing execution state.

Keep the full authority stream locally. Export all permitted traces initially. Production tail sampling is deferred.

| Journal evidence | OTel representation |
|---|---|
| Bounded cycle coordinating agent operations | `invoke_workflow` span. |
| Actor or refiner invocation | `invoke_agent` span with role and executing bundle. |
| Model authorization, dispatch, return, and usage | Appropriate GenAI model-operation span with requested/observed model identity and available usage. |
| Brokered tool operation | `execute_tool` span with effect identity and classified outcome. |
| Activation, restoration, continuation | Correlated logs or span events with exact artifact references. |
| Measurements and accounting | Numeric observations and records linked to authoritative events. |
| Candidate or human annotations | Namespaced diagnostic logs with producer and subject references. |

Pin OTel GenAI semantic conventions to `1.41.0`; their Development status makes the pin necessary. Use standard attributes where their meanings fit and `strive.*` for execution-specific fields. See the pinned [agent conventions](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-agent-spans.md) and [model conventions](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-spans.md).

Use `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` where applicable. Missing usage remains missing. See the pinned [GenAI metrics](https://raw.githubusercontent.com/open-telemetry/semantic-conventions/v1.41.0/docs/gen-ai/gen-ai-metrics.md).

Group bounded traces by run and campaign. Use links across recovery episodes and forks instead of leaving a root span open indefinitely. Derive stable telemetry identities from execution identities, not request hashes.

Broker-observed timing determines latency. Export time does not. Suspension and later reconciliation remain explicit.

OTLP does not provide universal exactly-once ingestion. Historical re-export must not increment financial totals again. Official cost and research totals always come from the authoritative journal fold.

### 8.2 Viewer profiles

Release 1 ships one reference profile, [Langfuse](https://langfuse.com/integrations/native/opentelemetry), over vendor-neutral OTLP with GenAI semantic conventions pinned to `1.41.0`. It adds supported Langfuse attributes and child-span grouping metadata while preserving standard and `strive.*` attributes.

LangSmith and Phoenix profiles are deferred and rejected by manifest validation. OTLP output already works with any OTel backend that accepts the emitted OTLP/HTTP JSON; per-vendor attribute mappings will be added on demand.

Selecting an endpoint requires no policy instrumentation changes. Endpoint credentials remain outside archived artifacts.

Assign campaign, arm, role, phase, model binding, revision, and evidence scope at authorization. Attribute costs once to leaf effects and roll them up. Keep artifact hashes and event IDs out of general metric labels.

Audit export uses a separate destination or enforced access boundary. A shared dashboard is a feedback channel.

### 8.3 Researcher inspection

Provide journal-backed status, history, and invocation-input inspection, including:

```text
strive status RUN --follow
```

The inspection experience shows:

- Active revision, current work, and reason for suspension.
- Settled, calculated, reserved, and unknown expenditure.
- Planned work and coverage, including failures and unresolved outcomes.
- Performance and retention with the available statistical evidence.
- Exact model requests, supplied components, and associated effects.
- Telemetry cursor and backlog.

Preserve the actual adapter request after context selection, compaction, and truncation. Record component references and byte ranges where applicable. Label this material **sent to the model**. It does not establish what causally influenced the response, and provider-side transformations may be unobservable.

Display trusted workload measurements, judge assessments, and candidate claims separately. A trusted record that a judge awarded a score certifies the assessment's provenance, not simulator success.

Viewer annotations may return through an attributed annotation interface. They cannot overwrite measurements or automatically enter adaptive context.

## 9. Resolved design decisions

### 9.1 Modification scope

Release 1 permits actor code, prompts, memory, and pure computations or compositions of already authorized tools. Dependencies come from the supplied pinned environment.

The reference experiment pins the controller. Controller replacement is available through the bounded interface and atomic activation contract in section 3 when explicitly enabled in the editable scope. It does not require research mode.

Demonstrated controller improvement is not a release requirement. General state migration, model-weight modification, arbitrary dependency installation, and candidate-created privileged adapters are deferred.

### 9.2 Feedback contract

| Contract | Final use and permitted influence |
|---|---|
| **A: strict blind audit** | Required for the release scientific comparison. Declared development evidence may drive adaptation and selection. Audit evidence follows section 7's embargo and lineage rules. |
| **B: adaptive validation plus fresh blind audit** | Default development template. Both development and explicitly declared validation pools may drive adaptation and selection. Consulted validation data is consumed development evidence and cannot support an untouched-held-out claim. |
| **C: private deployment veto** | Not implemented in release 1. Selecting or blocking a candidate using private feedback would require a distinct declared control channel, query accounting, and a separate final audit. |

A and B share the same execution and evaluation machinery. Their access grants differ. Operational failures are visible by default when authorized by the manifest.

### 9.3 Trusted and research modes

Trusted mode is the default for ordinary policy experiments, controller edits within scope, custom annotations, and descriptive comparisons.

Research mode is fixed at run creation. It permits stubbed adapters, simulated receipts, candidate-controlled measurement programs, and experimental semantics outside the trusted-result contract.

Research mode retains the outer runner's confinement, authorization, and real expenditure accounting. Simulated receipts identify themselves. Experimental scores remain untrusted. Real broker receipts retain their own provenance.

Artifacts produced in research mode may receive a new trusted evaluation. That does not retroactively upgrade their earlier results.

### 9.4 Workload and providers

The first stateful workload is pinned tau2 telecom text through the separately installed `BenchmarkAdapter` implementation described in Amendments 1 and 2. Agent tools and user device operations mutate a coupled environment; trusted deterministic evaluators determine success. Candidate claims never establish reward.

Amendment 3 defines two evaluation modes. The adaptive study uses our own whole-base-scenario split over the selected base pool, with exact actual IDs retained. The separate fixed-stock mode runs the initial non-adapting actor on all published `test` IDs, without a group-disjointness gate. Every selected headline task in either mode must pass deterministic grading qualification. Stock train/test scenario overlap is informational, including the historical 2,285-ID finding.

The adaptive split has no leaderboard comparability claim. Fixed-stock results support comparisons using the same stock test IDs, actor implementation, user model, temperature, trial count, and upstream revision. Upstream documents `base` as the original leaderboard denominator, so stock test results must not be presented as a full-base leaderboard score. See Amendment 3 for pinned user settings and execution details.

Actor and refiner bindings retain exact model versions and request settings. Adaptive inference remains brokered through the existing confined runtime. The fixed-stock benchmark runner has no refiner or cross-episode learned state and reports separately from Strive's adaptive accounting and integrity claims.

### 9.5 Durability and threat scope

Release 1 assumes one trusted host and operator, hostile generated code and inputs, and durable local storage surviving process failure.

Protect against candidate access violations, forged candidate records, accidental corruption, interrupted publication, and process crashes. Enforce sandbox resource limits and protected storage access on the supported runtime.

Host or disk destruction, malicious operators, undetectable replacement of the entire store, distributed ownership, and host-loss failover are outside the claim. Hash chains alone do not establish protection against complete history replacement.

### 9.6 Budget and release claim

The release must demonstrate the integrity mechanisms and complete the fixed-versus-adapting study under a predeclared funded ceiling. The template's numbers are illustrative; campaign funding remains a human input.

The release claim is a functioning, inspectable mechanism for trustworthy actor adaptation under the stated scope. Positive performance results are not required to ship it.

An improvement claim additionally requires the matched evidence, coverage, cost accounting, uncertainty, and feedback conditions in section 7. A negative or inconclusive study must be reported as such. Controller improvement requires its own experiment.

### 9.7 What defines a trusted run

A run qualifies for trusted execution claims only when all five guarantees in section 2 hold under the declared assumptions. A `mode="trusted"` flag alone is insufficient.

Trust does not require strict feedback A, matched comparison, controller immutability, or automatic recovery from every provider. Those are separate configuration and claim dimensions.

Reports therefore carry three separate labels:

| Label | Meaning |
|---|---|
| Execution integrity and measurement provenance | Which guarantees and producers support the recorded result. |
| Feedback exposure | Which evidence could influence adaptation and selection. |
| Comparison strength | Whether the evidence supports a matched comparison or descriptive observation. |

A trusted B run with descriptive comparison is valid research. Its label must not imply a blind, controlled improvement result.

## 10. Release-1 scope and milestones

### 10.1 Build now and defer

| Build now | Defer |
|---|---|
| TOML resolution, Python builder, retained artifact closure, strict resume, readable configuration differences. | Configuration inheritance language and a general packaging platform. |
| Local framed journal, CAS, authority protocol, pure verifier, incremental preflight, full replay. | Persistent verifier caches, signed external history anchors, replication and host-loss recovery. |
| Serial supervisor, durable reservations, reconciliation, honest uncertainty, operator recovery. | Remote workers, concurrent subagents, distributed scheduling and budget coordination. |
| Enforced sandbox, capability broker, protected credentials, scoped views. | Arbitrary dependency installation and generated privileged adapters. |
| Stateful order simulator, sum/max fixtures, explicit continuation, supported snapshot forks. | General workflow language, persistent interpreter recovery, arbitrary VM/process snapshots. |
| Actor adaptation and general atomic bundle/state activation, including bounded controller replacement. | Controller-state migration and a required controller-improvement study. |
| Open annotations, versioned memory files, explicit scoped imports. | Mandatory memory ontology and global mutable cross-run memory. |
| A/B feedback contracts, development corpus, isolated final audit. | Private veto contract C. |
| Serial study wrapper, two-arm reference study, paired analysis, Markdown/JSON/CSV reports. | Automatic hyperparameter search, optimizer-specific integrations and population-search tooling. |
| Journal-backed CLI inspection, vendor-neutral OTLP projection and the Langfuse reference profile. | LangSmith/Phoenix profiles until needed; custom web UI, hosted leaderboard, prompt-management service, labeling product and production tail sampling. |
| Ordinary brokered execution. | Speculation and reusable external-effect caches. |

### 10.2 Milestone sequence

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| **1. Freeze contracts and acceptance cases** | Authority schema, step interface, effect lifecycle, manifest schema, simulator scenarios, feedback access matrix, and reference study plan. | Each integrity guarantee has a falsifiable test. Human go/no-go precedes teardown. |
| **2. Build storage and pure verification** | New artifact root, CAS publication, framed history, one-writer ownership, reference validation, replay and preflight. | Reject malformed authority transitions and corrupted references. Accept unknown bounded annotations. Verification works in a fresh interpreter without candidate imports. |
| **3. Build effects, accounting, and confinement** | Broker, sandbox, reservations, recorded returns, settlement, continuation and operator recovery. | Fault injection at authorization, dispatch, return, settlement, and continuation boundaries. Reject stale results, unauthorized calls, credential access and budget expansion. |
| **4. Complete stateful operation** | Transactional simulator mutations, operation lookup, snapshots, trusted scoring and coverage. | Crash after mutation but before strive records the receipt; recover the original result without repeating the mutation. Unsupported model uncertainty retains its obligation and suspends. |
| **5. Enable adaptation** | Code/prompt/memory revisions, atomic activation/restoration, optional forks and bounded controller handover. | Prompt-only edits alter behavior. Composite activation survives crashes. Restoration preserves current world state and accounting. Controller failure can be repaired independently. |
| **6. Complete the research workflow** | Manifest and study commands, A/B access, audit isolation, comparisons, CLI inspection and the Langfuse telemetry profile. | Protected-data noninterference, complete denominator reporting, restart-safe study expansion, and exporter outage/re-export checks. |
| **7. Evaluate and package** | Funded reference study, portable report and artifacts, installed package and documentation. | All declared runs reported; every official measurement and cost traces to authoritative records. State only claims supported by results. |

Maintain strict typing, relevant tests, installed-wheel CLI smoke tests, and fresh-interpreter verification throughout the rebuild. Tests for authority and recovery must exercise failure boundaries, not merely mirror implementation structure.

The acceptance experience is one complete workflow: a researcher changes a policy or parameter, inspects the resolved differences, launches paired runs, interrupts and resumes execution without resetting expenditure, follows cost and coverage, opens the exact request behind a regression, and generates a comparison with traceable numbers. The same workflow remains usable while telemetry delivery is unavailable.

## 11. Remaining human questions

1. **Go/no-go:** Approve this specification, including its explicit evidence-rule relaxations, before any teardown?
2. **Provider binding:** Which funded provider account and exact actor/refiner model versions should the first adapter and campaign use?
3. **Campaign size:** What total spending ceiling, separate audit allocation, task horizon, and number of paired repetitions are authorized for the first real-model study?

## Appendix: Changes from earlier drafts

- Closed schemas now cover authority records only. Diagnostics and policy annotations are open.
- The verifier checks protocol consistency and provenance; workload facts belong to pinned adapters and scorers.
- Faithful records may include overruns, uncertainty, and late settlement after execution finishes.
- Actor-only adaptation is the reference experiment. Controller editing remains supported within fixed authority, without a dedicated improvement gate.
- B is the development default; A governs the release scientific comparison. C is deferred.
- Unmatched evidence and infrastructure observations may inform adaptation. Classification and comparison rules constrain claims.
- Exact resume means exact recorded state plus supported reconciliation, with suspension for unresolved external effects.
- Bundle restoration replaces general inverse-edit machinery. Memory files replace a mandatory structured-memory ontology.
- Release 1 uses serial local execution. Subagents, distributed durability, speculation, and general state migration are deferred.

---

# AMENDMENT 1 — Harness pluggability & real benchmark — GPT‑6 Astra

*Authored by GPT‑6 Astra via `codex exec -m gpt-6-astra` (read-only design pass)
after the human authorized teardown and set two directives: (1) strive must plug
into different agent harnesses (opencode, claude code, codex, pi at minimum),
exo-style; (2) the reference study must run a real, relevant benchmark, not a
toy. This amendment supersedes the sections it names (§§2, 3, 4, 6, 7, 9, 10, 11)
where they conflict. The five integrity guarantees in §2 are unchanged. Status:
teardown authorized; this boundary amendment must be frozen before the
effect/executor boundary is implemented. Verified environment: opencode 1.17.18,
codex 0.153.4, claude 2.1.263 installed; pi NOT installed; `gpt-5.6-luna`
reachable via opencode (OpenAI + Bedrock).*

**Release 1 supports harness-as-model, ships opencode, codex, and Claude Code adapters, and uses the published τ²-bench telecom text tasks as its headline workload.** Pi remains interface-ready until installed and tested. Harness-as-executor is deferred.

The five guarantees remain unchanged. Teardown is authorized, but the effect/executor boundary must implement the contract below before replacing the existing boundary.

**Add to §3.1: harness boundary**

Strive distinguishes two integration levels:

| Level | Execution contract | Release 1 |
|---|---|---|
| **Harness-as-model** | An external harness performs one bounded generation and returns text or a proposed command. Strive owns continuation, tool execution, adaptation, accounting, and recovery. | Supported. |
| **Harness-as-executor** | An external harness owns an agentic loop, invokes tools, and maintains internal execution state. | Rejected during manifest resolution. Reserved as a future capability. |

A noninteractive command does not establish the first contract by itself. `opencode run`, `codex exec`, and `claude -p` must execute under a pinned profile that disables tools and auxiliary generations, with an enforced outer sandbox and a broker-controlled model connection.

Release 1 permits **at most one upstream generation request per harness invocation**. Automatic retries, compaction calls, session-title generation, subagents, fallback models, and background model calls are disabled. The gateway rejects additional requests before forwarding them. An adapter that cannot complete under this restriction fails qualification.

This preserves the executor/infrastructure distinction in the [Exo specification](https://github.com/exoharness/exo/blob/main/exoharness/docs/spec.md). Harness-specific prompt construction and response handling remain replaceable. Strive retains authority over dispatch and its consequences.

| Guarantee | Enforcement across the harness boundary |
|---|---|
| **1. Confinement and fixed authority** | The whole harness process tree is confined. It receives scoped input bytes, pinned configuration, disposable scratch storage, and one restricted gateway capability. It receives no provider credentials, privileged tools, authoritative storage, or protected evidence. |
| **2. Independent facts** | The gateway records requests, provider responses, and usage provenance. The workload adapter records state transitions. The scorer measures trusted state. Harness logs and generated claims cannot establish spending or success. |
| **3. Durable execution identity** | Before launching the harness, retain its exact inputs, executable/configuration identities, effect ID, authorization, and reservation. Before forwarding its model request, durably retain the actual wire request. |
| **4. Honest recovery** | Recover committed outputs and reconcile gateway evidence. Never infer nonexecution from process death, resume an opaque native session, or silently repeat an ambiguous generation. |
| **5. A small checked protocol** | Every backend uses the same typed effect and continuation records. The verifier checks authority and transitions without interpreting a harness’s native transcript format. |

Future executor support requires mediation of **every** model call, tool operation, descendant process, and state mutation, plus recoverable identities and bounded reservations for each. A final environment snapshot can establish an outcome, but cannot establish that intermediate actions respected permissions or budgets. Snapshot scoring alone therefore cannot qualify an opaque executor.

**Add to §3.1: `HarnessAdapter` contract**

A harness adapter is a pinned implementation selected through the existing model-dispatch binding. It does not replace `step()` or introduce a second acting loop.

The small interface is:

```text
describe() -> HarnessDescriptor

prepare(binding, generation_input, execution_context)
    -> PreparedGeneration | Unsupported

invoke(prepared_generation, supervisor_services)
    -> HarnessReturn

reconcile(prepared_generation, durable_evidence)
    -> RecordedReturn | DefinitelyNotDispatched | Indeterminate
```

| Type | Required contents |
|---|---|
| `HarnessDescriptor` | Interface version, backend name, supported integration levels, compatible executable versions, supported provider protocols, confinement requirements, accounting-bound method, output decoder identity, and recovery capabilities. |
| `GenerationInput` | Role, authorized context artifact references, requested model binding, generation settings, output schema, and resource limits. No unrestricted history or CAS handle. |
| `ExecutionContext` | Supervisor-assigned run, invocation, effect, bundle, epoch, and evidence-scope identities. Candidate code cannot assign these. |
| `PreparedGeneration` | Exact launch arguments, input bytes, effective configuration, dependency/executable references, sandbox profile, output-decoding contract, deadline, and defensible reservation requirements. Preparation performs no paid dispatch. |
| `HarnessReturn` | Completion classification, captured output references, decoded text/proposal reference, process observations, and gateway receipt references. Harness-reported usage and model names retain separate provenance. |
| `supervisor_services` | Confined process launch, bounded stream capture, deadline/cancellation control, and an effect-scoped model gateway. No arbitrary privileged shell, general network access, or unrestricted journal writer. |

Backend names are registry keys, not a core enum. An operator-installed package implements `strive.harness/1`; resolution retains its code and descriptor in the trusted dependency closure. Candidates cannot install or replace adapters.

The execution path remains:

```text
step(authorized_view, private_state, recorded_result)
    -> ExecuteEffect("model.generate", binding="actor", request=...)
    -> durable continuation containing that pending command

supervisor
    -> prepare and authorize the bound harness generation
    -> invoke confined harness
    -> gateway commits and forwards the permitted model request
    -> record generation result and accounting

next step(..., recorded_generation_result)
    -> validate proposal
    -> propose a separate brokered workload effect
```

The same path supports refinement. A refiner returns proposed bundle contents or edits as data. Existing bundle validation and `ApplyChange` perform activation.

`model.generate` is the logical effect encompassing local harness execution and its single permitted upstream generation. Its reservation covers both. Process launch and provider forwarding are distinguishable dispatch stages, with their exact requests recorded before each stage. There is no second model charge attached to a surrounding harness span.

A harness response never executes a tool directly. Even a syntactically valid proposed command must pass through a subsequent committed `step()` result and ordinary broker authorization.

**Extend §§3.3–3.4: confinement, accounting, and recovery**

Each invocation uses a fresh native session. The pinned launch profile must:

- Supply only authorized context and explicitly selected bundle components.
- Disable native tools, MCP servers, hosted tools, hooks, plugins, skills, automatic memory, discovery of user/project instructions, session sharing, and background agents.
- Expose a minimal filesystem containing the pinned runtime, configuration, supplied context, and disposable scratch space.
- Deny access to host homes, credentials, keychains, agent sockets, supervisor storage, environment databases, and audit artifacts.
- Restrict the entire process tree’s network access to the effect-scoped model gateway. The gateway has fixed upstream routes and cannot act as a general proxy.
- Enforce process, memory, storage, output-size, and active-time limits outside the harness.

CLI permission settings are additional controls. They are insufficient as the outer confinement mechanism. A host without an implemented and tested confinement profile cannot launch a trusted harness run.

The gateway holds the real provider credentials. The harness receives only a short-lived capability restricted to its effect, epoch, provider, requested model, request limits, and single upstream dispatch. Ambient credentials are not inherited.

The gateway validates the actual model request, including harness-added instructions and schemas. It rejects unapproved models, nonempty executable tool catalogs, hosted tools, unsupported billing options, and oversized requests. It retains both the submitted context and the actual provider request, so reports do not confuse “supplied to the harness” with “sent to the model.”

OpenCode documents hidden compaction, title, and summary agents, so disabling only its visible acting tools is insufficient. Its provider configuration supports a proxy base URL. These are implementation inputs, not proof that a particular profile passes confinement. [OpenCode agents](https://opencode.ai/docs/agents/), [provider configuration](https://opencode.ai/docs/providers/)

For each resource, admission remains:

```text
settled usage + outstanding obligations + proposed reservation <= limit
```

For a harness generation, the provider adapter establishes:

```text
token reservation = bounded billable input + bounded billable output

cost reservation =
    maximum applicable input/cache charges
  + maximum applicable output/reasoning charges
  + bounded request fees
```

The bound includes harness-added context, hidden billable reasoning where applicable, and any cache-write premium. It cannot assume a cache hit. A client timeout, `max-turns` setting, or displayed dollar estimate is not a financial bound.

Input counting must have a documented conservative relationship to provider billing. Where exact counting is unavailable, reserve a defensible provider maximum. If neither input nor output expenditure can be bounded under the provider contract, suspend before dispatch.

Release 1 handles hidden or multiple calls as follows:

| Observation | Required treatment |
|---|---|
| Harness attempts an auxiliary call or retry | Gateway denies it before forwarding. The adapter must not silently replace it with a different model request. |
| Provider receipt supplies complete usage | Settle once from that receipt, preserving its provenance. |
| Provider receipt supplies partial usage | Settle known components; retain the bound for unknown components. |
| Output is known, but usage is missing | Record the output and unknown usage. Retain the corresponding obligation. Continuation is permitted only while the remaining budget still covers it. |
| Harness prints a token/cost total | Retain as harness-reported diagnostics. It cannot establish complete billing coverage or release a reservation. |
| Observed usage exceeds the bound | Record the real receipt and overrun, then stop further dispatch. |
| Provider completion is ambiguous | Retain the obligation and suspend execution, regardless of remaining budget. |

Partial settlement must not count expenditure twice. For each component, measured usage replaces its reserved component; an unknown component retains its remaining upper-bound obligation.

If future harness profiles permit multiple upstream requests, each request will require its own durable authorization and accounting identity. A CLI’s final aggregate cannot replace those records. Release 1 rejects such profiles.

Recovery uses the existing lifecycle:

| Interruption point | Recovery |
|---|---|
| Authorized harness launch, no upstream authorization | Reconcile the gateway’s durable record. If it proves no upstream dispatch was authorized, revoke the old capability, terminate the old process tree, and restart local preparation under a new epoch. |
| Upstream dispatch authorized, no durable outcome | Potentially performed. Query only through a verified provider recovery contract; otherwise suspend and retain the reservation. |
| Provider response durably captured, harness output incomplete | Settle supported usage. Recover output only if the pinned decoder can deterministically reconstruct it from retained bytes; otherwise preserve the incomplete generation. |
| Complete harness return durably captured | Finish settlement and continuation from recorded bytes. Do not launch the CLI again. |
| Result already consumed | Restore the committed continuation and advance past it. |
| Late response or receipt | Append permitted reconciliation. It cannot deliver a second result or move a consumed cursor. |

The gateway durably spools complete provider responses before making their completion available to the harness. The supervisor likewise retains the decoded harness return before delivering it to `step()`.

Cancellation first revokes permission for further dispatch, then terminates the confined process tree. It does not prove that an already forwarded request stopped or became free.

Native `resume`, `continue`, and session IDs are never recovery authority. A transcript identifier is not a provider idempotency key. An explicitly authorized retry without a verified deduplication contract creates a new effect and reservation; the predecessor remains visible.

**Extend §§4 and 6: bindings and authoritative fields**

Keep model and harness selection separate. `[models.actor]` identifies the scientific model assignment; its `harness` field references a shared launcher/profile binding. This avoids duplicating executable and confinement settings across actor and refiner roles.

Add or replace these manifest fragments:

```toml
[models.actor]
provider = "openai"
model = "gpt-5.6-luna"
harness = "opencode"
request_options = "sha256:<actor-request-settings>"
max_input_tokens = 16384
max_output_tokens = 2048
fallback = "forbid"

[models.refiner]
provider = "openai"
model = "gpt-5.6-luna"
harness = "opencode"
request_options = "sha256:<refiner-request-settings>"
max_input_tokens = 32768
max_output_tokens = 8192
fallback = "forbid"

[models.user]
provider = "openai"
model = "gpt-5.6-luna"
request_options = "sha256:<benchmark-user-request-settings>"
max_input_tokens = 16384
max_output_tokens = 1024
fallback = "forbid"

[harnesses.opencode]
interface = "strive.harness/1"
backend = "opencode"
adapter = "sha256:<adapter-code-and-descriptor>"
executable = "sha256:<executable-and-runtime-closure>"
version = "1.17.18"
level = "model"
launch_profile = "sha256:<arguments-config-environment-and-decoder>"
sandbox_profile = "sha256:<enforced-process-tree-confinement>"
model_transport = "broker_gateway"
native_tools = "none"
session_policy = "fresh"
max_provider_requests = 1
deadline_seconds = 180

[pins]
# Retain the existing pins; add this explicit shared boundary pin.
model_gateway = "sha256:<gateway-provider-protocols-and-bound-methods>"

[recovery."model.generate"]
strategy = "suspend_if_ambiguous"
native_session_resume = false
automatic_redispatch = false
unknown_usage = "retain_reservation"

[recovery."benchmark.tool"]
strategy = "reconcile"
require_operation_lookup = true

[budget]
# Retain explicit funded numeric limits.
price_schedule = "sha256:<dated-account-specific-price-schedule>"
includes = [
  "acting",
  "refinement",
  "user_simulation",
  "dev_evaluation",
  "validation",
  "audit",
  "retries",
  "adapter_acceptance"
]
```

Omitting `harness`, as in `[models.user]`, selects the existing direct trusted provider adapter. The benchmark user simulator has its own role, request settings, evidence scope, and expenditure attribution.

All enabled cost-bearing phases remain chargeable regardless of the list. The campaign wrapper assigns separate development and audit allocations.

Additional schema rules:

- `harness` must resolve to a retained adapter and executable closure. A version string alone is insufficient.
- Release 1 requires `level="model"`, `native_tools="none"`, `session_policy="fresh"`, and `max_provider_requests=1`.
- The launch profile includes every effective nonsecret setting that can affect behavior. Resume rejects changed executable bytes or ambient configuration.
- Provider endpoint, account binding, protocol, prices, and bound method resolve before dispatch.
- Changing the harness, provider route, model assignment, or confinement profile requires a new run.
- Seed support is recorded separately for the harness and provider. An unsupported seed does not become a reproducibility claim.

Extend the existing authoritative record groups without introducing harness-specific event families:

| Record group | Additional fields |
|---|---|
| Run binding | Harness binding/descriptor, executable closure, launch and sandbox profiles, gateway identity, integration level. |
| Effect authorization | Harness binding reference, generation envelope, input references, dispatch stage, actual provider-request reference before upstream forwarding. |
| Effect observation | Process outcome, raw/decoded output references, provider request ID, requested/wire/observed model identities, identity provenance, usage completeness, and gateway reconciliation references. |
| Measurement | Benchmark upstream revision, split/grouping identity, episode and trajectory identity, reset boundary, and exact reward definition. |

Model identity has three distinct values:

1. **Requested:** the manifest’s provider and model, plus the harness-native identifier such as `openai/gpt-5.6-luna`.
2. **Wire:** the provider endpoint and model actually dispatched by the gateway.
3. **Observed:** the model identifier or revision returned by the provider, with its original field and provenance.

A harness echoing `--model` does not establish observed identity. Missing observed identity remains unknown. An alias does not become an immutable model revision. Unexpected identities are retained, further dispatch suspends, and affected comparisons cannot silently retain a matched-model claim.

**Release backends and acceptance**

These are release requirements, not claims that the integrations are implemented or qualified today.

| Backend | Release decision | Binding |
|---|---|---|
| **opencode 1.17.18** | Primary reference implementation; ships in release 1. | Headline actor and refiner use `openai/gpt-5.6-luna`. |
| **codex 0.153.4** | Second reference implementation; ships in release 1. | `gpt-6-astra` is available for funded integration smoke tests, using the verified environment fact. It is not the headline experiment subject. |
| **Claude Code 2.1.263** | Third conforming adapter; ships in release 1. | A resolved Anthropic model available through the supplied account. No exact model is invented here. |
| **pi** | Interface-ready only. | Not installed, not tested, and not claimed as a release-1 integration. |

Codex’s documented custom-provider configuration and Claude Code’s noninteractive tool controls provide implementation hooks. They do not replace the outer gateway or sandbox. In particular, Claude’s built-in tool restriction must also be accompanied by removal of MCP access. [Official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

Pi later supplies the same descriptor, preparation, invocation, decoding, and reconciliation methods. Its documented tool-disabling controls are useful starting points, but it must pass the same qualification suite. [Pi coding-agent documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)

The acceptance test for a second harness is concrete:

- Freeze the core after the opencode adapter passes.
- Add codex through an adapter package, retained profile, and manifest binding only.
- Run identical recorded provider fixtures through both adapters. Verify equivalent typed proposals, accounting, continuation, and recovery.
- Exercise extra hidden requests, malformed output, missing usage, model mismatch, process crashes, stale results, forbidden file/network access, and attempted tool execution.
- Complete a funded live smoke test for each backend using an actually available model.
- Verify that the second integration changed no supervisor, ledger, verifier, command schema, workload adapter, or policy code.

A common model is unnecessary for protocol conformance. Comparing scientific performance across harnesses requires a separate matched study with the harness difference declared.

**Replace §9.4 with the following text**

The reference workload is **the published τ²-bench telecom text task set**, imported from a retained September 2026 revision of `sierra-research/tau2-bench`. Telecom includes a shared environment in which the service agent and simulated user control different tools and state. This directly exercises stateful tool use, communication, and recovery. [τ²-bench paper](https://arxiv.org/abs/2506.07982)

The maintained repository now also contains τ³ additions and task corrections. Strive pins the upstream commit, task bytes, policies, environment code, dependency closure, and evaluator. It identifies the imported telecom text track explicitly and never resolves “latest” on resume. [Maintained benchmark repository](https://github.com/sierra-research/tau2-bench)

The benchmark environment remains trusted workload infrastructure. Candidate actors cannot modify its implementation, task definitions, user scenarios, or scorer. Strive replaces upstream scheduling and model dispatch with its own operation/effect boundary while preserving the selected tasks’ environment behavior and reward criteria.

The operation adapter exposes episode initialization, agent tool calls, user tool calls, message delivery, termination, snapshots, and operation lookup. Every state-changing operation atomically records its effect ID, argument digest, resulting state, and receipt. Repeating an ID with different arguments fails. Snapshots retain both agent-side and user-side state, conversation position, and environment randomness.

The trusted scorer evaluates the actual committed environment and broker-captured interaction history. It preserves each admitted task’s declared deterministic `reward_basis`, including database checks, environment assertions, and deterministic communication checks where specified. It does not replace required criteria with easier checks or use an LLM judge to certify headline success. Import qualification rejects a headline task set requiring unavailable or nondeterministic grading. [Upstream evaluation contract](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)

The first campaign uses the 114-task telecom base pool, whose published split contains 74 training tasks and 40 test tasks. Amendment 3 supersedes the original stock-based allocation: select all 114 base tasks, derive our own whole-scenario development/validation/audit split, target 60/14/40, and retain the actual 49/29/36 allocation. The split, grouping checks, ordering, and access grants are frozen before campaign execution. [Published telecom splits](https://github.com/sierra-research/tau2-bench/blob/main/data/tau2/domains/telecom/split_tasks.json)

This is a continual-adaptation study over published benchmark episodes. Environment state persists throughout each episode and resets at the next task’s published initial state. Actor revisions and explicitly authorized learned memory persist across development episodes. The study does not claim a benchmark-native continuous world or direct comparability with an unmodified leaderboard protocol.

The actor and refiner both use **gpt-5.6-luna through opencode** for the reference campaign. The primary provider route is OpenAI. The simulated user uses a separately bound, brokered Luna generation with a fixed user policy. Its outputs influence the environment through validated user operations; its claims never establish success.

The verified Bedrock route and other models available through opencode are eligible for separately resolved runs. They are not automatic fallbacks. `gpt-6-astra` remains a design/driver model and optional integration-test binding. Harness choice, provider route, model settings, and observed identity are reported separately.

Release 1 includes opencode, codex, and Claude Code adapters under the harness-as-model contract. Pi is deferred. Ambiguous generations suspend unless the pinned provider contract supports stronger recovery.

The bespoke order simulator and sum/max fixtures remain deterministic controls for protocol testing. They are not the headline scientific workload.

**Update §7: benchmark rationale and reference campaign**

The workload choice follows these tradeoffs:

| Candidate | Decision |
|---|---|
| **τ-bench / τ²-bench** | Select the telecom text track. Its shared mutable environment exercises both agent and user operations. Retail and airline remain useful later extensions, but their task-level grading requirements must be inspected individually. |
| **SWE-bench Verified / Live** | Strong later software-engineering workloads with executable evaluation. Repository builds and test environments add substantial integration work before the first durability study. Live also requires freezing its changing task collection. [SWE-bench](https://www.swebench.com/SWE-bench/), [SWE-bench-Live](https://swe-bench-live.github.io/) |
| **Terminal-Bench** | Strong later test of broad tool execution. It introduces a larger terminal/environment boundary; current 4.0 instructions also require GPU-capable task infrastructure, which is not established on this host. [Official run instructions](https://www.tbench.ai/run) |
| **GAIA** | Useful for general assistant competence, but less directly targeted at recoverable mutations in a shared environment. [GAIA paper](https://arxiv.org/abs/2311.12983) |
| **EvoHarnessBench** | Closely aligned with continual adaptation. However, its project currently describes the local environment runner as unreleased. Hosted graders would prevent strive from owning the complete local scoring boundary required here. [Project and availability](https://mas-orchestra.salesforceresearch.ai/evoharness/) |

The Amendment 3 split procedure groups tasks by their underlying base template before assigning all three partitions. Persona and composed failure-condition variants stay with that root. Retain the grouping algorithm, seed/order, group-to-ID map, and final IDs. Validate inventory integrity and strictly qualify every selected headline task. Whole-group disjointness applies to our adaptive split; full-inventory overlap across stock train/test is informational.

For contract A, the fourteen validation tasks remain inaccessible to adaptation and candidate selection. They are available only to separately declared B development runs. The forty audit tasks remain embargoed until campaign freeze. Public task availability does not establish freedom from model pretraining contamination; A establishes campaign information-flow isolation.

Use this campaign:

| Item | Fixed design |
|---|---|
| Arms | Fixed initial actor versus actor adaptation; identical actor harness/model bindings and resource ceilings. |
| Paired repetitions | **8 independent trajectory pairs**, with matched task order, initial states, and user-simulator settings within each pair. |
| Development horizon | **180 episodes per trajectory:** three passes over the 60 development tasks, using predeclared shuffled orders and fresh episode state. |
| Adaptation | After episodes 20, 40, …, 160. At most eight refiner generations per adapting trajectory. |
| Forks | Disabled in the reference comparison. Retention is measured across repeated development exposures. |
| Selection | Freeze the final valid active actor from every trajectory. No selection of the best seed or checkpoint after inspecting audit results. |
| Audit | Both arms from every pair receive all **40 audit tasks**, each with **2 fresh user-simulator repetitions**. Actor bundles remain frozen. |
| Main workload size | **2,880 development episodes + 1,280 audit episodes = 4,160 episodes.** |
| Pilot | Up to 24 development-only episodes and four refinement generations, charged separately and completed before scientific configuration freeze. |

Each episode permits at most 100 actor generations, 100 user generations, and 400 benchmark transitions. Aggregate episode limits are **512,000 billable input tokens and 32,768 billable output tokens** across actor and user inference. Per-generation limits remain those in the manifest. These are admission ceilings, not expected consumption.

Normal benchmark termination, task failure, budget exhaustion, infrastructure failure, and unresolved execution are distinct outcomes. Hitting a limit does not remove an episode from planned coverage.

Paired user simulations receive matching settings and seeds where supported, but their conversations respond to each arm’s behavior. Do not force identical user transcripts across different agent actions or claim that a seed ensures identical model responses.

The primary development measure is cumulative benchmark successes over the 180-episode horizon, supplemented by pass rate by exposure, retention/regression, expenditure, and coverage. Audit reports success rate and the fraction of tasks succeeding in both repetitions. Audit episodes reset conversational state and writable task memory between tasks; only the frozen imported actor artifacts persist.

Use paired trajectories as the independent units for the adaptation comparison. Audit analysis must account for repeated task identities and multiple evaluations of each frozen bundle. Do not treat 1,280 audit episodes as 1,280 independent learned agents. Report intervals, unresolved-outcome bounds, and all stopped runs. Eight pairs support an initial useful study, not guaranteed power for small improvements.

The scorer must read trusted snapshots and captured interactions. Replaying broker-recorded actions in a separate scorer environment may cross-check state, but candidate-authored transcripts cannot replace the live authoritative state. Termination and scorer aggregation must preserve coverage rather than inheriting upstream exclusions that conceal infrastructure failures.

In adaptive Strive studies and their paired fixed controls, all user-simulator calls also cross `model.generate`. Their runtime must not invoke an upstream convenience runner that secretly performs inference, retries whole episodes, or drops failed simulations. Amendment 3's separate fixed-stock baseline explicitly uses upstream execution, retains its configuration and full results, and makes no Strive runtime-integrity or matched cross-mode claim.

**Extend §9.6: funded ceiling**

Let:

- `E` be the priced upper bound for one episode’s 512,000 input and 32,768 output tokens, including applicable cache premiums and request fees.
- `F` be the priced bound for one refinement generation’s 32,768 input and 8,192 output tokens.

The campaign allocation is:

```text
pilot:        24E + 4F
development:  8 × (2 × 180E + 8F) = 2,880E + 64F
audit:        8 × 2 × 40 × 2E     = 1,280E

total:        4,184E + 68F
```

These allocation envelopes do not create duplicate ledger reservations. The supervisor reserves each admitted effect from its phase allocation.

The provider adapter resolves `E` and `F` using dated, account-specific rates and supported billing bounds. Harness diagnostics cannot supply the price schedule. Reconciliation and acceptance-test expenses must also receive explicit allocations.

The pilot estimates expected cost, latency, and token-limit truncation. The conservative envelope establishes admission safety. A serial local host can retain the simulator and journals while hosted models perform inference; this is a multi-day campaign, with actual duration established by the pilot.

The human must supply the funded USD ceiling and protected audit allocation before paid execution. No dollar amount is inferred from model availability. If funding cannot cover the declared plan, revise and freeze the plan before the scientific campaign starts. Later exhaustion produces an incomplete study with full coverage reporting.

A provider overrun remains possible under the existing provider-trust assumptions. Record it and stop dispatch. Strive must not describe admission control as an unconditional guarantee about external invoicing.

**Precise remaining spec deltas**

| Section | Required change |
|---|---|
| Opening status | Replace “pending human go/no-go” with teardown authorized, subject to freezing this boundary amendment before implementation. This pass remains design-only. |
| **§2** | Preserve all five guarantees verbatim. Add the harness enforcement interpretation above. |
| **§3 architecture table** | Add harness preparation/decoding to pinned adapters; explicitly assign gateway dispatch, confinement, and accounting to the supervisor/broker. |
| **§3.1** | Insert the two integration levels, interface, and unchanged `step()` mapping. |
| **§3.3** | Add process-launch versus upstream-dispatch stages, durable gateway spooling, native-session prohibition, and the recovery table. |
| **§3.4** | Add whole-generation bounds, single-request admission, partial-usage obligations, and rejection of unbounded harness profiles. |
| **§4** | Extend the existing field groups as listed. Harness logs remain annotations. |
| **§6.1–6.2** | Add retained harness bindings, gateway pin, model identity provenance, user-model role, and recovery fields. Replace order-specific workload and policy parameters with task/episode parameters. |
| **§6.3** | Change the example to `strive run tau2-telecom.toml --id actor-17`. Commands otherwise retain their contracts. |
| **§7.1–7.2** | Replace order streams and fulfilment metrics with the paired episode campaign and benchmark-success metrics above. |
| **§7.4–7.5** | Include user/device state in snapshots; enforce Amendment 3 whole-base-scenario assignment, report actual sizes against the 60/14/40 target, freeze selection, and keep separate audit sessions/caches. |
| **§7.6** | Retain harness configuration, actual provider requests, benchmark revision, user-simulator observations, and both sides of environment state. |
| **§8.1–8.3** | Show harness identity and launch spans; attribute model cost once. Distinguish supplied context from actual provider requests and requested identity from observed identity. Release 1 ships only the Langfuse profile over vendor-neutral OTLP GenAI 1.41.0; LangSmith/Phoenix mappings are deferred until needed. |
| **§9.4** | Replace in full with the supplied text. |
| **§9.5** | Explicitly include the entire harness process tree in confinement assumptions. Trusted-host scope remains unchanged. |
| **§9.6** | Add the campaign and allocation formula. Positive improvement remains unnecessary for release. |
| **§10.1** | Replace headline order simulation with the tau adapter. Add three bounded harness adapters; defer pi and executor-owned loops. |
| **§11** | Remove go/no-go and general provider-choice questions. Retain funded ceiling/audit allocation and resolution of account-specific prices and exact available test-model identifiers. |

Insert a new milestone immediately after the effects/accounting/confinement milestone:

> **Qualify replaceable harnesses.** Implement `strive.harness/1`, the model gateway, retained launch profiles, and opencode/codex/Claude Code adapters. Exit requires a second harness added without core changes, blocked hidden requests and tool access, honest missing-usage handling, durable request capture, and fault recovery across every dispatch stage.

Change the stateful-operation milestone to require tau agent/user operations, transactional receipts, snapshots, scorer equivalence against upstream deterministic fixtures, complete task/split qualification, and crash-after-mutation recovery.

The final study remains a release gate under a funded ceiling. This design pass establishes the contract; it does not claim that installed CLI versions have passed confinement tests or that the complete benchmark import has already been qualified.

---

# AMENDMENT 2 — General BenchmarkAdapter interface & τ²-bench telecom (M5) — GPT‑6 Astra

*Authored by GPT‑6 Astra via `codex exec -m gpt-6-astra` (read-only research+design
pass) after the human directed that Milestone 5 be built around a GENERAL
benchmark-adapter interface (mirroring HAL's benchmark contract and Inspect's
Dataset/Task/Solver/Scorer) with τ²-bench telecom as the first concrete
implementation — sourced as a pinned git dependency, not vendored/submoduled.
Human approved (2026‑09‑09): the plan; two generic runtime changes (dynamic
scoped admission; suspended operator-only bundle restoration); a bounded direct
user-model adapter for the τ² user simulator's structured tool calls; and
task-qualification as a hard stop-gate. Supersedes §9.4/§10 M5 and refines §§3,4,
6,7 where named. τ²-bench pinned at commit a2c024725189473d2d7cea3a5cfdbcc67478e41f
(distribution `tau2` 1.0.1, MIT, Sierra Research).*

# Milestone 5: general benchmark adapters and trusted episode measurement

**Design for approval · 9 September 2026 · No implementation or file changes**

Milestone 5 should introduce `strive.benchmark/1`, a general interface for task discovery, episode operations, recovery, and trusted scoring. The first implementation is the published τ²-bench telecom text workload, supplied as a pinned dependency. Benchmark semantics belong behind this interface; the supervisor, broker, ledger, and verifier must not learn telecom concepts.

Two existing runtime restrictions need explicit treatment during M5: admission currently requires prelisted argument hashes, and bundle restoration currently rejects unresolved effects. Both are general runtime issues. Resolve them before freezing the core for the second-benchmark acceptance test.

## 1. τ²-bench: verified current interface

### Revision and research boundary

Use this exact upstream commit for the proposed dependency:

```text
repository: https://github.com/sierra-research/tau2-bench
commit:     a2c024725189473d2d7cea3a5cfdbcc67478e41f
track:      telecom, text, half-duplex, solo_mode=False
```

The commit exists upstream. Its package metadata declares distribution `tau2`, version `1.0.1`. This is an inspected revision selected for M5, not a floating promise to use September’s latest `main`. The maintained repository now advertises τ³ additions, including voice and knowledge evaluation. Therefore, identifying the workload merely as “tau2-bench” is insufficient. [Selected commit](https://github.com/sierra-research/tau2-bench/commit/a2c024725189473d2d7cea3a5cfdbcc67478e41f), [pinned package metadata](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/pyproject.toml), [current repository](https://github.com/sierra-research/tau2-bench).

**Verification limit:** this pass inspected upstream interfaces, evaluators, the telecom task generator, and published split definitions, but could not retrieve and enumerate the complete task JSON. Consequently, it does not certify the exact reward-basis histogram, absence of malformed tasks, or duplicate-scenario relationships across all task records. Those are mandatory import-qualification gates below. No exclusion count or task-data digest is invented.

### How a third party supplies its own agent

The current text-agent interface is `HalfDuplexAgent[StateType]`. Its constructor receives environment tools and domain policy. Implementations provide:

```python
get_init_state(message_history: list[Message] | None = None) -> StateType

generate_next_message(
    message: ValidAgentInputMessage,
    state: StateType,
) -> tuple[AssistantMessage, StateType]
```

The documented input union includes user messages, individual tool results, and multiple tool results. A factory receives `tools`, `domain_policy`, and configuration arguments; registering that factory gives it a name selectable through `tau2 run --agent NAME --domain telecom`. LLM configuration is optional through `LLMConfigMixin`; supplying one’s own agent does not mean replacing only the model name. [Agent developer guide](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/agent/README.md), [pinned agent classes](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/agent/base_agent.py).

Strive should preserve this interaction model through a compatibility wrapper, but continue running candidate behavior through its existing bounded `step()` interface. It must not execute a candidate-supplied Python agent inside the trusted benchmark process. Nor should it expose the complete upstream `Task` object merely because an upstream factory can receive one.

### Environment and dual control

Upstream domains supply database models, toolkits, policies, environment constructors, task loaders, and split loaders. Telecom specifically combines:

- `TelecomDB` and `TelecomTools` for service-side state and operations.
- `TelecomUserDB` and `TelecomUserTools` for device state and surroundings.
- `TelecomEnvironment.sync_tools()` for interactions between them.

Examples of synchronization include line activation, roaming permission, data allowance, and payment state. These are coupled views of one episode, not independent agent and user simulations. [Domain structure](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/domains/README.md), [telecom environment](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/domains/telecom/environment.py).

The tool execution path matters. `make_tool_call()` explicitly does not synchronize; `get_response()` invokes the tool, synchronizes, and produces a `ToolMessage`, including errors. Strive must wrap the established execution path and preserve its sequencing. Calling toolkit methods directly would omit benchmark behavior. [Environment implementation](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/environment/environment.py).

The paper models this as a shared dual-control environment and describes the simulator’s observations and actions as constrained by tools and state. Its original telecom evaluation uses state assertions. [Paper, environment and task evaluation](https://arxiv.org/html/2506.07982v1#S3).

### User simulator

`UserSimulator` is an LLM-backed half-duplex participant with explicit `UserState`. It constructs its prompt from global simulation guidelines, scenario instructions, and persona configuration. Its generation path appends the incoming message, flips conversational roles, passes user tools to generation, and converts the response into a `UserMessage`. Stop detection recognizes the configured stop, transfer, and out-of-scope markers in non-tool messages. [Pinned user simulator](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/user/user_simulator.py).

For strive, user inference is an independently charged `model.generate` effect. User tool execution follows as separate benchmark effects. Simulator prose cannot establish environmental facts or reward.

A deterministic scorer does **not** make the experiment deterministic. User-model responses can vary; their exact requests, responses, settings, and supported seeds must be retained.

### Exact reward behavior

For an ordinarily terminated simulation, the combined evaluator multiplies the components selected by the task’s `evaluation_criteria.reward_basis`. `EvaluationType.ALL` respects that basis and invokes NL grading if the basis requires it. `ALL_WITH_NL_ASSERTIONS` can invoke NL grading even when it does not affect the final reward. Neither option should be selected blindly. [Pinned combined evaluator](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/evaluator/evaluator.py).

| Component | Implemented semantics | Headline eligibility |
|---|---|---|
| `DB` | Construct a gold environment from task initialization and reference actions; compare **both agent and user database hashes** with the predicted environment. A different action sequence can pass. | Deterministic, subject to qualified environment behavior. |
| `ENV_ASSERTION` | Invoke the task’s assertion functions against the predicted environment; each result must match its declared Boolean expectation. All selected assertions must pass. | Deterministic, subject to qualification of the invoked functions. |
| `COMMUNICATE` | Every required string must occur in an assistant text message. The implementation lowercases both sides and removes commas from message content. | Deterministic. |
| `ACTION` | Every expected action must match some recorded tool call. This is a membership check, not exact ordered-trajectory equality. | Deterministic. |
| `NL_ASSERTION` | An LLM evaluates natural-language assertions about the trajectory. | Ineligible for headline scoring. |

Sources: [environment evaluator](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/evaluator/evaluator_env.py), [communication evaluator](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/evaluator/evaluator_communicate.py), [action evaluator](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/evaluator/evaluator_action.py), [NL evaluator](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/evaluator/evaluator_nl_assertions.py).

Preserve `Action.compare_with_tool_call()` exactly, including its quirks. It compares the tool name and selected arguments; `compare_args=[]` accepts any arguments for that name. When `compare_args` is absent, the implementation selects the predicted call’s argument keys. It does not itself compare requestor identity. Strive must enforce requestor authorization separately without silently changing the benchmark’s action metric. [Pinned action comparison](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/data_model/tasks.py).

The combined evaluator returns zero for termination reasons other than `AGENT_STOP` or `USER_STOP`. It also returns one when evaluation criteria are absent. Strive should preserve known premature-termination scoring, but reject missing criteria during headline-task qualification rather than admitting vacuous success. Infrastructure uncertainty remains separately reported. [Combined evaluator](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/evaluator/evaluator.py).

**There is a material upstream documentation discrepancy.** The evaluation guide says telecom uses `DB + COMMUNICATE` and never `ACTION`. The pinned telecom generator instead initializes `reward_basis` to `["ENV_ASSERTION"]` and adds `ACTION` for expected-failure tasks requiring transfer. It never adds `NL_ASSERTION` in that generation path. Trust the task bytes and executable evaluator over the guide’s domain-wide summary. [Evaluation guide](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md), [pinned telecom generator](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/domains/telecom/tasks/manager.py).

The defensible conclusion is that the published telecom generation path uses deterministic grading and provides no evidence of required LLM grading. A complete zero-NL certification still requires scanning the actual imported records. M5 must reject any task requiring `NL_ASSERTION`, unknown grading components, or nondeterministic assertion functions. It must never remove a required component to make a task eligible.

### Packaging, data, and license

The distribution and import package are `tau2`; the console entry point is `tau2 = tau2.cli:main`. The inspected package requires Python `>=3.12,<3.14` and uses Hatchling. Its core dependencies include LiteLLM `>=1.80.15,<1.82.7`, pandas, NumPy, FastAPI, Uvicorn, HTTPX, Requests, Tenacity, DeepDiff, and configuration/logging libraries. Voice, knowledge, gym, and development dependencies are optional extras. [Pinned `pyproject.toml`](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/pyproject.toml).

LiteLLM brings additional model-client dependencies. For example, version `1.80.15`, within tau’s declared range, requires `openai>=2.8.0`, Pydantic, tokenizers, and tiktoken. An exact transitive environment must therefore be locked rather than inferred from tau’s Git revision. [Published LiteLLM dependency metadata](https://pypi.org/pypi/litellm/1.80.15/json).

Current upstream installation instructions use a Git checkout followed by `uv sync`. Non-editable installation requires an explicit `TAU2_DATA_DIR`; package installation alone must not be assumed to provide discoverable task data. The CLI includes `tau2 run`, `tau2 check-data`, and domain inspection. [Installation guide](https://github.com/sierra-research/tau2-bench/blob/main/docs/getting-started.md).

Task and split definitions are located at:

```text
data/tau2/domains/telecom/tasks.json
data/tau2/domains/telecom/split_tasks.json
```

The split file declares `base`, `train`, `test`, and additional pools. The published `base` has 114 IDs, with 74 training IDs and 40 test IDs. Those split definitions do not, by themselves, prove that every ID resolves to a valid task record. [Telecom split file](https://github.com/sierra-research/tau2-bench/blob/main/data/tau2/domains/telecom/split_tasks.json).

The repository license is MIT, copyright Sierra Research. Retain its copyright and permission notice with redistributed upstream material. [LICENSE](https://github.com/sierra-research/tau2-bench/blob/main/LICENSE).

## 2. The SOTA mirror

| Reference | Structure worth borrowing | Strive’s additional requirement |
|---|---|---|
| HAL | A benchmark owns task data, `evaluate_output()`, and metric extraction. The agent exposes `run(input, **kwargs)` returning submissions keyed by task ID. | Split interaction into durable effects; authenticate facts and scoring producers; retain uncertainty and expenditure. |
| Inspect | A `Task` combines a dataset, solver, and scorer. Solver execution and scoring are separate interfaces. | Candidate solvers cannot acquire scorer authority, protected targets, or arbitrary external access. |
| Both | Benchmark-specific logic stays behind an explicit interface. Agent implementations remain replaceable. | Recovery contracts, committed environment state, scoped evidence, and independently owned measurements are mandatory. |

Sources: [HAL benchmark contract](https://github.com/princeton-pli/hal-harness/tree/main/hal/benchmarks), [HAL agent contract](https://github.com/princeton-pli/hal-harness/blob/main/agents/README.md), [Inspect tasks](https://inspect.aisi.org.uk/tasks.html), [Inspect solvers](https://inspect.aisi.org.uk/solvers.html).

HAL is a useful architectural precedent, but its repository was archived in July 2026 and is no longer accepting leaderboard updates through that harness. Borrow its separation of responsibilities rather than adding it as a runtime dependency. [HAL status](https://github.com/princeton-pli/hal-harness).

Strive should also avoid treating every score emitted during solver execution as authoritative. Inspect explicitly permits solver-provided scores and intermediate scoring; strive’s headline measurements must originate exclusively from its pinned trusted scorer. [Inspect solver scoring](https://inspect.aisi.org.uk/solvers.html).

## 3. General `BenchmarkAdapter` interface

### Ownership and placement

Introduce these implementation areas:

```text
strive.vnext.benchmarks.api          dependency-light adapter interfaces
strive.vnext.benchmarks.bridge       existing EffectAdapter integration
strive.vnext.benchmarks.episodes     trusted episode scheduling and projections
strive_benchmark_tau2                separately installed implementation
```

These are proposed paths, not files created by this pass.

The adapter interface is not part of the frozen authority wire schema. Adapter payloads use versioned canonical bytes behind existing `ArtifactRef` fields. Do not add benchmark classes to `codec._MODULES`, dynamically import classes named by stored data, or add telecom event families.

### Typed contract

The following declarations specify the interface. Supporting records contain only explicit types and immutable values; upstream objects and `Any` do not cross it.

```python
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

from strive.vnext.contracts.lifecycle import RecoveryContract
from strive.vnext.contracts.primitives import (
    ArtifactRef,
    EffectId,
    EnvironmentId,
    EpisodeId,
    ResultCursor,
)
from strive.vnext.contracts.records import EffectAuthorization


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    scenario_group: str
    definition: ArtifactRef
    reward_definition: ArtifactRef


@dataclass(frozen=True)
class SplitSpec:
    name: str
    task_ids: tuple[str, ...]
    grouping_definition: ArtifactRef


@dataclass(frozen=True)
class OperationSpec:
    name: str
    argument_schema: ArtifactRef
    result_schema: ArtifactRef
    recovery: RecoveryContract


@dataclass(frozen=True)
class BenchmarkDescriptor:
    protocol: Literal["strive.benchmark/1"]
    workload: ArtifactRef
    implementation: ArtifactRef
    upstream_revision: str
    closure: ArtifactRef
    scorer: ArtifactRef
    operations: tuple[OperationSpec, ...]
    has_user_simulator: bool
    supports_forks: bool


@dataclass(frozen=True)
class EpisodeSnapshot:
    episode: EpisodeId
    environment: EnvironmentId
    version: int
    state: ArtifactRef


@dataclass(frozen=True)
class OperationContext:
    authorization: EffectAuthorization
    episode: EpisodeId
    arguments: ArtifactRef
    expected_snapshot: EpisodeSnapshot | None


@dataclass(frozen=True)
class ToolInvocation:
    call_id: str
    name: str
    arguments: ArtifactRef


@dataclass(frozen=True)
class CapturedGeneration:
    result_cursor: ResultCursor
    request: ArtifactRef
    response: ArtifactRef


@dataclass(frozen=True)
class UserTurnPlan:
    snapshot: EpisodeSnapshot
    generation_input: ArtifactRef
    response_schema: ArtifactRef


@dataclass(frozen=True)
class OperationReceipt:
    effect_id: EffectId
    original_epoch: int
    exact_request: ArtifactRef
    arguments: ArtifactRef
    before: EpisodeSnapshot | None
    after: EpisodeSnapshot
    output: ArtifactRef
    evidence: ArtifactRef


@dataclass(frozen=True)
class FoundOperation:
    receipt: OperationReceipt


@dataclass(frozen=True)
class ProvenAbsent:
    proof: ArtifactRef


@dataclass(frozen=True)
class UnknownOperation:
    reason: ArtifactRef


type LookupResult = FoundOperation | ProvenAbsent | UnknownOperation


@dataclass(frozen=True)
class ScoringInput:
    task: TaskSpec
    final_snapshot: EpisodeSnapshot
    captured_interaction: ArtifactRef
    operation_receipts: tuple[ArtifactRef, ...]
    termination: ArtifactRef


@dataclass(frozen=True)
class Metric:
    identity: ArtifactRef
    value: Decimal


@dataclass(frozen=True)
class RewardResult:
    status: Literal["scored", "unresolved", "invalid"]
    metrics: tuple[Metric, ...]
    exact_reward_definition: ArtifactRef
    evidence: tuple[ArtifactRef, ...]


class TrustedScorer(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...

    def score(self, inputs: ScoringInput) -> RewardResult: ...


class BenchmarkAdapter(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...

    @property
    def scorer(self) -> TrustedScorer: ...

    def describe(self) -> BenchmarkDescriptor: ...

    def enumerate_tasks(self) -> tuple[TaskSpec, ...]: ...

    def declare_splits(self) -> tuple[SplitSpec, ...]: ...

    def initialize(
        self,
        context: OperationContext,
        task: TaskSpec,
        initialization: ArtifactRef,
    ) -> OperationReceipt: ...

    def agent_tool(
        self,
        context: OperationContext,
        call: ToolInvocation,
    ) -> OperationReceipt: ...

    def plan_user_turn(
        self,
        snapshot: EpisodeSnapshot,
        delivered_message: ArtifactRef,
    ) -> UserTurnPlan | None: ...

    def user_turn(
        self,
        context: OperationContext,
        plan: UserTurnPlan,
        generation: CapturedGeneration,
    ) -> OperationReceipt: ...

    def user_tool(
        self,
        context: OperationContext,
        call: ToolInvocation,
    ) -> OperationReceipt: ...

    def deliver_message(
        self,
        context: OperationContext,
        message: ArtifactRef,
    ) -> OperationReceipt: ...

    def terminate(
        self,
        context: OperationContext,
        termination: ArtifactRef,
    ) -> OperationReceipt: ...

    def snapshot(
        self,
        context: OperationContext,
    ) -> OperationReceipt: ...

    def lookup_operation(
        self,
        episode: EpisodeId,
        effect_id: EffectId,
        exact_request: ArtifactRef,
    ) -> LookupResult: ...

    def open_committed_snapshot(
        self,
        snapshot: EpisodeSnapshot,
    ) -> None: ...
```

`OperationContext` is constructed by the trusted bridge from the actual authorization and retained request. The bridge checks that typed method arguments encode to the authorized argument bytes. A candidate cannot supply an authoritative context.

`open_committed_snapshot()` reconstructs a worker from verified committed state. It cannot move an existing environment backward. Fork initialization requires a new environment identity and an explicitly authorized snapshot origin.

Benchmarks without users advertise `has_user_simulator=False`; `plan_user_turn()` returns `None`, and user operations fail admission. Unsupported fork or recovery behavior must be declared rather than simulated.

### Mapping onto existing effects

`BenchmarkEffectAdapter` implements the existing `runtime.broker.EffectAdapter`:

| Existing method or field | Benchmark integration |
|---|---|
| `prepare()` | Validate operation, arguments, scope, expected state, limits, and recovery contract; establish a bounded reservation. |
| `invoke()` | Dispatch one authorized adapter operation and translate its durable receipt. |
| `reconcile()` | Call `lookup_operation()`, validate evidence, and reattest the original result under the current epoch. |
| `Receipt.output` | Candidate-visible result projection only. |
| `Receipt.evidence` | Trusted operation receipt, including request identity and state transition. |
| `Receipt.environment` | Resulting committed snapshot reference. |
| `validate_upstream()` | Reject network forwarding for local benchmark operations. User inference belongs to its model adapter. |

Source for the existing seam: [broker.py](/Users/nikhil/personal/hatch/strive/src/strive/vnext/runtime/broker.py).

There must be no hidden model call inside a benchmark mutation:

```text
deliver agent message
  → prepare user generation from committed state
  → model.generate, role=user
  → commit captured user response
  → execute requested user tools through the broker
  → deliver resulting observations
```

Each arrow that performs an operation has its own effect identity and durable result. The episode driver persists the pending batch and cursor, so restarting halfway through several tool calls does not repeat completed calls or solicit another model response.

The upstream user simulator requests structured tool calls. M4’s current text-only `ProviderContract` rejects nonempty tool arrays. M5 therefore needs a separate bounded **direct user-model adapter** that returns tool proposals as data through `model.generate`. It must reuse the authorization, gateway capture, reservation, and reconciliation discipline. It must not enable native tool execution inside the actor/refiner harnesses or silently replace the upstream user protocol with a new prose parser. [Current provider restrictions](/Users/nikhil/personal/hatch/strive/src/strive/vnext/harness/provider.py).

### Trusted state, transactions, and recovery

Every operation receipt binds:

- Run, episode, environment, adapter identity, effect ID, and original execution epoch.
- Exact request reference and argument digest.
- Expected previous snapshot and resulting snapshot.
- Returned observation, including benchmark tool errors.
- Interaction position and any simulator continuation changes.

Use an adapter-owned transactional store. For telecom, a suitable implementation is a local SQLite database with durable transactions, containing both operation records and environment-head references. Publish referenced CAS objects durably first; then atomically commit the operation receipt and new head. A crash before the transaction leaves harmless unreferenced objects. A crash after it permits lookup of the original result even if strive never recorded the return.

Repeated identity with identical request bytes returns the original receipt. Repeated identity with different bytes fails without mutation. Request identity includes the episode and expected state, not just the tool’s argument dictionary.

Lookup distinguishes three cases:

1. **Found:** validate the complete identity, request digest, state chain, durable objects, and fencing evidence before accepting it.
2. **Proven absent:** retry the same operation only if the declared deduplication contract supports it.
3. **Unknown:** preserve uncertainty and reservations; suspend.

A missing row in an unavailable or incomplete store is not proof of nonexecution. Business-operation deduplication says nothing about model-provider billing.

“Verified lookup” means the trusted bridge verifies lookup evidence before issuing its receipt. The pure verifier checks the resulting authority records and references. It never imports telecom to reproduce the mutation.

### Snapshot contents

A telecom snapshot must retain both databases, simulator state, and scheduling state:

- Agent-side service database and user-side device/surroundings database.
- Agent-visible and user-visible message histories.
- User simulator system messages, persona configuration, and explicit state.
- Current speaker, pending message, tool-call batch, and delivery cursor.
- Episode counters, termination state, and environment random state.
- Task, policy, schemas, configuration, and dependency identities.

Candidate private state remains in the existing `ContinuationCommit`. A resumable checkpoint binds that continuation to the environment snapshot; copying the environment alone is insufficient.

Provider conversation state must be reconstructible from retained messages. No opaque upstream session is a substitute for a snapshot.

### Trusted scoring and Measurement

The scoring host, not candidate code, selects `ScoringInput` from verified history. It gives the scorer read-only state and captured interaction, then appends through the existing `TRUSTED_SCORER` producer port.

For telecom:

1. Load the actual final committed environment.
2. Apply the task’s deterministic criteria to that environment and broker-captured interaction.
3. Independently run upstream deterministic evaluation over the captured trajectory as an equivalence check.
4. Require replayed state to agree with committed state. Divergence is an infrastructure/scorer inconsistency, not permission to substitute a favorable score.

Assertions run on an isolated copy so evaluation cannot alter the live environment. Gold initialization or reference-action failures stop qualification; they must not disappear into upstream warning logs.

Populate the existing `Measurement` fields as follows:

| Fields | Source |
|---|---|
| `subject_run`, `subject_window`, `revision_references` | Verified episode execution and revision history. |
| `workload_identity`, `benchmark_upstream_revision` | Resolved benchmark descriptor and exact upstream commit. |
| `scorer_version`, `exact_reward_definition` | Pinned scorer implementation, task criteria, and selected evaluation mode. |
| `supporting_receipt_references`, `supporting_state_references` | Authenticated operation receipts, final state, and captured interaction. |
| Coverage fields | Trusted episode schedule and completion records. |
| `split_grouping_identity`, episode/trajectory identities, `reset_boundary` | Frozen study assignment and initialization receipt. |
| `metric_identity`, `metric_value` | Scorer result, using exact `Decimal` values. |

No new Measurement field is required. [Existing Measurement definition](/Users/nikhil/personal/hatch/strive/src/strive/vnext/contracts/records.py).

An unresolved episode has no fabricated success value. Report completed known scores, unresolved coverage, and separately identified lower/upper success bounds. Budget exhaustion remains in planned coverage. Candidate `Finish`, annotations, and statements such as `"success": true` do not certify reward.

### Trust boundary and later benchmarks

| Trusted, pinned workload infrastructure | Replaceable candidate behavior |
|---|---|
| Task/split definitions, policies, environment code, user-simulator policy, schemas, operation store, projection rules, scorer, and adapter dependencies. | Actor/controller code, permitted prompts, learned memory, model requests, proposed actions, and explicit private state. |

The candidate receives permitted observations and callable operation schemas. It receives no scorer port, reward definitions, general CAS reader, task-store access, or user-operation authority.

Later integrations fit the same contract:

- **SWE-bench:** tasks identify repositories and base revisions; environment state contains the worktree and execution environment; operations expose bounded file/terminal actions; final submissions identify patches. A trusted isolated grading process runs the pinned evaluation tests. [SWE-bench evaluation contract](https://www.swebench.com/SWE-bench/guides/evaluation/).
- **Terminal-Bench:** tasks identify instructions, environment configuration, and evaluation assets. Terminal operations and filesystem state use adapter-specific snapshot/recovery support. Harbor’s task format provides test scripts and reward outputs, but strive must obtain those outputs from its trusted grading environment, not a candidate-writable reward file. Admit only deterministically gradable tasks. [Harbor task and verifier format](https://www.harborframework.com/docs/tasks).

The interface does not promise automatic recovery of arbitrary shell side effects. An adapter may support snapshots only at quiescent boundaries and suspend after an unreconcilable command.

**Second-benchmark acceptance:** after the M5 general infrastructure is frozen, add a small genuine second benchmark fixture integration through a new adapter package, scorer, manifests, and tests only. Run discovery, initialization, operations, scoring, interrupted execution, and offline verification. The diff must contain no changes to supervisor, broker, ledger, verifier, frozen contracts, or the common episode driver. Merely selecting another telecom task is insufficient. A later full SWE-bench or Terminal-Bench integration must pass the same gate before its zero-core-change claim is accepted.

## 4. Sourcing and isolation plan

### Dependency pin

Use a separately resolved adapter-runtime project with an optional telecom extra:

```toml
[project.optional-dependencies]
telecom = [
  "tau2 @ git+https://github.com/sierra-research/tau2-bench@a2c024725189473d2d7cea3a5cfdbcc67478e41f"
]
```

The direct reference preserves the commit requirement for both uv and pip-compatible tooling. Lock and retain the complete adapter environment. Install no voice, knowledge, gym, or experiment extras for the reference text workload. uv also supports Git sources pinned through `rev`; neither approach should resolve a branch on resume. [uv dependency documentation](https://docs.astral.sh/uv/concepts/projects/dependencies/#git).

Keep this environment separate from strive’s verifier/runtime environment. A project-level optional extra alone does not provide isolation if everything is installed into one interpreter.

### Resolved-manifest closure

Before any episode dispatch, retain and hash:

1. Upstream source identity, source artifact, built wheel, and license notices.
2. Exact dependency artifacts, lockfile, Python runtime, platform, and build configuration.
3. Original task/split bytes and a canonical index of selected task records.
4. Base agent/user databases and every policy or guideline file actually loaded.
5. Tool schemas, environment/assertion implementation closure, and scorer implementation.
6. User-model binding, persona settings, stop rules, request codec, limits, and seed support.
7. Qualification report, grouping algorithm, final split IDs, episode order, and metric definitions.

Keep original task bytes for provenance and canonical parsed forms for stable comparison. Hashes without retained bytes are insufficient for offline reproduction.

Materialize data under an adapter-owned read-only directory and set `TAU2_DATA_DIR` explicitly. Resume uses this retained directory and closure; ambient `.env` files, source-tree fallbacks, newer package versions, or fresh task downloads cannot change the run.

### Verifier purity

Preserve and extend the existing guard:

```text
tests/vnext/fresh_probe.py::_PROGRAM.ImportGuard
tests/vnext/test_verifier_only.py::
    test_fresh_interpreter_verifier_is_read_only_and_candidate_free
```

The existing subprocess runs with `-I -B`, rejects heavy/candidate imports, checks loaded modules, and installs audit guards against writes and dispatch. [Fresh probe](/Users/nikhil/personal/hatch/strive/tests/vnext/fresh_probe.py), [purity test](/Users/nikhil/personal/hatch/strive/tests/vnext/test_verifier_only.py).

M5 must:

- Explicitly forbid `tau2`, the adapter distribution, benchmark runtime modules, and their heavy dependencies.
- Keep the `allowed_strive` list narrow; do not add benchmark modules.
- Add static import-boundary checks for `verify/*`, contracts, codec, and package initializers.
- Replay a completed benchmark history in a fresh interpreter without the adapter environment installed.
- Repeat with adapters installed but import-blocked, proving purity is architectural rather than accidental.
- Verify corrupted state/receipt references and opaque benchmark payloads without importing their decoders.

Benchmark discovery occurs only in the execution composition root. Verifier startup must not enumerate adapter entry points.

### License and vendoring

No vendored source file or Git submodule is necessary. Use the pinned dependency and retained, hashed data artifacts. Keep upstream code outside strive’s maintained source tree.

MIT permits copying and redistribution subject to preserving its notice. Retaining task data or wheels for reproducibility still constitutes retaining upstream material; include the upstream license alongside distributed artifact bundles and retain dependency notices. A hash alone does not satisfy either reproducibility or notice requirements. [Upstream MIT license](https://github.com/sierra-research/tau2-bench/blob/main/LICENSE).

## 5. Spec deltas and M5 build plan

### Required spec edits

| Section | Change |
|---|---|
| §3 operation/evidence row | Name `BenchmarkAdapter`, the trusted episode driver, transactional receipts, projections, and scorer ownership. |
| §3.3 | Define adapter lookup evidence, paired state/receipt commits, and the suspended operator-restoration exception below. |
| §4 | Document the existing Measurement mapping; retain the frozen record schema. |
| §6.1–6.2 | Add benchmark implementation/data/dependency closure, explicit data root, schemas, and qualification artifacts. |
| §7 | Retain the reference study; make its implementation consume generic tasks, episodes, splits, and metrics. Preserve A/B isolation and audit freeze. |
| §9.4 and Amendment 1 | Generalize to “BenchmarkAdapter interface; τ²-bench telecom text is implementation #1.” Correct the reward discussion to task-specific `reward_basis`. |
| §10 | M5 becomes “General benchmark adapters and trusted stateful operation.” Adaptation, research workflow, and funded evaluation follow it. |

Keep the frozen `ReferenceStudyPlan` as the telecom reference campaign, not as the universal benchmark schema.

### General runtime corrections required first

**Dynamic request admission.** `CapabilityBroker.prepare()` currently requires exact argument/input references from fixed sets, and `Supervisor.step()` similarly checks prelisted inputs. This cannot support arbitrary new model-produced tool arguments and observations. [Broker admission](/Users/nikhil/personal/hatch/strive/src/strive/vnext/runtime/broker.py), [supervisor input checks](/Users/nikhil/personal/hatch/strive/src/strive/vnext/runtime/supervisor.py).

Add a pinned generic admission policy that validates schema, destination, operation, bounds, current environment, and artifact provenance/access scope. Keep exact-hash grants available for fixtures. Never implement a wildcard CAS grant or treat a candidate-supplied scope label as proof of access. Retain the policy identity and exact accepted request through existing capability and authorization references.

**Restoration during unresolved execution.** The current supervisor rejects commands with unresolved effects, and `_activate()` requires all effects to be settled or consumed. Therefore the existing guarantee-4 probe cannot presently restore a bundle while a model outcome remains ambiguous. Missing usage after a known return is a different case. [Supervisor acceptance/restoration](/Users/nikhil/personal/hatch/strive/src/strive/vnext/runtime/supervisor.py), [activation rules](/Users/nikhil/personal/hatch/strive/src/strive/vnext/verify/engine.py).

Approve a narrow operator-only rule:

- The run remains suspended.
- Restore only a previously active compatible bundle.
- Do not migrate controller state, consume a pending result, replace a pending command, or dispatch work.
- Preserve all effect authorizations, their original executing bundles, environment state, and accounting.
- Retain the canonical `RestoreBundle` request through `RevisionActivation.activation_boundary`.
- Commit restoration atomically using the existing activation record.
- Reject ordinary candidate activation while effects remain unresolved.

This changes a general transition rule, not the record schema. It belongs in this approval, before the post-M5 core freeze.

### Build steps and exit evidence

| Step | Deliverable | Exit test |
|---|---|---|
| 1. Freeze the adapter seam | Typed interface, payload schemas, bridge, generic admission, and restoration rule. | Strict typing; unchanged authority schemas; malformed requests and forged artifact scopes rejected. |
| 2. Resolve upstream | Exact dependency, isolated environment, retained data and closure. | Offline resolution succeeds from retained artifacts; altered task, policy, scorer, or dependency bytes fail identity checks. |
| 3. Qualify inventory | Full task scan, reward histogram, assertion allowlist, split and grouping report. | Every selected ID resolves exactly once; no required NL/unknown component; all required fixtures and assertions execute without inference. |
| 4. Implement operation storage | Atomic environment-head and receipt transaction; fenced lookup. | Same ID/same request deduplicates; changed arguments fail; wrong episode, stale epoch, corrupt receipt, and missing state objects cannot reconcile. |
| 5. Implement telecom episodes | Initialization, both toolkits, delivery, user generation, termination, snapshots. | Recorded interactions match upstream ordering and observations; both databases and both participant states survive restart. |
| 6. Implement trusted scoring | Committed-state scorer and upstream equivalence checks. | Correct and failing deterministic fixtures agree with upstream; candidate success claims cannot alter scores or coverage. |
| 7. Close recovery probes | Real crash injection and operator restoration. | Crash-after-mutation reconciles once; unsupported model ambiguity remains reserved and suspended after restoration. |
| 8. Prove generality and purity | Second benchmark fixture integration and guarded offline replay. | No post-freeze core edits; verifier never imports adapters, models, or candidate code. |

Upstream supplies telecom domain tests and task verification logic. Select their deterministic cases explicitly; do not run a broad upstream test command that may initiate model calls. [Telecom tests](https://github.com/sierra-research/tau2-bench/tree/main/tests/test_domains/test_telecom), [task verification logic](https://raw.githubusercontent.com/sierra-research/tau2-bench/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/domains/telecom/tasks/manager.py).

### Split qualification under Amendment 3

Import the original inventory and stock split definitions. Confirm unique/resolvable IDs and the disjoint `base = train ∪ test` source relationship. Source metadata counts are retained, not a claim of scenario disjointness.

1. Derive one root per task directly from the generator's base scenario template. Strip persona and composed failure conditions; never connect groups through shared instructions, goals, initial state, or substrings.
2. In adaptive mode, select the entire base pool and assign every whole group to one of development, validation, or audit. Keep all three partitions nonempty when at least three groups exist, and deterministically minimize size deviations from 60/14/40. Retain actual counts and whether the target was achievable.
3. In fixed-stock mode, select all stock `test` IDs in published order and run only the initial actor. Apply no group-disjointness gate.
4. Hard-block any selected task requiring NL assertions, missing/unknown grading, an unreviewed assertion, or failed strict initialization/reference/assertion execution. Retain every failure ID; never filter the denominator to pass.
5. Hard-check our adaptive partition for complete coverage and whole-group disjointness, including `(dev ∪ val) ∩ audit` at the group level.
6. Retain both direct-root and legacy connected-group stock train/test overlap scans as informational diagnostics. They cannot block a qualified adaptive partition or fixed-stock result.

The pinned adaptive split is 49 development, 29 validation, and 36 audit tasks. Exact 60/14/40 is impossible with these roots. Contract A grants no validation feedback to adaptation. Audit definitions, grouping diagnostics, and task-level qualification output stay in protected preparation storage until the relevant release boundary.

### Scorer-equivalence cases

Use recorded fixtures and synthetic boundary cases covering:

- Successful and failed environment assertions.
- Failure caused only by incorrect user/device state.
- Equivalent final state reached through different actions.
- Required transfer/action checks, including `compare_args=[]`.
- Communication normalization and missing required communication.
- Premature termination and budget exhaustion.
- Tool errors with any resulting state preserved.
- Divergence between committed state and replayed state.
- Required NL grading rejected before episode admission.
- Forged success logs, forged tool-result transcripts, and candidate-written reward files.

Where telecom lacks a selected reward component, test that component with a clearly labeled synthetic contract fixture. Do not modify telecom’s metric to increase test coverage.

### Closing guarantees 4 and 2

The existing guarantee-4 test is:

```text
test_runtime_integrity_4_preserves_mutation_and_unresolved_obligation
scenario:
crash_after_mutation_then_restore_bundle_with_ambiguous_model_effect
```

Its M5 implementation must perform a real durable mutation, crash before strive records its receipt, reconcile it exactly once, then create an unreconcilable model dispatch. Restore the prior bundle through the approved operator path. Assert unchanged environment, unchanged positive reservation, unchanged pending effect identity, no retry, and continued suspension. Exercise both agent and user mutations. [Current acceptance probes](/Users/nikhil/personal/hatch/strive/tests/vnext/test_acceptance_contracts.py).

For guarantee 2, add a passing standalone runtime test for the forge-facts half. A candidate should claim success while leaving the task unsolved and attempt to submit counterfeit measurement evidence. The producer boundary rejects unauthorized Measurement records, and the real trusted scorer returns the state-supported outcome.

The existing combined guarantee-2 probe also requires protected-feedback noninterference. Keep that remaining research-workflow obligation visible; passing forged-facts tests does not close the whole guarantee.

All committed tests use deterministic scripts, retained responses, or the injectable provider. Disable external network access during tests. No live model calls, paid smoke tests, or whole-episode upstream retries are part of M5’s committed test suite.

## 6. Risks and decisions for the human

**Approve the two generic runtime changes.** Dynamic scoped admission and suspended operator-only restoration are necessary to meet the requested interface and recovery probe honestly. They preserve the authority record schema but require explicit implementation and semantic changes before the second-benchmark core freeze.

**Approve the bounded direct user-model adapter.** The existing text-only provider profile does not implement upstream user tool proposals. Add that capability as a separately pinned model adapter; preserve the actor/refiner harness restrictions. Do not silently substitute a different user-simulation protocol.

**Keep task qualification as a hard gate.** The source generator supports deterministic telecom scoring, but this pass did not certify every task record. If the complete scan discovers required NL grading or incompatible grouping, stop preparation and present the exact affected IDs and proposed campaign revision. Do not weaken reward criteria or silently change the denominator.

**Keep dependency resolution separate.** Tau’s Python range and LiteLLM constraints may conflict with strive’s existing environment. A separately locked adapter runtime is the default resolution; changing upstream dependencies requires a new closure and equivalence run.

**Preserve the limit of the metric.** Deterministic success measures the selected task criteria. It does not certify every policy instruction, user-simulator realism, or absence of pretraining contamination.

**Do not overstate overall release readiness.** The current acceptance suite still marks native-harness confinement as unresolved. M5 can close benchmark scoring and recovery evidence without claiming that every native harness already satisfies all five guarantees. The funded ceiling and protected audit allocation remain prerequisites for the later paid campaign.

Automatic approval review rejected opening the raw task file in the browser because permission was declined. That retrieval was not bypassed; complete task-inventory certification remains outstanding.

### M5 implementation status, 9 September 2026

Amendment 2 is implemented under `src/strive/vnext/benchmarks/`, with the tau2
implementation in the separately resolved `adapters/tau2/` project. The typed
`strive.benchmark/1` interface remains outside the authority codec. The operation
and evidence ownership described in §3 now uses `BenchmarkEffectAdapter`,
`EpisodeDriver`, transactional operation receipts, and the trusted scorer port.
`Measurement` retains its frozen fields and carries authenticated receipt and
state references, the task reward definition, grouping identity and coverage.

The §3.3 runtime changes use pinned scoped admission and the existing
`RevisionActivation`. Suspended operator restoration retains the canonical
`RestoreBundle`, changes only active bundle/revision, and preserves suspension,
private state, pending commands, effect authorizations, results and accounting.
Candidate activation still cannot cross an unresolved operation boundary.

The §6 closure includes source/dependency/data identities and an explicit
retained data tree. Amendment 3 supersedes M5's original transitive grouping and
stock-split hard gate. The §7 telecom target remains 60/14/40, with actual
49/29/36 whole-base-scenario membership; generic adapters do not inherit it.
Selected-task grading and our adaptive group disjointness remain blocking.
Stock-split overlap is informational. No audit or validation feedback is granted
to adaptation.

M5's §9.4/§10 evidence is fixture-level in this environment. The pinned tau2
resolution hit the macOS uv system-configuration panic; shell task retrieval
failed DNS and the web reader rejected the task file's size. Full upstream
inventory certification and live deterministic evaluator equivalence remain
explicitly skipped in that historical M5 pass. Amendment 3 now approves derived
whole-group reassignment with actual size reporting and no task exclusions.
A second integer-target benchmark exercises the frozen common infrastructure
without changes to its files. The implementation report and exact limits are in
[`m5-investigation/README.md`](../m5-investigation/README.md).


## Amendment 3: split recalibration and separate fixed-stock evaluation

Human-approved for Milestone 8. This amendment supersedes the stock-split and transitive-group requirements in §7, §9.4, and Amendments 1–2. It preserves the deterministic-grading gate, frozen contracts, verifier, ledger, broker, admission, supervisor, gateway, and Linux jail.

An adaptive harness can learn scenario-specific behavior from development feedback. Its audit must hold out entire underlying scenarios to measure transfer. A fixed agent that never trains or changes across episodes has no within-campaign train-to-test adaptation leakage, so overlapping scenario families in unused stock training data do not invalidate its fixed test evaluation. This is the rationale behind keeping dependent samples in the same fold in [GroupKFold](https://scikit-learn.org/stable/modules/cross_validation.html#group-k-fold). It does not establish absence of pretraining contamination.

| Mode | Task assignment | Actor and result interpretation |
| --- | --- | --- |
| `adaptive` | Strive-derived whole-base-scenario split of all 114 selected base tasks; target 60/14/40, actual 49/29/36. Both the adapting arm and its matched fixed control use this assignment. | Start from the same initial actor. Keep validation/audit feedback embargoed under contract A. No leaderboard comparability claim. |
| `fixed-stock` | All 40 published `test` IDs, in stock order, without a group-disjointness gate. | Run the initial, non-adapting actor with fresh episode state. Report independently; do not substitute a selected final adaptive actor or feed results into adaptation. |

Tau2 defines task splits as named ID lists. Its default `base` pool preserves the original evaluation denominator, while train/test support training experiments. The approved stock-test mode therefore permits comparisons only to evaluations on that same test population and protocol; it does not claim equivalence to an original 114-task leaderboard score. See [upstream split documentation](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md) and [pinned telecom split IDs](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/data/tau2/domains/telecom/split_tasks.json).

The grouping algorithm `tau2-base-template/1` uses the `[name]` stem of the generator's base template. `TaskManager` appends a composed failure-condition list and `[PERSONA:...]` to that stem. All such variations normalize to the same root; selecting the first alphabetically sorted failure condition would invent a finer ancestry not represented in the generator. Shared goals, initialization, words, and near-similarity never join roots. For non-generator contract fixtures only, exact canonical persona-free scenario equality supplies a group key. See the [pinned generator](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/domains/telecom/tasks/manager.py).

Retain the algorithm source, seed `strive-amendment-3-60-14-40-v1`, SHA-256 order of seed plus root, sorted IDs within each group, full group-to-ID map, and selected assignments. Dynamic programming enumerates reachable development/validation size pairs. Among nonempty three-way partitions when at least three groups exist, minimize total absolute size error, maximum error, audit error, validation error, development error, then development/validation sizes. Sorted state traversal and development/validation/audit transition order choose the first path to each size pair. Fewer than three groups allow empty partitions, explicitly reported without dropping tasks; such an allocation cannot support a nonempty held-out evaluation claim.

The selected pool contains 49 MMS, 36 mobile-data, and 29 service tasks, so the closest nonempty allocation is development=MMS, validation=service, audit=mobile-data. This is coarse transfer across only three roots, not evidence of generalization across many independent scenarios. Exact 60/14/40 is unachievable. Freeze actual denominators and episode orders before dispatch. Earlier 180-episode and 4,160-episode totals are target-size estimates: three development passes now mean 147 episodes per trajectory and eight paired repetitions plus two audit trials mean 2,352 development plus 1,152 audit episodes. Recompute refinement opportunities and budgets from the retained plan, never relabel nominal counts as completed work.

Certification passes when every selected task is deterministically gradable and the adaptive partition covers the selected pool exactly once without crossing groups. NL assertions, missing/unknown reward bases, unreviewed assertions, and failed strict reference/assertion checks still block. Full-inventory stock overlap is informational under both the new roots and the retained legacy closure diagnostic. The captured legacy scan counted 2,285 IDs: 1,984 MMS, 254 mobile-data, and 47 service. Report these counts with their algorithm and source; retain the exact new scan in the Linux certificate.

The standalone fixed-stock runner accepts a retained initial `llm_agent` model/options artifact, constructs a fresh upstream actor for each simulation, and exposes no refiner, learned-memory import, or prompt-update path. This implementation is an upstream LLM-agent baseline, not a claim that an opencode actor has been ported unchanged. It pins the user to `gpt-4.1-2025-04-14`, temperature `0.0`, matching [upstream defaults](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/config.py). Retain actor options, user settings, trial count, seeds, resolved upstream configuration, original results, and explicit coverage. The reference adaptive user binding remains separately pinned and must be reported with its own result. Model or actor-implementation differences preclude a matched cross-mode comparison.

The Linux suite runs selected-task certification in both modes, asserts the 49/29/36 whole-group adaptive allocation and informational stock counts, checks real fixed-mode configuration, and retains deterministic scorer and crash-recovery checks. These tests make no model calls and skip on macOS. The initial fixed actor's model-performance run is a separate funded operation; preparation is not a benchmark score.
