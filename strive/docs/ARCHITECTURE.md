# strive architecture

Strive provides durable mechanisms for model-led adaptation. An agent operates
in a continuing environment, changes its executable behavior, and learns from
subsequent experience. Strive records exactly what ran and enforces permissions,
accounting, recovery and declared evidence access. Policies decide what to change
and whether a change helped. The execution core decides what was authorized,
what was observed, what remains uncertain and which revision is active.

The current implementation is `src/strive/vnext`. Its local run format, commands
and artifact roots are independent of the legacy modules still in the package.
There is no migration or dual-writing path. Historical implementation decisions
are identified in the [ADR index](adrs/README.md); earlier project documents
remain in [the archive](archive/README.md).

## Five integrity guarantees

These guarantees assume a trusted host and operator, hostile generated code and
inputs, and durable local storage surviving process failure.

| Guarantee | Requirement and enforcement |
| --- | --- |
| 1. Confinement and fixed authority | Candidate code cannot alter authorization, accounting, evidence access, trusted measurement, verification or recovery. The sandbox and broker keep privileged services, credentials and authoritative storage outside candidate access. |
| 2. Independent facts | Broker, adapter and scorer records establish interactions, usage, outcomes and coverage. Producer-specific append ports and scoped evidence prevent candidate claims from replacing those facts. |
| 3. Durable execution identity | Exact requests, effect identities, authorization and reservations commit before dispatch. Retained executable bytes, revision transitions and consumed-result cursors reconstruct the accepted execution. |
| 4. Honest recovery | Recorded outcomes are reused; supported mutations reconcile by durable identity; unsupported uncertainty suspends with obligations retained. Restoring a bundle never rewinds spending or world state. |
| 5. A small checked protocol | Pure preflight and replay reject inconsistent authority transitions. The protocol represents failure, overruns and uncertainty without inventing success. |

Protocol validity does not imply task success or scientific improvement. Nor do
hash chains protect against a malicious host owner replacing the entire store
and its trust root. Distributed ownership, host-loss failover and portable
external history signatures are outside the current claim.

## Components and ownership

These are boundaries within a local implementation, not separately deployed
services.

| Component | Responsibility |
| --- | --- |
| Manifests and bundles | Retain resolved configuration and exact executable content, prompts, memory, entry points, dependencies and model settings before execution. |
| Journal and CAS | Publish immutable objects and one ordered authority history per run, with local writer ownership and durable epochs. |
| Pure verifier | Check references, authenticated producers, causation, effect transitions, reservations, settlement, activation and result consumption. |
| Supervisor and ledger | Own serial execution, durable reservations, dispatch, deadlines, receipts, reconciliation, continuation and accounting. |
| Sandbox and capability broker | Confine candidate programs and admit only pinned operations with authorized destinations, arguments, environments, scopes and budgets. |
| Harness adapters and gateway | Treat a replaceable harness as a bounded model-generation service while retaining trusted model traffic and usage evidence. |
| Benchmark adapters | Own task semantics, episode state, simulator operations, snapshots, recovery and scoring behind the general `BenchmarkAdapter` interface. |
| Policy runtime | Choose operation, refinement, optional development checks, activation and restoration using authorized evidence. |
| Research workflow | Resolve manifests, run serial studies, freeze selected actors, isolate audit and produce journal-derived reports and telemetry. |

## Manifests, bundles and execution

An authored TOML manifest names the policy, workload, trusted implementations,
initial bundle, editable scope, capabilities, actor/refiner/user model bindings,
feedback contract, comparison plan, seeds, resource limits and recovery settings.
Resolution retains authored bytes and a `ResolvedManifest` with content-addressed
closure before dispatch. Requested capabilities describe needs; only the broker
grants authority. The installed implementation must match retained pins on
resume. Reproduction from initial inputs is a new run and can produce different
model outputs.

A bundle contains versioned actor/controller code, prompts, memory and skills,
plus its entry points, dependency closure and requested capabilities. The bundle
manager validates file paths, structure, dependencies, editable scope, provenance
and expected revision. Activation records exact previous and next bundles at a
legal operation boundary, so an invocation never sees mixed components.

The fixed step interface is:

```text
step(authorized_view, private_state, recorded_result)
    -> command, proposed_private_state, annotations
```

The supervisor owns invocation identity, executing bundle, input references and
result delivery. A continuation commits private-state bytes, the consumed result
cursor and any pending command together. Candidate fields cannot substitute for
those identities.

The command vocabulary is `ExecuteEffect`, `ApplyChange`, `RestoreBundle`,
`EvaluateFork`, `Continue`, `Suspend` and `Finish`. `Finish` ends execution; it
cannot certify task success. `EvaluateFork` is defined by the contracts but its
enactment is unsupported. `ExecuteEffect` is currently the chargeable effect
path; implementing forks requires explicit authorization, accounting and adapter
support.

Controller replacement uses the same bundle mechanism but requires a quiescent
boundary with no pending command or unconsumed result for the old controller.
The new controller and its explicit initial state activate atomically. There is
no arbitrary state migration. A broken controller can suspend; the operator can
restore a compatible prior bundle through the supervisor without running that
controller. Restoration changes executable configuration only.

## Storage, verification and authority

`store.ArtifactStore` defaults to `artifacts-vnext` and rejects populated roots
without its format marker. The workflow CLI organizes private per-run stores
under `artifacts-vnext-workflow`. CAS references identify content, separately
from command, invocation and effect identities. Referenced bytes and directory
entries are synced before a journal frame commits.

One `RunWriter` holds an exclusive local lease and execution epoch. Trusted setup
pins producer identities and hands each producer its own append port. Producer
MACs and supervisor seals authenticate accepted records against a protected
local authority file. Candidates receive neither that file nor a general CAS or
history reader. A schema-valid producer name alone is not authentication.

| Authority group | Recorded facts and owner |
| --- | --- |
| Envelope | Supervisor-owned run, sequence, record class, causation, producer, scope, payload reference and integrity linkage. |
| Run binding | Trusted setup pins configuration, implementations, initial state and bundle, models, limits, capabilities, feedback, comparison and lineage. |
| Effect authorization | Broker and supervisor bind exact request, command/effect IDs, executing bundle, operation, environment, scope, reservation, recovery contract and epoch. |
| Observation and settlement | Trusted adapters and broker retain dispatch, return/failure/uncertainty, responses, receipts, observed state, usage and reservation disposition. |
| Measurement | Trusted scorer binds the subject, workload, scorer, supporting receipts, coverage and metrics. |
| Revision activation | Supervisor records exact bundles, expected revision, boundary and any coupled controller state after validation. |
| Continuation | Supervisor records private-state bytes, consumed cursor, pending command, environment and execution status. |

These records establish what trusted producers reported. Verification checks
that provenance and its relationships; it does not independently establish the
truth of arbitrary external services or the quality of private reasoning.

`verify.preflight()` checks one transition against a verified prefix;
`verify.replay()` reconstructs immutable `VerifiedState` from committed history.
The verifier imports only standard-library code, contracts and shared wire/codec
definitions. It dispatches no effects, executes no candidate code and imports no
mutable store, runtime, policy, harness or benchmark implementation.

Missing artifacts, broken authentication, malformed frames and inconsistent
transitions stop mutation. Execution readers raise `IncompleteTail` for a
partial final frame. They never skip, truncate or silently repair history.
Inspection can show an authenticated complete prefix with an explicit tail
diagnostic, without turning that prefix into a repaired execution history.

Annotations are separate, namespaced, bounded payloads. Storage and verification
treat their bytes as opaque, including unknown schemas and non-JSON bytes.
Rationales, hypotheses, claimed scores and supplied-context labels may aid
inspection. They cannot authorize execution, grant access, activate revisions,
settle expenditure, release reservations, certify reward or authorize a retry.

## Effects, accounting and recovery

The active execution path is serial with at most one externally in-flight
effect. Its lifecycle is:

```text
accepted request -> durable authorization and reservation -> dispatch
                 -> recorded return or uncertainty -> settlement -> consumption
```

Recovery distinguishes a request that was never authorized from an authorized
effect that may already have run. Recorded returns finish bookkeeping without
redispatch. An adapter can recover by deterministic recomputation, lookup by
durable operation identity, or retry under a declared deduplication contract.
Unsupported ambiguity suspends. A new explicit attempt has a new effect and
reservation; it does not erase its unresolved predecessor. Native session IDs
and transcripts are not recovery contracts.

Admission checks each limited resource against:

```text
settled usage + outstanding reservations + proposed reservation <= limit
```

Settlement replaces or adjusts an obligation once. Usage distinguishes measured
quantities, reserved capacity and unknown expenditure. Token-derived cost uses a
pinned price schedule and is distinct from provider-reconciled billing. A finite
ceiling requires defensible bounds before dispatch, including refiner calls,
failed proposals and retries. Unknown components retain their obligations.
Observed overruns are recorded and block further dispatch; real receipts are not
rejected to make a budget appear respected.

Outcome and accounting status are independent. A known model response may have
unknown usage. Cancellation does not establish that an external operation or
charge never occurred. Accounting survives suspension and restart; restoring a
bundle does not restore an earlier balance or simulator state.

## Confinement and model harnesses

The Deno candidate sandbox supplies bounded input/output, permission denial,
resource limits and deadlines. `runtime.confined_sandbox` adds a Linux jail when
runtime capability checks succeed. The shared jail uses bubblewrap namespaces,
a retained read-only runtime, seccomp with default denial, cgroup v2 hard memory
and process limits, and bounded tmpfs scratch. Host homes, credentials, stores,
repository files and cgroup controls are absent. The private network namespace
has no route to host or external services.

Harness traffic uses the authenticated inherited-pipe gateway; it has no general
network exception. Cgroup identities and boot identity support whole-tree
cleanup and recovery, including descendants that create new sessions. Candidate
startup has a separate bound; its execution deadline starts at the trusted
bootstrap readiness marker. Candidate output cannot reset that deadline.

Capability detection launches the real jail and checks kernel-visible state.
Once selected, a failed jail does not fall back to Deno permissions. Unsupported
hosts can run the explicitly limited permission implementation;
`STRIVE_REQUIRE_JAIL=1` makes a missing OS floor an error. A host test run with
Linux gates skipped does not qualify native process confinement. See
[ADR-0012](adrs/0012-linux-os-jail.md).

Harness adapters for opencode, Codex and Claude Code implement bounded generation
through `describe`, `prepare`, `invoke` and `reconcile`. The harness constructs a
model request and returns proposal data. It does not own the workload tools,
trusted scoring or the execution loop. Profiles pin executable/configuration,
decoder and model settings; candidate-authored privileged adapters and arbitrary
dependency installation are outside scope.

The gateway admits one text generation under an effect-scoped capability and
conservative provider bounds. Extra requests, hidden retries, tools, unsupported
billing options, streaming and session linkage fail closed. It retains supplied
context, exact wire JSON and the complete provider response before forwarding
the response to the child. Requested, wire and provider-observed model identities
remain distinct. CLI model echoes and token totals are diagnostics.

Provider credentials stay outside the child. Recovery uses retained responses
and pinned deterministic decoding when available, otherwise preserves an
incomplete outcome or uncertainty. A working jail and adapter fixtures do not
qualify an installed vendor CLI's single-request behavior. Native drives and
funded smokes have separate gates. [ADR-0009](adrs/0009-harness-as-model.md)
records this boundary.

## Benchmarks and telecom

`benchmarks.api.BenchmarkAdapter` defines `strive.benchmark/1`: descriptors,
tasks, splits, operations, episode initialization, actor and user actions,
messages, termination, snapshots, lookup, scoring and optional forks. Workload
semantics stay in the adapter; the supervisor sees ordinary authorized effects.
`OperationStore` atomically retains operation identity, argument binding, snapshot
changes and receipts. Restart recovers committed mutations without repeating
them. Snapshot reads cannot rewind the authoritative environment head.

The episode driver keeps tool invocations and user-model generation separate.
It authenticates captured generation cursors and resumes pending batches from
receipts. The trusted scorer owns reward and coverage, using committed state and
receipt chains. Scorer summaries cannot stand in for missing evidence.

Counter is a deterministic second implementation that tests reuse without core
changes. The first external workload is tau2 telecom text, separately packaged
under `adapters/tau2` and pinned to upstream commit
`a2c024725189473d2d7cea3a5cfdbcc67478e41f`, distribution version `1.0.1`.
The adapter and its upstream dependency run in an isolated interpreter over
bounded JSON RPC. Their source, dependencies, data, policies, simulator
guidelines, licenses and qualification artifacts are retained separately from
the pure verifier.

Telecom contains coupled agent and user-device state. The adapter runs upstream
tool and user-simulator logic with generation intercepted into separately
brokered calls. It preserves structured multi-tool message roles. Snapshots and
receipts retain both databases, conversation position, pending batches and
random state. Deterministic grading checks the pinned upstream evaluators.
Selected tasks with missing or unknown reward components, natural-language
assertions, unreviewed assertions or failed strict reference execution block
qualification. No task is silently dropped to obtain a passing denominator.
See [ADR-0010](adrs/0010-benchmark-adapter-tau2.md) and the
[adapter guide](../adapters/tau2/README.md).

The two evaluation modes have different meanings:

| Mode | Population and interpretation |
| --- | --- |
| `adaptive` | All 114 selected base tasks, assigned as whole scenario roots: 49 development, 29 validation, 36 audit. An adapting actor and its matched fixed control share this assignment and initial actor. |
| `fixed-stock` | All 40 published test IDs, in stock order, with a fresh upstream `llm_agent` per simulation and no cross-episode adaptation. It reports separately. |

The adaptive roots are MMS, service and mobile-data respectively. Persona and
failure-condition variants stay with their base template. Shared words or goals
do not join roots. Exact target sizes of 60/14/40 are impossible with these three
groups; the allocator preserves nonempty partitions and deterministically
minimizes size error. Certification retains source, seed, ordering, memberships
and actual counts. Stock train/test overlap remains informational, while
adaptive coverage and group separation are blocking checks.

Three development passes mean 147 episodes per trajectory. The planned eight
paired repetitions mean 2,352 development episodes, plus 1,152 audit episodes for
two trials per audit task in both arms. These are plan counts, not completed
measurements. Only three independent roots support a coarse transfer experiment,
not broad held-out generalization or a leaderboard claim.

Fixed-stock uses its own initial actor configuration and pins the user to
`gpt-4.1-2025-04-14` at temperature `0.0`. Its upstream actor is a separate
implementation from the adaptive harness. A 40-task test result is not a
114-task base leaderboard result; cross-mode scores must not be pooled or reused
as adaptive feedback. [ADR-0013](adrs/0013-adaptive-whole-group-split.md)
records the allocation and comparison limits.

## Continual refinement and feedback

`policy.ContinualRefine` operates the active bundle, gathers authorized evidence
at configured checkpoints, and obtains a typed proposal through `GatewayRefiner`.
Its choices are keep, revise, restore or gather more evidence. Revision validates
a complete bundle and activates it immediately at a legal boundary. Development
checks are optional policy choices, never a universal promotion gate. A malformed
proposal fails as data; replayed checkpoints reuse retained generation and
activation rather than repeating the model call.

Memory and skills are versioned files. Imported or derived files retain their
source provenance and scope; a summary cannot acquire broader access than its
inputs. Evidence selection intersects the campaign feedback contract with actual
broker grants before reading bytes. Candidates receive filtered views, never
unrestricted history or CAS access.

| Contract | Permitted influence |
| --- | --- |
| A, strict blind audit | Declared development evidence may drive adaptation and selection. Validation and audit remain outside that influence. This is the reference scientific comparison contract. |
| B, adaptive validation with fresh blind audit | Development and explicitly granted validation evidence may influence adaptation and selection. Consulted validation is consumed evidence and cannot support an untouched-held-out claim. |
| C, private deployment veto | Deferred. Private feedback used to block or select candidates would require an explicit control channel, query accounting and a separate fresh audit. |

Operational failures are visible only under the declared grants and settings.
Neither A nor B grants audit or private-veto access. Each manifest chooses its
contract explicitly; B requires a validation corpus, and the recorded CLI
example uses A. A contract label alone never grants retrieval. See
[ADR-0011](adrs/0011-feedback-contracts.md).

## Research workflow, reporting and telemetry

The manifest CLI offers `run`, `resume`, `experiment`, `compare`, `status` and
`project`. Use `uv run python -m strive.vnext.cli` for the unambiguous vNext entry
point. The installed `strive` command routes manifest-shaped commands here and
retains the legacy flag-based interface separately. The current composition
runs the counter benchmark with a recorded provider. Unsupported models,
workloads and native harness campaign manifests fail validation. The installed
tau2 adapter and standalone fixed-stock runner do not by themselves provide an
adaptive telecom CLI campaign.

Run setup exclusively claims an identity, retains inputs, validates pins and
bounds, and displays resolved configuration before dispatch. Resume uses the
original binding, artifacts, service databases, continuation and ledger; it does
not accept scientific overrides or substitute newer code. Replay only checks
recorded history and does not require an executable provider session.

The serial study wrapper records arm/repetition/run identities and resolves every
run before dispatching the first arm. It resumes those identities after restart.
Per-repetition ceilings and total development allocation are separate from the
audit allocation. Equal ceilings do not imply equal realized spending.

Selection is predeclared as the final valid active actor from every trajectory.
Freeze records development heads and selected bundles under workflow leases and
installs barriers that prevent development resume. Audit receives only the
selected actor files in a new bundle and scope. It owns separate CAS, journals,
environments, receipts, grants, retrieval, caches, conversations, gateway spools,
accounting and report destinations. No audit callback reaches the development
policy. A matching release marker is required before workflow reports or
telemetry expose audit content. Release does not reopen selection or development.

Reports derive official results only from authenticated measurements. They retain
planned, admitted, completed, failed, excluded and unresolved coverage; missing
outcomes remain explicit with bounds. Matched comparison checks retained workload,
state, scorer, models, budgets, seeds, corpus, recovery and file-level conditions.
Descriptive comparisons list differences without a controlled-improvement claim.
The supported predeclared interval is a 95% normal approximation over complete
paired trajectories, with no interval for one pair and an explicit small-sample
limit. Retention compares repeated observed development exposures and lists
unmeasured tasks; it does not invent a separate regression evaluation.

Execution integrity and measurement provenance, feedback exposure, and comparison
strength are separate report labels. Research-mode scores remain untrusted even
when real broker expenditure is recorded. Supplied context is labeled `sent to
the model`; seeing bytes in a request does not prove their causal influence.

Telemetry is an optional separate journal consumer. `strive project` exports
OTLP/HTTP JSON with OpenTelemetry GenAI convention version `1.41.0`; Langfuse is
the sole reference viewer profile. Stable execution-derived span IDs, event and
artifact references, model identities and usage make traces inspectable. Costs
appear on leaf model effects. The journal lacks absolute dispatch timestamps, so
timing uses an explicitly relative axis with unavailable durations left missing.

Exporter failures leave a visible cursor/backlog without changing execution.
Rebuilding a cursor reprojects history; OTLP does not promise exactly-once
server ingestion. Audit export requires the release marker and a distinct
HTTP endpoint from development. Financial and research totals always come from
the journal, never from telemetry. Runtime and verifier code do not depend on
reporting or exporter availability.

## Qualification and deferrals

Host tests exercise contracts, pure replay, authenticated facts, durable identity,
recovery, adaptation and isolated audit with recorded providers. Linux confinement
and installed tau2 checks require the prepared [Containerfile](../Containerfile)
and `scripts/verify-in-container.sh`; that runner fails if required jail or tau2
gates skip. Missing host capabilities are reported as skips, not as qualification.
See [HANDOFF](HANDOFF.md) for commands and [ROADMAP](ROADMAP.md) for remaining work.

Native CLI single-request qualification, the complete retained telecom closure
and deterministic grading evidence, and an explicit funded ceiling with a
protected audit allocation are prerequisites to a live reference campaign.
Permission fixtures, prepared plans and a `trusted` mode flag cannot establish
those claims. Positive performance is not required; any negative or inconclusive
study must retain its coverage, costs and limitations.

`EvaluateFork` enactment and feedback C remain deferred. Other exclusions include
arbitrary controller-state migration, model-weight updates, dynamic privileged
adapters, distributed workers, cross-run mutable memory, persistent verifier
caches, host-loss recovery and additional viewer profiles. These are separate
work, not capabilities implied by the current interfaces.
