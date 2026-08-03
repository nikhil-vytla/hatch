# Candidate B: a locked intent compiler

## Decision in one sentence

Parallax should compile a pinned benchmark record into a content-addressed generation lock, then build, admit, seal, and run episodes from that lock without calling a model again.

The stochastic compiler reproduces the Microsoft Evolving Intent construction path at commit `993d6be9597ac03854b46362ccd647eb1bfd267a`: function and argument extraction, argument counterfactuals, chained function predecessors, plan-first scheduling, and optional naturalization. Domain code owns the semantics that the four benchmarks do not share. The deterministic half owns identity, replay, admission, sealing, transcripts, and evaluator commitments.

## Caller usage

### Command line

`generate` is the only command allowed to call a generation provider. Its input names one benchmark record and the episode suite to construct.

```bash
parallax generate \
  --domain gsm8k \
  --source hf://openai/gsm8k@<dataset-revision>/test/37 \
  --suite paper-three-turns.toml \
  --providers providers.toml \
  --store .parallax/artifacts \
  --out locks/gsm8k-37.lock.json
```

The output is a closed `GenerationLock`, not a partly successful dataset row. A failed run leaves an inspectable generation journal but no lock.

`build-from-lock` has no provider flags and refuses network access. It replays the typed plans, verifies every committed intermediate, runs admission, and seals private evaluator material.

```bash
parallax build-from-lock \
  locks/gsm8k-37.lock.json \
  --store .parallax/artifacts \
  --seal-key env://PARALLAX_SEAL_KEY \
  --out experiments/gsm8k-37.experiment.json
```

`run` gives the agent only public messages and gives the domain evaluator only the sealed native target. It writes an immutable transcript and evaluation report.

```bash
parallax run \
  experiments/gsm8k-37.experiment.json \
  --agent agents/qwen3.toml \
  --store .parallax/artifacts \
  --out runs/gsm8k-37-qwen3.run.json
```

The same commands cover BIRD-SQL, BrowseComp+, and SWE-bench Verified:

```bash
parallax generate \
  --domain bird-sql \
  --source bird://<bird-revision>/dev/17 \
  --suite paper-three-turns.toml \
  --providers providers.toml \
  --store .parallax/artifacts \
  --out locks/bird-17.lock.json
```

### Python

The Python API has one configured entry point and three operations.

```python
from parallax import Parallax
from parallax.domains import Gsm8k
from parallax.providers import ProviderPool
from parallax.store import ArtifactStore

px = Parallax(
    store=ArtifactStore(".parallax/artifacts"),
    domains=[Gsm8k()],
)

lock = px.generate(
    source=Gsm8k.source(
        dataset_revision="<dataset-revision>",
        split="test",
        record_id="37",
    ),
    suite="paper-three-turns.toml",
    providers=ProviderPool.from_toml("providers.toml"),
)

experiment = px.build_from_lock(
    lock,
    seal_key="env://PARALLAX_SEAL_KEY",
)

report = px.run(
    experiment,
    agent="agents/qwen3.toml",
)
```

The return values are references to immutable artifacts. Callers may inspect public projections, IDs, status, and reports. They do not coordinate extraction steps, retry individual arguments, construct turns, or select evaluators.

### A custom non-paper domain

An extension author supplies one vertical domain object. No common-kernel switch statement changes. This inventory example uses an LLM to decompose natural-language lookup tasks, changes eligible filter values, creates related predecessor lookups, renders state deltas, and compares normalized SKU sets.

```python
from dataclasses import dataclass
from parallax import Parallax
from parallax.domain import (
    DomainContext,
    DomainSemantics,
    ExtractedIntent,
    ExpandedIntent,
    FunctionChain,
    NativeTarget,
    PublicIntentView,
    ScheduledTurn,
)
from parallax.evaluation import Evaluation, EvaluatorCommitment

@dataclass(frozen=True)
class InventoryDomain(DomainSemantics["InventoryRecord", frozenset[str]]):
    domain_id = "acme.inventory-lookup"
    schema_version = 1

    def pin_source(self, source, ctx: DomainContext) -> "InventoryRecord":
        # Resolves once, validates the record, and returns typed source data.
        ...

    def extract(self, record, ctx: DomainContext) -> ExtractedIntent:
        # All provider calls go through ctx.generate(), which records evidence.
        ...

    def expand_arguments(
        self, extracted: ExtractedIntent, ctx: DomainContext
    ) -> ExpandedIntent:
        ...

    def build_function_chain(
        self, expanded: ExpandedIntent, ctx: DomainContext
    ) -> FunctionChain:
        ...

    def adjust_plan(self, plan, bundle):
        # Return plan unchanged when the domain needs no scheduling overlay.
        return plan

    def render(self, turn: ScheduledTurn, view: PublicIntentView):
        ...

    def evaluator_commitment(
        self, record: "InventoryRecord"
    ) -> EvaluatorCommitment[frozenset[str]]:
        ...

    def evaluate(
        self, answer: str, target: NativeTarget[frozenset[str]], runtime
    ) -> Evaluation:
        return Evaluation.exact_set(
            predicted=parse_skus(answer),
            expected=target.value,
        )

px = Parallax(
    store=ArtifactStore(".parallax/artifacts"),
    domains=[InventoryDomain()],
)
lock = px.generate(
    source="inventory://catalog-2026-08-01/tasks/desk-lamps",
    domain="acme.inventory-lookup",
    suite="three-turn-revision.toml",
    providers=ProviderPool.from_toml("providers.toml"),
)
experiment = px.build_from_lock(lock, seal_key="env://PARALLAX_SEAL_KEY")
report = px.run(experiment, agent="agents/catalog-agent.toml")
```

The protocol is intentionally demanding. A domain that cannot define source identity, typed intent, rendering, and native correctness is not ready to produce benchmark episodes.

## Problem

Current Parallax treats a hand-authored proposal as if it were an Evolving Intent artifact. It has no real extraction, argument counterfactual, predecessor, scheduler, or renderer implementation. Its terminal full-question dump lets an agent ignore history, its replay checks a magic goal rather than source arguments, its common kernel knows GSM8K details, and its separate SWE path does not share the experiment spine. Four intent models disagree about the same state. Existing tests prove that these shortcuts agree with themselves, not that Parallax implements the pinned upstream algorithm.

The upstream code does have a coherent algorithm, but it is not one generic three-stage function. GSM8K and BrowseComp+ use provider-backed decomposition, counterfactual generation, chained backward predecessors, and LLM checks. BIRD-SQL mixes SQL AST transforms, database sampling and execution, an LLM clause rewrite, and a guarded follow-up naturalizer. SWE-bench uses category-aware argument changes, same-repository bug pairing, a generated G1 orientation request, a generated G2 implementation precursor, a scheduling overlay, and the official container evaluator. The architecture must preserve those differences without putting benchmark names in the common compiler.

## Shape

### The hard boundary

There are two products:

1. `GenerationLock` is the complete output of stochastic construction. It commits every request, raw response, parse, validation result, retry, escalation, deterministic domain computation, typed intent, schedule, and rendered message.
2. `SealedExperiment` is a deterministic derivation of a lock. It contains public episodes, sealed native targets, admission results, and evaluator commitments.

No provider interface is reachable from `build_from_lock` or `run`. A build that needs a provider response is malformed and fails admission. This rule is enforced by package dependencies and a test that builds with network access disabled.

The suite is an input to `generate`, not `build_from_lock`, because upstream-compatible naturalization can be stochastic and depends on a completed turn plan. Plan-first scheduling still happens before rendering. The compiler creates the typed plans deterministically, renders canonical messages, optionally naturalizes them through the provider, and freezes both forms in the lock. `build_from_lock` recomputes the plans and canonical render inputs, then checks that the frozen messages bind to those inputs.

### Core value types

The sketches use `NonEmptyTuple[T]`, `FrozenMap[K, V]`, `Digest`, and `ArtifactId` as validated immutable values. Constructors are private where a raw string could violate an invariant.

```python
DomainId = NewType("DomainId", str)
RecordId = NewType("RecordId", str)
FunctionId = NewType("FunctionId", str)
ArgumentId = NewType("ArgumentId", str)
CounterfactualId = NewType("CounterfactualId", str)
PlanId = NewType("PlanId", str)
TurnId = NewType("TurnId", str)

@dataclass(frozen=True)
class SourcePin:
    domain: DomainId
    adapter_schema: int
    canonical_locator: str
    benchmark_revision: str
    record_id: RecordId
    raw_record_digest: Digest
    typed_record_digest: Digest

@dataclass(frozen=True)
class OriginalArgument:
    id: ArgumentId
    text: str
    category: ArgumentCategory | None
    source_span: SourceSpan | None

@dataclass(frozen=True)
class TargetFunction:
    id: FunctionId
    text: str

@dataclass(frozen=True)
class NativeTarget[T]:
    codec: str
    value: T
    source_digest: Digest

@dataclass(frozen=True)
class ExtractedIntent[T]:
    function: TargetFunction
    arguments: NonEmptyTuple[OriginalArgument]
    conversational_goal: str
    conversational_arguments: NonEmptyTuple[str]
    target: NativeTarget[T]
    checks: NonEmptyTuple["ExtractionCheck"]
```

`ExtractedIntent` has no `success` Boolean and no optional function. Construction succeeds with all required fields or returns a typed failure. Argument IDs derive from source identity and source order. Text changes do not silently re-key an argument.

Counterfactual eligibility is explicit. An empty list cannot mean both "not eligible" and "generation failed."

```python
@dataclass(frozen=True)
class CounterfactualArgument:
    id: CounterfactualId
    original: ArgumentId
    text: str
    original_value: str | None
    replacement_value: str | None
    reasoning: str
    domain_payload: FrozenJson

@dataclass(frozen=True)
class ExpandedArgument:
    original: OriginalArgument
    alternatives: (
        IneligibleCounterfactual
        | NonEmptyCounterfactuals
    )

@dataclass(frozen=True)
class ExpandedIntent[T]:
    extracted: ExtractedIntent[T]
    arguments: NonEmptyTuple[ExpandedArgument]
```

A function chain separates predecessors from the one source target. There is no list in which the target can appear twice or in the wrong position.

```python
@dataclass(frozen=True)
class PredecessorFunction:
    id: FunctionId
    text: str
    required_arguments: tuple["FunctionArgument", ...]
    archetype: str
    native_target: FrozenJson | None
    relation_to_successor: "PredecessorRelation"
    checks: NonEmptyTuple["PredecessorCheck"]

@dataclass(frozen=True)
class FunctionChain[T]:
    predecessors: NonEmptyTuple[PredecessorFunction]
    target: ExtractedIntent[T]

    def ordered_functions(self) -> NonEmptyTuple[FunctionNode]:
        return (*self.predecessors, self.target)
```

For a one-function suite, the lock contains `SingleFunctionIntent` rather than a `FunctionChain` with an empty predecessor tuple.

### Evidence and failure types

The artifact store writes the response blob and appends a `raw-response-stored` journal event before parsing. It later closes that journal entry as a `CallAttempt` and never replaces an earlier attempt.

```python
@dataclass(frozen=True)
class ProviderRequest:
    provider_protocol: str
    model: str
    messages_blob: ArtifactId
    messages_digest: Digest
    parameters: FrozenJson
    prompt_asset_digests: NonEmptyTuple[Digest]

@dataclass(frozen=True)
class RawResponse:
    media_type: str
    body_blob: ArtifactId

@dataclass(frozen=True)
class AttemptRejected:
    kind: Literal[
        "transport", "provider", "parse", "schema", "semantic", "judge"
    ]
    # Present when parsing succeeded but schema or semantic validation failed.
    parsed_blob: ArtifactId | None
    parsed_digest: Digest | None
    detail: FrozenJson

@dataclass(frozen=True)
class AttemptAccepted[T]:
    parsed_blob: ArtifactId
    value_digest: Digest
    value: T

@dataclass(frozen=True)
class CallAttempt[T]:
    sequence: int
    request: ProviderRequest
    raw: RawResponse | None
    outcome: AttemptRejected | AttemptAccepted[T]

@dataclass(frozen=True)
class StageEvidence[T]:
    role: str
    attempts: NonEmptyTuple[CallAttempt[T]]
    selected_attempt: int

@dataclass(frozen=True)
class ComputationEvidence[T]:
    operation: str
    implementation_digest: Digest
    input_digest: Digest
    output_digest: Digest
    value: T
```

Provider failures, parse failures, and semantic rejections stay distinct. A schema or semantic rejection retains the parsed blob as well as the raw response; a parse rejection retains the raw response and parser diagnostic. No parsed intermediate is overwritten by a later retry. Provider request IDs, wall-clock timestamps, and billing telemetry live in a journal sidecar and do not enter lock identity. A `StageExhausted` error carries the stage role, source pin, attempt IDs, exhausted budget, and last rejection. A crash-safe `GenerationJournal` may end in this error. Only a journal whose required stage graph is complete can close into a `GenerationLock`.

### Intent state and plans

One reducer owns intent semantics. It replaces `evolving_intent.IntentEvent`, `variants.IntentEventKind`, `autoresearch.IntentCondition`, and the intent-like structures in `kernel`.

```python
@dataclass(frozen=True)
class OriginalBinding:
    argument: ArgumentId

@dataclass(frozen=True)
class CounterfactualBinding:
    argument: ArgumentId
    counterfactual: CounterfactualId

ArgumentBinding = OriginalBinding | CounterfactualBinding

@dataclass(frozen=True)
class IntentState:
    function: FunctionId
    bindings: FrozenMap[ArgumentId, ArgumentBinding]

@dataclass(frozen=True)
class Reveal:
    binding: ArgumentBinding

@dataclass(frozen=True)
class Revise:
    argument: ArgumentId
    previous: CounterfactualBinding
    replacement: OriginalBinding

@dataclass(frozen=True)
class SwitchFunction:
    previous: FunctionId
    replacement: FunctionId
    carry: FrozenMap[ArgumentId, ArgumentBinding]

@dataclass(frozen=True)
class Repeat:
    # Repeat changes presentation, not intent state.
    requested: NonEmptyTuple[ArgumentId]

IntentEvent = Reveal | Revise | SwitchFunction | Repeat
```

`Revise` can only restore an original source binding. It cannot revise an unknown argument or claim that two unrelated texts are versions of one argument. `SwitchFunction` names both sides, and the reducer checks that they are adjacent in the committed chain. Domain code may produce other predecessor argument IDs, but the final target state is always defined in source argument IDs.

```python
@dataclass(frozen=True)
class TargetIntentState:
    function: FunctionId
    bindings: FrozenMap[ArgumentId, OriginalBinding]

@dataclass(frozen=True)
class ScheduledTurn:
    id: TurnId
    before: IntentState
    events: NonEmptyTuple[IntentEvent]
    after: IntentState
    phase: Literal["orientation", "precursor", "target"]
    visible: "PublicIntentDelta"

@dataclass(frozen=True)
class TurnPlan:
    id: PlanId
    scenario: "Scenario"
    initial: IntentState
    turns: NonEmptyTuple[ScheduledTurn]
    required_final: TargetIntentState
```

`TurnPlan.create` runs the reducer and refuses a plan if any `before` or `after` state is inconsistent. Admission later recomputes the same trace independently.

Scenarios are closed data variants, not strings:

```python
Scenario = (
    FullySpecified
    | UnderSpecified
    | ArgumentRevision
    | FunctionSwitch
    | Combined
    | RepeatEvidence
)
```

Each variant has fields that make its requirements concrete. `ArgumentRevision` contains a non-empty set of eligible argument IDs. `FunctionSwitch` requires a chain. `Combined` requires both. A caller cannot request function switch for a single-function artifact.

### Rendering types

The renderer never receives the raw benchmark question, gold answer, patch, SQL result, or sealed record. It gets a `PublicIntentView` built from the typed `ScheduledTurn`.

```python
@dataclass(frozen=True)
class CanonicalMessage:
    role: Literal["user"]
    parts: NonEmptyTuple["MessagePart"]
    render_input_digest: Digest

@dataclass(frozen=True)
class NaturalizedMessage:
    canonical: CanonicalMessage
    text: str
    evidence: StageEvidence[str]
    render_input_digest: Digest

RenderedMessage = CanonicalMessage | NaturalizedMessage

@dataclass(frozen=True)
class LockedEpisodeDraft:
    plan: TurnPlan
    messages: NonEmptyTuple[RenderedMessage]
```

Every message binds to one scheduled turn and its `render_input_digest`. There is no API that accepts an arbitrary final message. A final full-question dump would need information absent from `PublicIntentView`, so the renderer cannot produce one by accident.

### Lock, experiment, and run identity

```python
@dataclass(frozen=True)
class GenerationLock:
    schema: Literal[1]
    upstream: "UpstreamCommitment"
    source: SourcePin
    generation_policy: "GenerationPolicy"
    domain_commitment: "DomainCommitment"
    extraction: "Committed[ExtractedIntent]"
    expansion: "Committed[ExpandedIntent]"
    function_data: "Committed[SingleFunctionIntent | FunctionChain]"
    episodes: NonEmptyTuple["Committed[LockedEpisodeDraft]"]
    evaluator: "EvaluatorCommitment"
    evidence_root: ArtifactId
    root_id: ArtifactId

@dataclass(frozen=True)
class SealedExperiment:
    lock_id: ArtifactId
    public_episodes: NonEmptyTuple["PublicEpisode"]
    sealed_targets: NonEmptyTuple["SealedTargetRef"]
    admission: NonEmptyTuple["AdmissionResult"]
    evaluator: "EvaluatorCommitment"
    experiment_id: ArtifactId

@dataclass(frozen=True)
class RunReport:
    experiment_id: ArtifactId
    agent_commitment: "AgentCommitment"
    transcripts: NonEmptyTuple["Transcript"]
    evaluations: NonEmptyTuple["Evaluation"]
    run_id: ArtifactId
```

IDs are SHA-256 over RFC 8785 canonical JSON with an explicit artifact kind and schema version:

```text
id = sha256(
  "parallax\0" ||
  artifact_kind || "\0" ||
  schema_version || "\0" ||
  canonical_payload || "\0" ||
  ordered_dependency_ids
)
```

Large raw bodies live in the content-addressed store and enter identity by digest. The source resolver normalizes repository and dataset locators; a local file becomes `blob://<digest>` rather than retaining its host path. Timestamps, local paths, API keys, and provider billing metadata do not affect semantic identity. Provider model name, request parameters, prompt digests, raw response digest, selected parsed value, parser version, validator version, seed, benchmark revision, domain implementation digest, and upstream commitment do.

Sealing changes visibility, not meaning. The experiment ID commits to each plaintext target digest and evaluator commitment before encryption, plus the sealing scheme version. Random encryption nonces therefore do not make logically identical experiments acquire different IDs. Public episode JSON contains only messages, turn IDs, budgets, and commitments.

### Evaluator commitment

The evaluator commitment describes native correctness before an agent runs.

```python
@dataclass(frozen=True)
class EvaluatorCommitment[T]:
    domain: DomainId
    evaluator_kind: str
    evaluator_schema: int
    implementation_digest: Digest
    target_digest: Digest
    environment: FrozenJson
    assets: FrozenMap[str, Digest]
    judge: "JudgeCommitment | None"

class NativeEvaluator(Protocol[T]):
    def evaluate(
        self,
        *,
        final_answer: str,
        transcript: "TranscriptView",
        target: NativeTarget[T],
        runtime: "EvaluationRuntime",
    ) -> "Evaluation": ...
```

The commitment excludes credentials and host-specific Docker IDs. It includes stable inputs that can change a verdict:

- GSM8K: answer parser and normalization implementation digests, plus the source numeric target.
- BIRD-SQL: database bytes, SQL dialect, result comparison policy, query timeout, and optional semantic-judge model and prompt.
- BrowseComp+: corpus and FAISS index digests, retrieval and agent policy, answer key, judge model, judge prompt, and judge parameters.
- SWE-bench Verified: instance ID, base commit, repository digest, official test spec, Docker image digest, harness version, patch extraction policy, and resource limits.

`run` refuses an evaluation runtime whose measured assets do not match the commitment. A judge call made during evaluation is run evidence, not generation evidence. Its raw request and response enter `RunReport` identity.

## Public signatures and module ownership

### Public facade

```python
# parallax/api.py

@dataclass(frozen=True)
class Parallax:
    store: ArtifactStore
    domains: "DomainCatalog"

    def generate(
        self,
        *,
        source: SourceLocator | str,
        suite: SuiteSpec | PathLike[str],
        providers: ProviderPool,
        domain: DomainId | str | None = None,
    ) -> GenerationLockRef:
        """Complete one stochastic compilation or raise GenerationFailed."""

    def build_from_lock(
        self,
        lock: GenerationLockRef | PathLike[str],
        *,
        seal_key: SealKeyRef,
    ) -> ExperimentRef:
        """Rebuild, admit, and seal without provider or network access."""

    def run(
        self,
        experiment: ExperimentRef | PathLike[str],
        *,
        agent: AgentSpec | PathLike[str],
        evaluation_runtime: EvaluationRuntime | None = None,
    ) -> RunReportRef:
        """Execute public turns and invoke the committed native evaluator."""
```

`Parallax` is the whole caller interface. The CLI maps one-to-one to these methods. There are no public `extract`, `compile_plans`, `replay_events`, `render_turn`, or `compile_swe_arms` methods.

### Internal ownership map

```text
src/parallax/
  api.py                 Three caller operations and configuration.
  artifacts.py           Immutable common values, canonical codecs, IDs.
  store.py               Atomic content-addressed writes and journals.
  providers.py           Evidence-recording provider calls and retry budgets.
  generator.py           One stochastic compilation transaction.
  simulation.py          Pure intent reducer, scheduler, and plan admission.
  experiment.py          Lock rebuild, sealing, agent loop, run records.
  evaluation.py          Evaluator commitments and runtime boundary.
  domain.py              DomainSemantics contract and DomainCatalog.
  domains/
    gsm8k.py             Complete GSM8K construction and native grading.
    bird_sql.py          Complete BIRD SQL, AST, DB, rendering, evaluation.
    browsecomp_plus.py   Complete search construction, retrieval, judging.
    swebench_verified.py Complete SWE construction, overlay, harness binding.
```

The modules follow knowledge ownership, not one module per time step. `generator.py` owns the stochastic transaction and retry policy across all stages. Each domain module owns extraction, counterfactual, predecessor, rendering, and evaluation decisions for that benchmark in one place. `simulation.py` owns the one shared state machine across scheduling and replay. `experiment.py` owns artifact visibility and execution.

There is no `utils.py`, per-stage service layer, repository wrapper, or facade over the facade.

### Domain contract

```python
# parallax/domain.py

R = TypeVar("R")  # typed benchmark record
T = TypeVar("T")  # typed native target

class DomainSemantics(Protocol[R, T]):
    domain_id: ClassVar[str]
    schema_version: ClassVar[int]

    def pin_source(
        self,
        source: SourceLocator,
        ctx: "SourceContext",
    ) -> R:
        """Resolve one record and return a validated, serializable domain type."""

    def extract(
        self,
        record: R,
        ctx: "DomainContext",
    ) -> ExtractedIntent[T]:
        """Produce and verify function, arguments, conversation forms, target."""

    def expand_arguments(
        self,
        extracted: ExtractedIntent[T],
        ctx: "DomainContext",
    ) -> ExpandedIntent[T]:
        """Generate or compute argument alternatives with domain checks."""

    def build_function_chain(
        self,
        expanded: ExpandedIntent[T],
        ctx: "DomainContext",
    ) -> SingleFunctionIntent[T] | FunctionChain[T]:
        """Build ordered predecessors ending at the source target."""

    def adjust_plan(
        self,
        plan: TurnPlan,
        bundle: "IntentBundle[T]",
    ) -> TurnPlan:
        """Apply a pure domain scheduling overlay and revalidate the trace."""

    def render(
        self,
        turn: ScheduledTurn,
        view: PublicIntentView,
    ) -> CanonicalMessage | "NaturalizationSpec":
        """Render only the typed state delta visible at this turn."""

    def evaluator_commitment(
        self,
        record: R,
    ) -> EvaluatorCommitment[T]:
        """Commit the source-native correctness procedure and assets."""

    def evaluate(
        self,
        answer: str,
        target: NativeTarget[T],
        runtime: EvaluationRuntime,
    ) -> Evaluation:
        """Run the committed native correctness procedure."""
```

`DomainContext.generate(role, request, parser, validator)` is the only way domain code can call a provider. It records requests and raw responses before invoking the parser. `DomainContext.compute(role, inputs, operation)` records deterministic domain computations. The generator checks that each returned value is covered by evidence before accepting it.

This is not a menu of replaceable micro-plugins. One domain object owns a coherent vertical meaning. Extraction output, scheduler overlay, renderer, target, and evaluator must agree under one schema and implementation commitment.

## Full flow

### 0. Pin the source

1. Resolve exactly one benchmark record from an immutable revision. Floating Hugging Face revisions, mutable local files without a digest, and an unpinned SWE repository are rejected.
2. Decode external JSON into the domain record type behind `pin_source`.
3. Store the original bytes and typed encoding in the private content-addressed store.
4. Build `SourcePin`.
5. Ask the domain for its evaluator commitment now. Later stages may not replace the native target.

The source target is authoritative. Generated text never becomes gold merely because a model emitted it.

Failure examples are `SourceUnavailable`, `RevisionNotImmutable`, `RecordNotFound`, `SourceSchemaMismatch`, and `NativeTargetUnavailable`.

### 1. Extract function and arguments

The common generator asks the domain to return `ExtractedIntent`. The four built-ins follow the pinned upstream behavior:

- GSM8K decomposes the word problem into a self-contained function and one to five explicit, non-overlapping arguments. It converts them into an initial query and ordered conversational hints. Coverage checks preserve every number and relation. A solvability verifier checks that goal plus arguments suffice.
- BrowseComp+ performs the same conceptual decomposition with search-specific prompts and checks solvability against the benchmark evidence documents.
- BIRD-SQL parses the gold SQL with `sqlglot`, derives structural clauses and value-bearing arguments, and uses the provider where upstream strips argument values from the function text or naturalizes text. Its verifier executes SQL and compares result sets.
- SWE-bench Verified decomposes only the stated issue into a self-contained fix function and two to five categorized arguments. Categories are symptom, trigger, location, approach, scope, and constraint. Patch alignment and issue consistency replace an answer-correctness judge.

Each provider subcall uses this escalation policy:

1. Retry a transport or transient provider failure up to the call policy limit on the same model with bounded backoff.
2. On malformed JSON or schema failure, retry the same model with the parser error and required schema appended as repair context.
3. On semantic rejection, retry the same model with only the validator finding, never the hidden gold answer.
4. After the per-model attempt budget, move to the next model in the role-specific ladder.
5. Freeze every rejected attempt. If the ladder is exhausted, close the journal with `StageExhausted` and do not create a lock.

Extraction is accepted only when decomposition, conversation conversion, coverage, and domain solvability all pass. The lock keeps each raw response and parsed intermediate, not just the selected final object.

### 2. Generate argument counterfactuals

The domain processes each eligible argument independently. Per-argument journals avoid a shared mutable output file. Parallel workers only add blobs; a deterministic merge sorts by source argument ID and counterfactual ordinal.

- GSM8K changes argument values while preserving the fact's role and the target function. Validation checks that the claimed original value occurs, the replacement occurs, at least one value changed, and unrelated argument content did not drift.
- BrowseComp+ uses the search prompt family and rejects variants that collapse the lookup, contradict fixed evidence, or change the function.
- BIRD-SQL does not send WHERE, HAVING, and LIMIT value swaps to a generic LLM. It samples valid values from the pinned database, rewrites SQL, executes candidates, and records the AST and execution evidence. Unsupported clauses receive `IneligibleCounterfactual` with a reason.
- SWE-bench applies category-specific prompts only to eligible constraint, scope, approach, and location details. Symptom and trigger handling follows the upstream overlay rules. A variant must remain plausible for the same repository and may not silently invent a new target issue.

A required scenario cannot select an ineligible or failed argument. The compiler either finds the requested non-empty alternatives or fails with `InsufficientCounterfactuals`. It does not lower the requested episode count.

### 3. Build chained predecessors

For GSM8K and BrowseComp+, predecessor generation proceeds backward:

```text
target G3 -> generate G2 from G3 -> generate G1 from G2
```

G1 is not independently generated from G3. Every call receives the downstream chain to avoid overlap. The lock records the chosen archetype, including upstream patterns such as identify-then-seek, survey-then-focus, trace-then-follow, lookup-then-compute, compute-then-extend, pivot, and reframing. Similarity, functional independence, and cross-turn relevance judges are distinct calls with distinct evidence. A failed check retries the candidate, then escalates by policy.

BIRD-SQL owns a different construction:

1. A pure planner enumerates clause change and preserve sets.
2. The provider rewrites SELECT, GROUP BY, ORDER BY, or JOIN while WHERE, HAVING, LIMIT, FROM, and required aliases remain fixed.
3. `sqlglot` verifies the requested clauses changed and preserved clauses stayed byte-equivalent under canonical clause encoding.
4. The pinned database verifies that the SQL parses, executes, and changes the result set.
5. The provider naturalizes the follow-up. Guards enforce one sentence, at most 25 words, no preserved literal leak, no banned connector prefix, and mention of a changed function token.

SWE-bench also owns a different construction:

1. Pair the G3 target with a real issue from the same repository and compatible area using the pinned pool and seed.
2. Generate G1 as a repository or module orientation request.
3. Replace G2 with an implementation-planning precursor adjacent to, but not the same as, G3.
4. Keep G3 as the original SWE-bench Verified issue. The source base commit and test container never switch to the paired issue.

The result is a typed chain ending in the source `ExtractedIntent`. A predecessor cannot replace the source target.

### 4. Schedule the whole trajectory first

`simulation.schedule(bundle, scenario, seed)` is pure. It mirrors the upstream plan-first sequence:

1. Select the intent events for the requested scenario.
2. Place every event on a turn under the suite's turn and switch counts.
3. Fill argument bindings, including counterfactual-first bindings and later source restorations.
4. Reduce the complete event list into `before` and `after` intent states.
5. Derive a public delta for each turn.
6. Apply the domain's pure `adjust_plan`.
7. Reduce again and require the exact final source state.

Scenario behavior is concrete:

- `FullySpecified` asks the target function and supplies all original arguments in its first turn.
- `UnderSpecified` asks the target function with a strict subset, then reveals the remaining original arguments across later turns.
- `ArgumentRevision` initially binds selected arguments to committed counterfactuals, then emits `Revise` events that restore the original source bindings.
- `FunctionSwitch` traverses adjacent predecessors in order and ends at the source target function.
- `Combined` composes ordered switches, reveals, and restorations in one precomputed plan.
- `RepeatEvidence` repeats selected already-visible facts without mutating intent state.

The required final state is:

```python
TargetIntentState(
    function=bundle.target.function.id,
    bindings={
        argument.id: OriginalBinding(argument.id)
        for argument in bundle.target.arguments
    },
)
```

This comparison catches a changed number, missing source condition, leftover counterfactual, wrong function, and magic-goal replay. Text similarity is not enough.

SWE-bench's overlay strips symptom arguments from inappropriate early phases, injects them into target-phase turns, redistributes details by phase, and collapses empty user turns. It must return a valid `TurnPlan`; it cannot edit rendered strings after scheduling.

BIRD-SQL may attach a per-turn partial SQL target computed by removing unrevealed predicates and pruning unused joins. That target is evaluation metadata derived from state, not user-visible text.

### 5. Render from typed state

The generator calls `domain.render` only after the complete plan is valid. The renderer receives the current function and `PublicIntentDelta`, not a source question.

Canonical rendering follows these rules:

- A switch may state the replacement function and only the arguments scheduled with that switch.
- A reveal emits only newly visible original facts.
- A revision identifies the argument and emits its restored source value.
- A repeat emits only the requested already-visible facts.
- Connectors derive from event and phase types. They are not guessed from turn numbers.

If the domain returns `NaturalizationSpec`, the generator calls the provider and freezes canonical input, raw response, parsed message, and validation. Search may use the upstream `SearchNaturalizer`; BIRD-SQL applies its value-leak guards; SWE uses phase-specific wording. A naturalizer may change phrasing but cannot add entities, values, functions, or arguments absent from the public delta. Validation tokenizes both semantic payloads and checks all protected literals.

There is no "helpful" final reconstruction. The final turn may be small because prior messages are part of the task. That is the experiment.

### 6. Close the generation lock

The generator verifies that:

- every semantic value has selected provider or computation evidence;
- every referenced blob exists and matches its digest;
- all required stage roles completed under the committed policy;
- the source target did not change;
- every plan restores the source target state;
- every message binds to a turn;
- every naturalized message binds to its canonical render input;
- evaluator assets have immutable digests.

It then writes the canonical lock and root ID atomically. Re-running the same completed generation journal returns the same lock reference. Re-running stochastic generation from scratch may produce another valid lock with another ID.

### 7. Build, admit, and seal

`build_from_lock` resolves the domain by committed ID and schema, then:

1. Verifies the Merkle-like artifact graph and all raw blob digests.
2. Re-runs deterministic parsers where the parser version is available and compares selected parsed values.
3. Re-runs deterministic domain computations such as SQL transforms.
4. Re-schedules every episode from committed inputs and compares the full state trace.
5. Re-renders canonical messages and validates frozen naturalized text.
6. Runs admission checks.
7. Splits public messages from private source records, native targets, partial targets, and evaluator assets.
8. Seals private material and writes `SealedExperiment`.

Admission includes:

- `locked_rebuild`: two clean-process builds produce the same semantic experiment ID;
- `source_pin_valid`: benchmark record and revision match the lock;
- `evidence_complete`: no selected value lacks raw or computation evidence;
- `trajectory_valid`: all state transitions reduce;
- `source_restored`: final function and every original source argument match;
- `no_hidden_leak`: public messages contain no gold answer or protected evaluator asset;
- `render_bound`: each message derives from its committed public delta;
- `evaluator_bound`: target and evaluator commitment match the source pin;
- `budget_valid`: turn count, switch count, and token policy match the suite.

An admission failure is data. The builder writes a rejected build report but no runnable experiment.

### 8. Run and evaluate

For each public episode, `experiment.py`:

1. Opens a fresh per-episode agent state.
2. Sends user messages in committed order and retains all prior user and assistant messages.
3. Records raw agent events, tool calls, outputs, usage, and final response.
4. Extracts the final answer under the committed domain policy.
5. Opens the sealed native target only inside the evaluator boundary.
6. Checks runtime asset digests against `EvaluatorCommitment`.
7. Calls `domain.evaluate`.
8. Writes the transcript and evaluation as immutable run artifacts.

Parallel episodes never append to one JSONL file. Each writes its own artifact. `RunReport` deterministically indexes them by episode ID. This makes retries idempotent and removes writer races.

## What the common kernel does not generalize

The common code generalizes artifact handling, provider evidence, retry accounting, intent transitions, scheduling constraints, rendering inputs, sealing, and execution records. It does not pretend that these domain facts are interchangeable:

- How to locate and pin a benchmark record.
- What counts as a function or argument.
- Which argument categories may change.
- Whether a counterfactual comes from an LLM, a database, or no valid operation.
- What makes a predecessor related, independent, executable, or container-compatible.
- Which scheduling overlay preserves domain meaning.
- How to render a state delta without leaking hidden values.
- What a native answer is and how correctness is measured.
- Which external assets, such as a SQL database, retrieval corpus, or Docker image, commit the verdict.

Adding a domain means implementing one `DomainSemantics` and registering it with `Parallax`. It does not mean adding a branch to `generator.py`, `simulation.py`, `experiment.py`, or `evaluation.py`.

## Provider policy and observability

`GenerationPolicy` assigns a model ladder and budgets by semantic role, not by domain file name:

```python
@dataclass(frozen=True)
class RolePolicy:
    models: NonEmptyTuple[ModelSpec]
    transport_retries: int
    parse_retries: int
    semantic_retries: int
    timeout_seconds: int
    max_output_tokens: int

@dataclass(frozen=True)
class GenerationPolicy:
    roles: FrozenMap[str, RolePolicy]
    total_call_budget: int
    seed: int
```

Typical roles include `extract.decompose`, `extract.conversationalize`, `extract.coverage`, `extract.solvability`, `counterfactual.generate`, `predecessor.generate`, `predecessor.similarity`, `predecessor.independence`, `render.naturalize`, and SWE or SQL roles declared by their domains.

The lock records the resolved model and settings on every attempt. "Fallback model" is never an unrecorded implementation detail. Logs may summarize evidence IDs, but logs are not provenance.

## Migration plan

This is a replacement, not a permanent compatibility layer.

### Release 1: build the new path beside legacy code, but keep it private

- Add the new artifact, provider, simulation, experiment, domain, and built-in domain modules.
- Do not export the new types through the old modules.
- Build real lock fixtures with provenance and the verification work described below.
- Freeze feature work in `evolving_intent.py`, the intent portions of `variants.py`, and the experiment-building portions of `kernel.py`.

### Release 2: switch all callers and tests

- Make `Parallax.generate`, `Parallax.build_from_lock`, and `Parallax.run` the public API.
- Replace fabricated `proposal.json` and hand-authored fixtures with lock fixtures produced by recorded provider traces and pinned source records.
- Port CLI and experiment recipes to the three operations.
- Move GSM8K native parsing and scoring into `domains/gsm8k.py`.
- Move SWE source, overlay, and harness binding into `domains/swebench_verified.py`.
- Move campaign reporting that is still useful out of `autoresearch.py`; it consumes `RunReport` and no longer creates conversations.

### Release 3: delete shortcuts

- Delete `ProposalBundle`, `IntentEvent`, `SynthesisPlan`, `compile_plans`, and `replay_plan` from `evolving_intent.py`, then delete the file.
- Delete the duplicate trajectory and intent-state models from `variants.py`. Move any unrelated budget value into `artifacts.py` only if it still has a caller.
- Delete conversation generation and rendering from `autoresearch.py`.
- Delete GSM8K-specific construction branches and the legacy `build` and `run` path from `kernel.py`.
- Delete `compile_swebench_arms` and the disconnected SWE episode model after its callers use the domain object.
- Remove legacy fixture loaders and claims that self-consistent hand-authored proposals are upstream-compatible.

A one-shot `parallax migrate-legacy-manifest` command may report which source records and suite settings must be regenerated. It must not convert fabricated provenance into a valid generation lock. There are no runtime adapters from old proposal objects to new locks and no indefinite deprecation aliases.

## Verification designed before implementation

### 1. Pinned upstream characterization

Create a test-only checkout of Microsoft Evolving Intent at `993d6be9597ac03854b46362ccd647eb1bfd267a`. For selected source IDs, run its real entry points and capture:

- prompt assets and provider requests;
- raw provider responses through a record/replay transport;
- every stage JSON output;
- scheduler scenario configuration and transition trace;
- rendered conversations;
- native evaluator inputs and verdicts.

Use at least two records per built-in domain, including one retry or rejection case where feasible. The compatibility projector converts upstream data into semantic observations:

```python
@dataclass(frozen=True)
class Characterization:
    source_id: str
    function: str
    original_arguments: tuple[str, ...]
    counterfactual_links: tuple[tuple[str, str], ...]
    ordered_functions: tuple[str, ...]
    transition_kinds: tuple[str, ...]
    final_function: str
    final_original_arguments: tuple[str, ...]
    native_verdict: bool
```

Tests compare those observations, not byte-for-byte generated prose. Deterministic domain operations get stronger assertions:

- exact BIRD change and preserve plans, AST clauses, partial SQL, and execution result;
- exact SWE G1, G2, G3 chain positions and source G3 identity;
- exact scheduler transition kinds and final restoration;
- exact evaluator target and asset commitments.

Each checked-in characterization fixture contains the upstream commit, source revision and record digest, prompt digests, raw-response digests, and the script command that made it. A fixture without those fields fails schema validation.

This test is falsifiable. Reversing the predecessor chain, dropping coverage verification, accepting a leftover counterfactual, dumping the source question at the end, or scoring SQL by string equality will fail an observation.

### 2. Deterministic fake provider

`ScriptedProvider` indexes replies by semantic role and normalized request digest. A script can return a transport error, malformed JSON, semantically invalid content, and then a valid response on a stronger model.

Tests prove:

- raw bytes are stored before parse;
- malformed and rejected attempts remain reachable from the lock;
- retries stay on the current model until its budget ends;
- escalation uses the next committed model;
- a crash after any blob write resumes without duplicating accepted work;
- parallel generation yields the same merged lock as serial generation;
- exhausted required work produces a journal and no lock;
- two builds from one lock make byte-identical public projections and equal semantic IDs without provider access.

The fake provider fixtures cover the complete GSM8K vertical path first, then each domain-specific branch.

### 3. Negative ignore-history control

Create paired deterministic agents:

- `HistoryAwareOracle` reads the whole transcript and updates its answer from every user delta.
- `LastMessageOracle` sees only the latest user message.

On under-specified, argument-revision, function-switch, and combined fixtures, the history-aware oracle must pass native evaluation. The last-message oracle must fail a committed minimum fraction, including every fixture selected specifically for a missing earlier argument. The test also asserts that the final message lacks the full source-question digest and at least one required source argument.

If both agents pass because the renderer reconstructs the problem at the end, the experiment is invalid even if identity and replay tests pass.

### 4. One live generation smoke test

A manual and nightly test uses one pinned GSM8K test record and the lowest-cost supported real provider configuration. It runs:

```text
source pin
  -> extraction and checks
  -> two counterfactuals
  -> two chained predecessors
  -> combined three-turn schedule
  -> canonical render and naturalization
  -> lock close
  -> offline build
  -> scripted history-aware run
  -> GSM8K native evaluation
```

The test asserts that every stochastic role has a non-empty raw-response blob from the real provider, the lock has no fake-provider marker, the offline build succeeds with egress disabled, final state equals source intent, and native evaluation passes. It stores the produced lock as a CI artifact but does not silently update checked-in fixtures.

### 5. Tamper and boundary tests

Mutate one committed fact at a time:

- source number;
- counterfactual link;
- predecessor order;
- selected attempt;
- naturalized message;
- final original binding;
- SQL database;
- BrowseComp index;
- SWE Docker image or test spec;
- evaluator prompt;
- public message with a sealed answer.

Each mutation must change identity or fail digest verification, admission, or runtime commitment checking. Tests also import `build_from_lock` and `run` in an environment where provider packages are absent.

### 6. Domain extension contract test

The inventory domain shown in usage lives entirely in tests. The common package is installed as a wheel, so the test cannot edit it. The test generates, builds, runs, and evaluates one inventory record. This proves extension by implementation rather than by adding a benchmark branch to common code.

## Dominant access paths

The design keeps the frequent operations direct:

```text
Caller generate
  -> api.Parallax
  -> generator.GenerationEngine
  -> one DomainSemantics plus evidence-recording DomainContext

Caller build_from_lock
  -> api.Parallax
  -> experiment.ExperimentBuilder
  -> simulation reducer and one DomainSemantics

Caller run
  -> api.Parallax
  -> experiment.ExperimentRunner
  -> committed DomainSemantics evaluator
```

Inspecting an episode follows `experiment -> lock ID -> plan -> evidence IDs` through typed artifact references. There is no scan across stage output directories and no join on loosely related string IDs.

## Red-flag screen

### Shallow module

Pass. The caller learns three operations. `generate` hides stage ordering, retry and escalation, evidence capture, parallel merge, domain construction, scheduling, and rendering. `build_from_lock` hides replay, admission, identity, public-private projection, and sealing. `run` hides the agent loop and evaluator runtime. Internal domain authors face a larger contract because they own benchmark meaning; ordinary callers do not.

The design rejects public stage methods and a large configuration object that exposes internal prompt or retry mechanics.

### Information leakage

Pass with one pressure point to watch. External benchmark JSON, provider wire responses, SQL AST objects, Hugging Face rows, Docker harness objects, and FAISS objects do not cross their owner boundaries. Common code sees typed intents, evidence references, plans, messages, and evaluator commitments.

The pressure point is `domain_payload` on counterfactuals and predecessor checks. It remains private `FrozenJson` committed by the owning domain and never drives common scheduling. If common code begins branching on its keys, the design has failed.

### Temporal decomposition

Pass. The architecture does not create generic `extraction.py`, `counterfactual.py`, and `predecessor.py` modules that pass one sprawling record through time. `generator.py` owns one transaction. Each domain module owns all operations that depend on that benchmark's meaning, even though the operations happen at different times. `simulation.py` owns the state machine for both scheduling and replay.

### Pass-through method

Pass. The CLI calls the public facade directly. `Parallax` adds domain resolution, dependency exclusion, and artifact-store policy before calling the owning engine. There are no controller, service, manager, and repository layers forwarding the same argument list. `DomainContext.generate` is justified because it records raw evidence and enforces retry budgets; domains cannot call a provider beneath it.

## Rationale

### Problem

Parallax needs actual Evolving Intent construction while preserving its useful deterministic identity and sealing work. The difficult part is that upstream shares an intent trajectory but not one construction recipe or one evaluator. Treating the four benchmarks as parameterized prompt sets would either hard-code domain branches in the kernel or erase SQL, search, and SWE correctness semantics.

### Usage, caller's view

The three calls at the start are the design constraint. A caller chooses a pinned source, a suite, a domain, and provider policy once. The caller receives a lock, deterministically builds an experiment, and runs an agent. Extension authors implement one cohesive domain object; they do not register a pile of independent callbacks.

### Shape

The central decision is a compiler boundary at `GenerationLock`. Everything that may call a generation model, including optional naturalization, happens before the lock closes and leaves raw evidence. Everything after it is deterministic except the evaluated agent and any evaluator-native judge, whose evidence belongs to the run. One typed reducer defines intent state and proves final restoration against source argument IDs.

This produces a deep public interface. Three methods hide the whole construction and experiment lifecycle, while immutable values make incomplete extraction, ambiguous counterfactual eligibility, malformed chains, and unrestored plans difficult to represent. Domain packages are vertical because the benchmark's extraction and evaluator must agree.

### Synthesis decision

This candidate recommends the locked intent compiler as the base. Its non-negotiable pieces are the stochastic lock boundary, one source-ID-based intent reducer, vertical domain ownership, and evaluator commitments made before execution. An arena synthesis may change names or storage details without weakening those four choices.

### Tradeoffs accepted

- We accept that a suite must be chosen during generation in exchange for freezing stochastic naturalization and keeping `build_from_lock` offline.
- We accept a substantial `DomainSemantics` contract in exchange for removing benchmark switches and preventing incoherent mix-and-match plugins.
- We accept larger lock artifacts in exchange for retaining rejected raw responses, parser results, judges, and escalation evidence.
- We accept hard failure when requested variants cannot be produced in exchange for stable suite cardinality and honest provenance.
- We accept semantic rather than exact text parity with upstream in exchange for provider and model evolution, while keeping exact parity for deterministic transforms and intent traces.
- We accept a hard API migration in exchange for deleting four conflicting intent models and false compatibility paths.

### Alternatives considered

**A generic stage plugin graph.** This would register extractor, counterfactual generator, predecessor generator, scheduler overlay, renderer, and evaluator independently. It looks flexible but lets callers construct invalid combinations such as SWE extraction with a generic function switch and GSM8K scoring. The interface exposes the implementation graph and hides little. It lost.

**Keep the current kernel and add missing callbacks.** This preserves existing names but leaves GSM8K assumptions, duplicate intent models, and fabricated proposal compatibility in the center. Every new domain would need to understand legacy family arms and magic-goal replay. It hides migration work, not domain complexity. It lost.

**Generate semantic data first, naturalize during build or run.** This gives callers late control over style, but a locked rebuild would call a provider or would not reproduce messages. It also makes message identity depend on runtime availability. It lost because deterministic replay is a stated requirement.

**Vendor the upstream repository and wrap its CLIs.** This offers quick apparent parity, but its mutable stage files, checkpoint conventions, inconsistent per-domain scripts, and online simulation paths do not provide Parallax identity or sealing. Callers would still coordinate several commands and output paths. It is useful as a characterization oracle, not the architecture.

### Open questions and risks

- Which provider response fields can be retained under production data policies, and must some raw bodies use encrypted content-addressed storage?
- Should evaluator-native LLM judges be permitted for final published scores, or only as secondary verdicts beside deterministic native checks?
- Which exact BrowseComp+ corpus and index build can the project legally redistribute or require by digest?
- Can every SWE-bench runtime resolve a stable Docker image digest across architectures, or must admission restrict supported platforms?
- Should naturalization be mandatory for paper-compatible suites, given its cost and the risk that validators miss a semantic leak?
- How many upstream characterization records per domain give useful regression coverage without making tests dependent on large private assets?
- Does BIRD partial-SQL evaluation belong in released metrics, or only in diagnostic run artifacts?

### Next implementation step

Build one GSM8K record end to end with `ScriptedProvider`, including extraction checks, two counterfactuals, a two-predecessor chain, a combined plan, final source-state restoration, a generation lock, offline rebuild, the ignore-history negative control, and native grading.
