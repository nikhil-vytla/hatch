<!-- TEMPORARY SCAFFOLDING — remove on completion. This file (and
strive/ASTRA_HANDOFF.md and any other ASTRA_* artifacts) is handoff/design
scaffolding for the rebuild; delete it once the redesign lands and fold durable
content into README/ARCHITECTURE/ADRs. This is the CONSOLIDATED spec; the four
incremental design passes it supersedes live in git history (dbab76b, 2961f3a,
2fc1ec3, 410fef5). Authored by GPT-6 Astra via `codex exec -m gpt-6-astra`. -->

# strive vNext specification

Status: design proposal, pending human go/no-go.  
Date: 8 September 2026.

This document supersedes all earlier Astra design drafts. It specifies the intended rebuild; it does not authorize teardown or implementation.

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

Ship one canonical projection with three export profiles:

| Profile | Integration responsibility |
|---|---|
| **Langfuse, reference viewer** | Translate supported attributes and propagate grouping metadata to child spans. [Integration contract](https://langfuse.com/integrations/native/opentelemetry). |
| **LangSmith** | Translate run types, messages, and metadata using its documented mappings. [Integration contract](https://docs.langchain.com/langsmith/trace-with-opentelemetry). |
| **Phoenix** | Translate GenAI fields into OpenInference attributes for richer presentation. [Translation contract](https://arize.com/docs/phoenix/tracing/concepts-tracing/translating-conventions). |

Selecting a profile and endpoint requires no policy instrumentation changes. Endpoint credentials remain outside archived artifacts.

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

The first stateful workload is an order-fulfilment simulator with persistent inventory and order state. Keep sum/max fixtures as deterministic controls behind the same small operation interface.

The simulator provides stock reads, inventory reservation, order updates, operation lookup, and snapshots. A mutation transaction stores both its state change and result under the effect ID. Repeating that ID with different arguments fails; looking it up returns the original result.

The trusted scorer uses actual simulator state and broker receipts. Agent-written “shipped” or “tests passed” messages have no scoring authority.

Release 1 integrates one selected hosted-model provider through a trusted adapter. Actor and refiner bindings name exact available model versions and request settings. Provider/account selection remains a deployment input in section 11, not an implicit kernel default. Ambiguous model calls suspend unless the selected adapter has a verified stronger recovery contract.

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
| Journal-backed CLI inspection, OTLP projection, Langfuse setup and LangSmith/Phoenix profiles. | Custom web UI, hosted leaderboard, prompt-management service, labeling product and production tail sampling. |
| Ordinary brokered execution. | Speculation and reusable external-effect caches. |

### 10.2 Milestone sequence

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| **1. Freeze contracts and acceptance cases** | Authority schema, step interface, effect lifecycle, manifest schema, simulator scenarios, feedback access matrix, and reference study plan. | Each integrity guarantee has a falsifiable test. Human go/no-go precedes teardown. |
| **2. Build storage and pure verification** | New artifact root, CAS publication, framed history, one-writer ownership, reference validation, replay and preflight. | Reject malformed authority transitions and corrupted references. Accept unknown bounded annotations. Verification works in a fresh interpreter without candidate imports. |
| **3. Build effects, accounting, and confinement** | Broker, sandbox, reservations, recorded returns, settlement, continuation and operator recovery. | Fault injection at authorization, dispatch, return, settlement, and continuation boundaries. Reject stale results, unauthorized calls, credential access and budget expansion. |
| **4. Complete stateful operation** | Transactional simulator mutations, operation lookup, snapshots, trusted scoring and coverage. | Crash after mutation but before strive records the receipt; recover the original result without repeating the mutation. Unsupported model uncertainty retains its obligation and suspends. |
| **5. Enable adaptation** | Code/prompt/memory revisions, atomic activation/restoration, optional forks and bounded controller handover. | Prompt-only edits alter behavior. Composite activation survives crashes. Restoration preserves current world state and accounting. Controller failure can be repaired independently. |
| **6. Complete the research workflow** | Manifest and study commands, A/B access, audit isolation, comparisons, CLI inspection and telemetry profiles. | Protected-data noninterference, complete denominator reporting, restart-safe study expansion, and exporter outage/re-export checks. |
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
