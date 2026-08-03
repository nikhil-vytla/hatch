# Parallax research protocol architecture

This directory keeps its historical name, but its scope is larger than an
Evolving Intent implementation. It defines the minimum architecture required
for Parallax to investigate agent failure modes, turn observations into
falsifiable questions, construct controlled tasks and environments, run
experiments, and retain evidence that can support the next question.

[`FORMAL-MODEL.md`](FORMAL-MODEL.md) is the authoritative notation and claim
boundary for this architecture. It distinguishes source recurrences, Parallax
commitments, executable invariants, empirical estimands, and mechanism
hypotheses. [`LITERATURE-REVIEW.md`](LITERATURE-REVIEW.md) records the inspected
source revisions, reproducibility boundaries, causal limits, and intervention
evidence behind those decisions. [`DESIGN-SELECTION.md`](DESIGN-SELECTION.md)
preserves the four-candidate arena inputs, cross-judge result, selected base,
grafts, rejections, and unresolved asset question.

Labels used below:

- **Fact** — supported by a cited primary source or surviving Parallax artifact.
- **Decision** — architecture selected for Parallax.
- **Hypothesis** — a claim an experiment may test, not a system fact.
- **Unknown** — evidence or a researcher choice is still missing.

## Caller usage

**Decision.** The following is target usage, not the current Parallax API. The
first useful replacement API is a research protocol, not a general plugin
framework:

```python
question = ResearchQuestion(
    statement="Does revising active constraints reduce terminal success?",
    unit="source task × model × repetition",
    estimand="paired reward difference: evolved minus turn-matched control",
)

design = ExperimentDesign(
    question=question,
    conditions=(static, turn_matched, evolving_intent),
    assignment=BlockedRandomization(by=("source_task", "model")),
    repetitions=5,
    metrics=(terminal_reward, invalid_submission_rate, tool_budget_use),
    stopping=FixedSample(),
)

family = build_family(
    source=gsm8k_record,
    strategy=EvolvingIntentStrategy(pinned_upstream, frozen_provider),
    design=design,
    domain=Gsm8kDomain(),
)

admitted = admit(family, protocol=characterization_receipt)
report = await run_experiment(admitted, models=models, runtime=runtime)
analysis = compare(report, design)
record_evidence(question, design, report, analysis)
```

Checkpoint evolution is deliberately different:

```python
sequence = build_sequence(
    problem=pinned_slop_problem,
    strategy=CheckpointEvolution(),
    design=quality_prompt_contrast,
    domain=BlackBoxCliDomain(),
)
```

The shared calls are protocol-level. `build_family` and `build_sequence` return
different strategy records and execute through different state machines.

## Are we there yet?

No.

**Fact.** Parallax has useful, separately proven pieces:

- content-addressed public and sealed identity in `src/parallax/ids.py`,
  `src/parallax/models.py`, and `src/parallax/kernel.py`;
- deterministic GSM8K family build, lock, admission, and scalar replay in
  `tests/test_synthesis_kernel.py`;
- repository task compilation and adversarial grading in
  `src/parallax/compiler.py` and `src/parallax/grading.py`;
- a persistent synthetic Docker episode, a local SWE-bench Lite episode, and a
  hosted synthetic canary under `architecture/episode-spine/`;
- synthetic campaign records and paired repeat controls in
  `src/parallax/autoresearch.py`;
- a decision log in `autoresearch/decisions.tsv`.

**Fact.** Those pieces do not form the requested research loop:

- the accepted GSM8K proposal is hand-authored and does not execute Microsoft
  extraction, counterfactual, predecessor, scheduling, or rendering stages; its
  prompt/response digests are placeholder-shaped strings and its
  `school_supply_sales` context does not match the Natalia's clips source task;
- `CheckpointPlan`, `WorkspaceEpisode`, and `CheckpointSequence` are
  non-executing placeholders;
- no type records a research question, estimand, assignment policy,
  pre-registered analysis, uncertainty, stopping rule, or causal limitation;
- no accepted runner randomizes, blocks, replicates, or compares interventions
  under a single immutable experiment plan;
- no evidence store links an observation to a mechanism hypothesis,
  intervention, outcome, analysis, and resulting decision;
- current domain support is uneven: GSM8K is executable, repository recipes are
  executable through a separate path, and BIRD-SQL and BrowseComp+ have no
  admitted path;
- no checkpoint-evolution strategy has been built in Parallax;
- no training environment links a policy update to an immutable intervention
  and train/evaluation split.

The current code proves lifecycle fragments and feasibility. It does not yet
identify failure modes reliably, support causal claims about training, or
generate the next hypothesis from accumulated evidence.

## Capability gap assessment

### 1. Observe and diagnose

**Proven.** `RunRecord` preserves responses, trace IDs, status, timing, and
reward for synthetic conversations. `TreeSnapshot` captures candidate trees.
Episode-spine artifacts preserve several runtime and calibration receipts.

**Partial.** The records distinguish provider and harness errors from some
model outcomes, but the taxonomies differ across `autoresearch.py`,
`grading.py`, and the episode prototype. Trace and environment commitments are
not uniformly identity-bearing.

**Missing.** A cross-runtime observation schema, capability checks before
measurement, trace completeness checks, and diagnosis that can compare
behavior without claiming a mechanism.

**Retract.** The Qwen3 8B zero is not a model-capability or training failure.
The raw rows show invalid submissions and no tracked changes. The only supported
conclusion is that this run did not produce a valid patch and showed no
matched-to-evolved difference.

### 2. Formulate a falsifiable hypothesis

**Proven.** Historical notes state hypotheses.

**Partial.** `VariantBlueprint.research_question` and campaign conditions name
questions, but they do not define units, estimands, alternatives, assumptions,
or falsifiers.

**Missing.** Typed `ResearchQuestion`, `MechanismHypothesis`, and
`CausalContrast` records with explicit observable predictions and limits.

**Retract.** A generated condition name is not a research question, and a model
zero is not evidence of a training mechanism.

### 3. Operationalize an intervention

**Proven.** Static, matched, and evolved schedules exist for synthetic tasks
and one SWE-bench Lite instance. Prompt interventions exist as campaign
metadata.

**Partial.** Some arms match turn count, but static versus multi-turn budgets
are not equal; the SWE precursor write policy is instructed rather than
enforced.

**Missing.** An immutable intervention record, explicit treatment/control
construction rule, policy exposure, fidelity checks, and contamination audit.

**Retract.** Prompted read-only behavior is not a staged runtime policy.

### 4. Construct tasks and environments

**Proven.** Repository recipes construct executable counterfactual tasks;
GSM8K frozen records construct deterministic families; the episode prototype
constructs one persistent workspace.

**Partial.** Evolving Intent exists only as an incomplete frozen proposal
format. SWE-bench uses bespoke schedules. The symbolic `variants.py` layer is
disconnected from generation and execution.

**Missing.** Real Evolving Intent generation, checkpoint problem import and
validation, explicit domain catalogs, environment identity, and train/eval
dataset construction.

**Retract.** The current `ProposalBundle` fixture is not Microsoft Evolving
Intent output and does not characterize paper parity.

### 5. Admit and verify

**Proven.** Repository gold/starter checks, tree integrity, GSM8K oracle and
wrong-answer checks, deterministic locked rebuild, and family-level admission.

**Partial.** The episode grader does not use `TreeSnapshot`; the local
SWE-bench episode runs a focused command rather than the full official harness.

**Missing.** Characterization against real upstream fixtures, tamper checks for
external assets, custom wheel-installed domain contracts, and verified
checkpoint problem authoring.

**Retract.** The local episode is not a full official-harness invocation, and
the existing SWE proof is Lite rather than the planned Verified milestone.

### 6. Run controlled experiments

**Proven.** Synthetic campaigns in `autoresearch/results/` repeat some
task-condition pairs and compare against repeat controls. HUD can run grouped
tasks.

**Partial.** There is no immutable assignment schedule, balanced missing-data
policy, or common budget contract across the complete run.

**Missing.** Blocking, randomization, replication, negative controls,
capability gates, cost ceilings, and pre-registered stop/abstain handling.

**Retract.** The six-run SWE intent comparison is neither a controlled null nor
evidence that intent has no effect: one model was at ceiling, one produced
invalid submissions, and each arm had one run.

### 7. Analyze and compare

**Proven.** `summarize_records` in `src/parallax/autoresearch.py` reports
condition accuracy and paired mean deltas.

**Partial.** It has no confidence intervals, effect-size definition, model/task
hierarchy, multiplicity handling, or sensitivity analysis.

**Missing.** A pre-registered analysis executor that refuses contrasts not
declared in the design.

**Retract.** A paired mean delta from the current summary is descriptive; it is
not an identified treatment effect.

### 8. Record evidence

**Proven.** JSON/JSONL artifacts, content digests, locks, notes, and
`decisions.tsv` exist.

**Partial.** Several receipts are mutable, prose-only, or point to source code
rather than the exact run.

**Missing.** Immutable `RunReport`, `AnalysisReport`, `DecisionRecord`, and
typed links among them; a retention and redaction policy; signed or
content-addressed external asset manifests.

**Retract.** `architecture/episode-spine/deployment.json` is a mutable latest
receipt, not sufficient historical evidence for every deployment attempt.

### 9. Generate the next hypothesis

**Proven.** Humans have used `autoresearch/decisions.tsv` to choose later
campaigns.

**Partial.** The old controller selected a next condition from summary data but
once chose a tied condition incorrectly.

**Missing.** A bounded proposal step that cites evidence, states uncertainty,
and emits candidate questions for human review. It must never promote a
correlation or zero reward into a causal mechanism automatically.

**Retract.** The old condition selector is not a hypothesis-generation system;
it encoded a campaign-specific heuristic and failed under saturation.

## Research protocol and foundational records

**Decision.** Keep a small protocol with six ownership layers. Do not force
paper-specific state into a universal task algebra.

### Research question and causal design

Minimum immutable records:

- `Observation`: behavior seen in a run, with evidence references;
- `BehavioralFailure`: an operational predicate over observations;
- `MechanismHypothesis`: proposed explanation, assumptions, and competing
  explanations;
- `ResearchQuestion`: unit, population, estimand, falsifier, and scope;
- `Intervention`: one controlled policy, prompt, training, task, or environment
  change;
- `Condition`: intervention assignment plus all held-constant commitments;
- `ExperimentDesign`: conditions, controls, assignment, repetitions, metrics,
  missingness, stopping, and causal limitations.

These records contain no model calls, task-generation code, or verifier logic.

### Synthesis strategy

Each strategy owns its native proposal and transition records:

- Evolving Intent owns intent extraction, counterfactual arguments,
  predecessor functions, turn slots, and intent replay.
- Checkpoint Evolution owns ordered specification checkpoints, persistent
  workspace snapshots, reset policy for non-workspace state, and cumulative
  regression obligations.
- Future strategies add a concrete constructor and verifier contract. They do
  not subclass a speculative transformation base class.

The only shared output is a strategy-tagged `ConstructedCondition` containing
content references, runtime requirements, and claimed invariants.

### Domain adapter and native verifier

A domain constructor is explicit:

```python
catalog = DomainCatalog(
    gsm8k=Gsm8kDomain(...),
    bird_sql=BirdSqlDomain(...),
)
```

There is no closed domain enum, import-time global registry, or discovery
magic. A third-party wheel can construct a catalog entry explicitly. The
reviewable import graph remains finite.

A domain owns source ingestion, safe/sealed projection, proposal checks,
submission parsing, native evaluation, oracle, known-wrong controls, and asset
manifest validation. If a strategy requires semantics the domain cannot
validate, construction refuses rather than escaping through generic strings.

### Runtime and RL environment

`EnvironmentSpec` commits:

- initial state and reset distribution;
- observation schema and visibility;
- action schema and tool surface;
- transition function and termination;
- budget and cost accounting;
- reward authority and abstention conditions;
- runtime image, harness, dependency, and asset digests;
- network and filesystem policy;
- train, validation, and evaluation split membership.

`PolicySpec` commits the model, agent harness, prompt, decoding/reasoning
parameters, tool policy, and intervention exposure. A benchmark run evaluates
a fixed policy in an environment. Training additionally requires an update
algorithm, optimizer/reward configuration, data sampling policy, and checkpoint
lineage. Benchmark evaluation alone cannot identify how training caused an
observed behavior.

### Experiment and calibration

`AssignmentPlan` fixes randomized or blocked condition order before calls.
`CapabilityGate` verifies that the model/harness can produce valid submissions
on controls. `RunReport` records every assigned unit, including failures and
missing runs. `AnalysisPlan` is frozen before results. `AnalysisReport` may
execute only declared contrasts.

Calibration selects task-model regions where controls are neither floor- nor
ceiling-saturated. It is not a hidden retry loop that discards inconvenient
models or tasks after seeing treatment outcomes.

### Evidence and decisions

`EvidenceRef` points to immutable content and states whether it is public,
sealed, redacted, or external. `DecisionRecord` links facts, design choices,
hypotheses, superseded claims, and the exact receipts supporting each.
Operational telemetry such as request IDs, timestamps, and billing belongs in
a sidecar: retained for audit, excluded from semantic identity. Requests,
responses, parses, validator versions, prompts, model parameters, and seeds are
identity-bearing.

## Failure-mode taxonomy

The harness must keep four nouns separate:

1. **Observed behavioral failure** — a declared predicate failed, such as
   invalid patch submission, stale constraint use, regression loss, increased
   erosion, or tool-budget exhaustion.
2. **Hypothesized mechanism** — a possible cause, such as belief-state update
   failure, poor early architecture, harness incompatibility, or insufficient
   base capability.
3. **Intervention** — a controlled change intended to affect the mechanism,
   such as oracle recap, turn-matched repetition, plan-first prompting, or
   training on evolving-intent examples.
4. **Measured outcome** — reward, validity, cost, erosion, verbosity, tool use,
   or a pre-registered derived effect.

A measured zero can establish an observed failure only after the submission is
valid and the harness capability checks pass. It cannot establish a mechanism.
Attribution requires a contrast that changes the proposed mechanism while
holding plausible alternatives fixed.

Run attempts use one rejection taxonomy:

- `transport`: no usable provider/runtime response;
- `provider`: provider rejected or failed the request;
- `parse`: bytes or text could not be parsed;
- `schema`: parsed data violated the declared schema;
- `semantic`: schema-valid data violated domain invariants;
- `judge`: an explicitly committed judge rejected it.

Schema- and semantic-rejected attempts retain their parsed blobs. No rejection
is rewritten as model failure.

## The three concrete instantiations

### Microsoft Evolving Intent: synthesis state machine

**Fact.** The paper defines latent intent
`I_t = (f_t, C_t, C_rev_t, y_t)`: active function, argument set, revealed
arguments, and answer authority. The agent observes rendered utterances and
history, not `I_t`. A reveal expands `C_rev`; a revision changes at least one
revealed value while retaining the function; a switch changes the function and
may carry shared arguments.

The source task `(q, y*)` is extracted into `(f*, C*)`, which is fixed as the
terminal anchor. Counterfactual values support revisions. Recursively generated
predecessor functions support switches. The scheduler chooses events before
rendering, enforces reveal-before-revision, predecessor-before-source,
reveal-before-switch, one active function, and a fully revealed terminal
anchor. The default renderer emits only the state delta.

**Decision.** Parallax will represent that source behavior with these
strategy-owned records:

```python
ArgumentId = NewType("ArgumentId", str)
FunctionId = NewType("FunctionId", str)

@dataclass(frozen=True)
class Argument:
    id: ArgumentId
    name: str
    value: JsonValue

@dataclass(frozen=True)
class Function:
    id: FunctionId
    description: str
    arguments: tuple[Argument, ...]

@dataclass(frozen=True)
class IntentFrame:
    function: Function
    revealed: frozenset[ArgumentId]
    answer_authority: EvidenceRef

IntentEvent = Reveal(argument) | Revise(argument, old, new) | Switch(before, after)

@dataclass(frozen=True)
class IntentGraph:
    terminal: Function
    predecessors: tuple[Function, ...]
    counterfactuals: tuple[Counterfactual, ...]
    calls: tuple[Attempt, ...]

@dataclass(frozen=True)
class IntentPlan:
    initial: IntentFrame
    events: tuple[IntentEvent, ...]
    terminal: IntentFrame
    rendering: RenderingSpec
```

`replay(initial, event)` is a total transition only when:

- `Reveal(a)` has `a` in the active function and not yet revealed;
- `Revise(a, old, new)` has `a` revealed, `old` equal to its active value, and
  `new` equal to the next counterfactual/source value in its committed chain;
- `Switch(before, after)` has `before` fully revealed, `before` equal to the
  active function, and `after` equal to the next function in the committed
  predecessor-to-source chain.

The scheduler fills a fixed sequence of typed event slots, then replays it to
prove every precondition and the terminal predicate:

```text
active function = source function
revealed arguments = all source arguments
active values = source values
answer authority = source benchmark answer/verifier
```

Generation is not replay. Extraction produces the terminal `Function`;
counterfactual generation produces revision chains; predecessor generation
produces the function chain; scheduling consumes those immutable proposals;
rendering consumes the replayed deltas. Parallax will retain accepted and
rejected attempts at every stage and refuse when a bounded attempt policy is
exhausted.

At the pinned repository revision
`993d6be9597ac03854b46362ccd647eb1bfd267a`, production compatibility must also
preserve these verified details:

- extraction retries but does not escalate its prompt;
- predecessor generation escalates at `max_attempts // 2`;
- revision chains order counterfactual variants as `[v2, ..., vN, source]`;
- `create_sample_swe` removes symptom-category arguments before calling the
  generic scheduler, then its post-fill hook re-injects those symptom arguments
  at the front of the appropriate slot or slots before text rendering;
- SWE refuses the recap/dump combination;
- generated argument ID ranges use offsets 100, 1000, and 2000;
- upstream currently has an `EvolvingIntent` class-name collision;
- upstream prefix counters are mutable runtime state and must not be copied.

The [pinned SWE overlay characterization](characterization/UPSTREAM-SWE-OVERLAY.md)
records the immutable source links, blob and content hashes, and exact ranges
that support the scheduler correction above.

**Decision.** Structural scheduler parity is primary. Exact rendered text is
also checked under injected deterministic prefix stubs. Production rendering
uses immutable inputs. `from_upstream_json` imports upstream output with its
source digest and marks it `imported`; it is allowed for characterization but
refused at sealing and production-family admission.

### arXiv 2607.20734: experimental protocol

**Fact.** The paper asks four questions: whether single-turn performance
transfers; how transition type, count, composition, and order affect
performance; whether recap mitigations recover performance; and how source-task
difficulty changes the effect.

It evaluates 200 GSM8K, 100 BIRD-SQL, 100 BrowseComp+, and 50 SWE-bench
Verified examples after full generation and verification. The main treatment
uses two reveals, two revisions, and two switches, up to seven turns. Original
native evaluators score the final action. BrowseComp+ caps search calls at 50
per turn. SWE wraps policies in mini-SWE-agent v2 with 100 tool calls per turn,
raised to 200 for Kimi K2.6 and DeepSeek V3.2. Models use default/medium
reasoning and greedy decoding where supported.

Controls and analyses include single-turn source performance, isolated
transition types and counts, transition compositions, switch position/order,
prompt recap, oracle recap, the same BIRD-SQL query with or without its external
knowledge hint, turn-wise intent prediction judged separately, reasoning mode,
model capacity, and turn-matched repeated turns with no intent change. The
turn-matched control shows that added turns alone did not explain the measured
drop. A preliminary Qwen3-4B GRPO run under final outcome reward improved
evolving-intent accuracy from 64% to 76% in fewer than 50 steps while preserving
the reported single-turn score.

**Causal limits.** Final reward verifies only the terminal anchor. Intermediate
turns are not natively verified. Generated components rely on GPT 5.1 and LLM
judges. Utterances are stylistically narrow; each turn assumes one transition;
the sample is filtered to examples that survive generation and verification;
tool budgets differ for two models; and the RL result is a preliminary
before/after demonstration, not an identified training effect. The paper's
belief-state explanations are plausible interpretations, not isolated
mechanisms.

### SloP Code Bench: checkpoint state machine

**Fact.** A problem is an ordered sequence `[C_1, ..., C_n]`. At checkpoint
`i`, policy `π` receives specification `x_i` and its own prior workspace
`y_(i-1)`, then produces `y_i = π(x_i, y_(i-1))`; `y_0` is empty. The prior
conversation is not provided. Current, hidden, and prior regression tests score
each resulting workspace. Correctness, structural erosion, and verbosity are
measured at every produced checkpoint.

The released runner creates a fresh agent context per checkpoint while retaining
the workspace snapshot. Fresh containers reset installed packages, shell
history, and agent session data; the working directory persists. The current
repository stores problem definitions in a separately pinned `scb-problems`
catalog and records its commit for resume reproducibility.

**Decision.** Parallax will represent that source behavior with these
strategy-owned records:

```python
@dataclass(frozen=True)
class Checkpoint:
    index: int
    specification: EvidenceRef
    current_tests: EvidenceRef
    regression_tests: tuple[EvidenceRef, ...]
    budget: Budget

@dataclass(frozen=True)
class CheckpointProblem:
    source: PinnedProblemCatalog
    checkpoints: tuple[Checkpoint, ...]
    assets: tuple[AssetCommitment, ...]

@dataclass(frozen=True)
class WorkspaceState:
    completed: int
    snapshot: TreeSnapshot
    prior_results: tuple[CheckpointResult, ...]

@dataclass(frozen=True)
class CheckpointResult:
    before: TreeSnapshot
    after: TreeSnapshot
    policy_run: RunReport
    native_verdict: Verdict
    diagnostics: tuple[Metric, ...]
```

For checkpoint `i`, the transition is:

```text
input = (checkpoint[i].specification, workspace[i-1])
ephemeral agent context = empty
ephemeral container state = clean image
workspace mount = materialize(workspace[i-1].snapshot)
workspace[i] = snapshot(policy(input))
verdict[i] = native_tests(current[i] + regression[1..i-1], workspace[i])
```

**Fact.** Only the working directory persists between released SloP
checkpoints.

**Decision.** Parallax will refuse out-of-order indices, a before-snapshot
mismatch, modified hidden tests, missing regression obligations, or an
environment/image digest mismatch. Correctness will be reward authority.
Erosion and verbosity remain diagnostic measurements unless an experiment
pre-registers a composite outcome.

Problem construction is human proposal and validation, not a stochastic
checkpoint generator: authors define a black-box language-agnostic contract,
partition it into cumulative checkpoints, write hidden tests, run agents to
find ambiguity, and obtain independent review. Specifications must not
prescribe internal interfaces or reveal tests. Later checkpoints extend prior
behavior, and prior tests become regression obligations.

The paper's RQs measure iterative extensibility, degradation, comparison with
473 repository histories, and prompt interventions. Its treatment conditions
are `just-solve`, `anti-slop`, and `plan-first`; it reports strict, isolated,
core, partial, cost/time, erosion, and verbosity. It uses one reported run per
model configuration selected as the best just-solve run, two-hour limits, no
turn/cost cap, native CLI harnesses, and a Python-only empirical track.

**Causal limits.** SloP demonstrates degradation under its benchmark protocol,
not that iteration alone or a specific training process caused it. Problems
are hand-authored and filtered, prompt comparisons trade quality, correctness,
and cost, the human repository panel is not a randomized counterfactual, and
the published metrics are proxies rather than direct maintenance-cost
measurements.

## Genuinely shared invariants

**Decision.** Only these invariants are promoted across all three:

- immutable source/problem and implementation revisions;
- a frozen proposal or authored-spec record before evaluation;
- explicit condition/intervention identity;
- deterministic public/sealed artifact identity after construction;
- admission before use;
- committed environment, policy, budget, and verifier authority;
- complete run evidence, including invalid and failed attempts;
- separation of correctness/reward from diagnostic metrics;
- analysis tied to an immutable experiment design;
- claims no stronger than the contrast and evidence permit.

Conversation intent state, checkpoint workspace state, reward timing, reset
semantics, metrics, and synthesis algorithms are not shared.

## Experimental-design gates

**Decision.** Every experiment must declare and enforce:

1. treatment and control construction from the same sampling frame;
2. semantic and budget parity, or an explicit estimand for the difference;
3. blocked random assignment of condition order by task and model;
4. independent repetitions and seed policy;
5. source-task and model/harness capability gates;
6. negative controls for harness, context length, and verifier leakage;
7. contamination checks for public tasks, prompts, gold, and generated outputs;
8. pre-registered primary/secondary metrics and missing-data handling;
9. effect sizes and uncertainty, not only aggregate accuracy;
10. fixed-sample or sequential stopping rules defined before outcomes;
11. abstention rules limited to infrastructure faults that reproduce on an
    untouched control;
12. sensitivity analysis for judge stochasticity, budget, and filtering.

Failed capability gates produce an inconclusive experiment, not a negative
model result.

## Verification and asset feasibility gate

No production implementation starts before the characterization spike resolves
the following:

- **GSM8K:** source records and scalar evaluation can run offline once the
  pinned dataset record is present. Upstream ships evaluation IDs but not
  generated Stage-3 conversations. Generation parity needs live or captured
  provider calls.
- **BIRD-SQL:** pure parsing and scheduler logic can be characterized from code.
  Native execution, counterfactual executability, and hint ablations require the
  pinned BIRD database tree and evidence. Those assets are not in the Microsoft
  repository.
- **BrowseComp+:** source logic can be inspected, but native search, corpus/index
  use, gold access, and evaluator-native judge calls require the licensed
  corpus/index and live model. Judge model, prompt, parameters, raw request, and
  raw response are run identity.
- **SWE-bench:** `create_sample_swe` symptom removal and post-fill,
  front-of-slot re-injection can be characterized from code. Native evaluation
  requires pinned dataset rows, repositories, images, test specs, and harness.
  Current Parallax evidence is Lite and locally cached, not Verified or remotely
  reproducible.
- **SloP:** docs and runner behavior can be characterized from the pinned
  repository. Real checkpoint execution requires a pinned `scb-problems`
  catalog, hidden tests, Docker toolchain, and agent harness versions.

Upstream Evolving Intent publishes ID lists, not the exact generated
conversations, provider snapshots, or paper result rows. Parallax must not
invent fixtures and present them as paper artifacts.

## Project-local verification skill

Unit 0 created and executed `.cursor/skills/verify-parallax/`. It is the one
app-level entry point, not a Parallax product command. It drives current user
paths through `SKILL.md`, `features/README.md`, and one feature file per mapped
path. Helpers may compose repeatable multi-command proof and evidence capture
around a direct user path; they do not replace that path or add a product
command. Future features may add independently executable helpers and receipts
only after their real user paths exist. A separate skill is justified only by
genuinely different launch or isolation semantics.

The current primary path is the `parallax` CLI declared in `pyproject.toml`.
`src/parallax/cli.py` exposes four commands:

- `uv run parallax compile RECIPE SOURCE --out OUT`;
- `uv run parallax grade RECIPE CANDIDATE --baseline BASELINE [--out OUT]`;
- `uv run parallax export {hud,verifiers} ARTIFACTS MANIFEST... --out OUT`;
- `uv run parallax build [EXPERIMENT] --store STORE [--locked LOCK]`.

The current library path is `parallax.build(...)` followed by
`parallax.run(...)`. `tests/test_synthesis_kernel.py` exercises that path and
the real CLI build and locked-replay path. `tests/test_pipeline.py` exercises
recipe compilation, grading, and HUD/Verifiers export. The secondary HUD path
documented in the root README is:

```shell
cd hud_env
uv sync
hud task list --source tasks.py
```

The skill uses these sections:

- **Launch.** Run `uv sync` once. Parallax is a short-lived CLI, so there is no
  server to invent or keep alive. Each drive gets its own scratch directory.
  HUD setup applies only to a mapped HUD feature.
- **Doctor.** Run `uv run parallax --help` and `uv run python -c 'import
  parallax; print(parallax.__file__)'`, confirm required fixture or source
  paths, and check Docker, provider, benchmark, or HUD prerequisites only for
  the selected feature.
- **Drive.** Use an existing CLI, library call, pytest selector, or documented
  HUD command. The first executed map entry should copy
  `tests/fixtures/synthesis_kernel/` into scratch, run `parallax build` against
  the copied `experiment.toml`, then run `parallax build --locked` against the
  generated copied `family.lock`. This exercises the current user command and
  leaves tracked fixtures untouched. The focused supporting check is `uv run
  pytest -q tests/test_synthesis_kernel.py::test_cli_build_reruns_idempotently_and_replays_lock`.
- **Evidence.** Preserve both command lines, exit codes, stdout/stderr, emitted
  family IDs, and the two artifact trees or their complete file digests in a
  named evidence directory outside scratch. A passing pytest result alone is
  supporting evidence, not a substitute for the CLI drive.
- **Cleanup.** Remove only the scratch directory and processes started by that
  run. Never kill by process name. Re-check that the evidence directory still
  exists after cleanup.

The feature map covers the five current user paths:

1. compile a pinned repository recipe;
2. grade a candidate against a captured baseline;
3. build a GSM8K family and replay its generated lock;
4. export admitted repository tasks to HUD or Verifiers;
5. run a built conversational arm through `parallax.build` and `parallax.run`.

Upstream extraction, predecessor escalation, scheduler parity, SWE symptom
placement, asset tamper checks, and SloP checkpoint behavior enter the map only
after a reproducible Parallax user path exists. A helper may compose an existing
direct invocation with comparison, manifesting, receipt creation, failure
retention, and cleanup when that proof needs several commands. The helper must
show and preserve the direct user commands and belongs to
`.cursor/skills/verify-parallax/` as verification support, not to the
production `parallax` CLI.

Unit 0 is green because Launch, Doctor, Drive, Evidence, and Cleanup ran end to
end for the family-build path and cleanup preserved the captured receipt.

## Deletion-first migration

The migration is hard; no dual path spans releases.

Characterization comes first so deletion does not erase the only observable
baseline. After those receipts exist, delete or quarantine unsupported
production abstractions before adding replacement records:

1. `src/parallax/variants.py`: `TaskSpec`, `TaskVariant`, `AnchorTrajectory`,
   `VariantBlueprint`, and the universal component/relation algebra. Preserve
   useful questions in receipts for later protocol records, not in these
   execution-disconnected types.
2. `src/parallax/autoresearch.py`: synthetic source/condition models as a
   production research API. Archive the path as an experiment and preserve its
   raw campaign evidence before any later port of proven observation fields.
3. `src/parallax/evolving_intent.py`: `ProposalBundle`, `Reveal`, `Revise`,
   `Switch`, and `EvolvingIntent` as a claimed production synthesis path. Keep
   the hand-authored frozen-proposal flow only as an explicitly named
   characterization baseline until its replacement passes the same receipts.
4. `src/parallax/kernel.py`: `CheckpointPlan`, `WorkspaceEpisode`, and
   `CheckpointSequence` placeholders, plus GSM8K-specific family assumptions
   from the shared kernel.
5. `src/parallax/swebench.py`: bespoke `SweBenchEpisode` schedules as a
   production Evolving Intent claim. Preserve their focused identity tests as
   characterization evidence until the source-grounded path passes parity.
6. episode-spine prototype runtime code only after its receipts are archived;
   evidence artifacts and corrections remain immutable history.

Keep and consolidate `ids.py`, `TreeSnapshot`, typed grading outcomes, pinned
source checks, canonical public/sealed commitments, and atomic publication.

The accepted base, grafts, and rejections are preserved in
[`DESIGN-SELECTION.md`](DESIGN-SELECTION.md). Candidate D is the base. The
selection rejects Candidate C's closed domain enum and seam-authored provenance,
and Candidate B's multi-release migration and source-only `Revise`.

## Ordered red-to-green units

### Unit 0 — real characterization and baseline receipts

Create and execute `.cursor/skills/verify-parallax/` against the current CLI,
library, pytest, and relevant HUD paths. Characterize real pinned upstream code
or native verifiers where a reproducible invocation exists. Do not add a
production verification CLI or production strategy code.

**Green:** the skill completes Launch, Doctor, Drive, Evidence, and Cleanup on
one mapped feature; cleanup preserves the evidence; machine-readable receipts
cover every offline-feasible characterization and name every unavailable
asset/live dependency.

**No advance:** any required real fixture is replaced by a hand-authored proxy,
asset/license feasibility is unresolved, or the skill has not driven a current
Parallax user path end to end.

### Unit 1 — subtract and quarantine

Using Unit 0 receipts as the baseline, remove unsupported duplicate production
abstractions and quarantine the hand-authored Evolving Intent, synthetic
autoresearch, bespoke SWE, and episode prototypes as characterization-only
paths where their proven behavior must remain executable. Preserve receipts,
raw results, and focused baseline tests. Add no replacement protocol type in
this unit. Delete or reject `parallax.frozen-proposal.v1` as a production input;
placeholder digest-shaped strings must not be accepted as generation
provenance. If the old fixture remains executable for characterization, its
loader and artifacts must be labeled non-production and provenance-invalid.

**Green:** unsupported symbols and claims are absent from production exports and
docs; all retained Unit 0 characterization drives still pass; immutable
evidence remains readable.

**No advance:** subtraction breaks a proven current path, deletes its only
receipt, or replacement records appear before the old production claim is
removed or quarantined.

### Unit 2 — research protocol records

Add immutable question, hypothesis, intervention, condition, design,
observation, and evidence references. Migrate one existing decision and Qwen
correction.

**Green:** schema round-trip, identity perturbation, and claim-strength tests.

**No advance:** a measured outcome can be serialized as a mechanism claim.

### Unit 3 — attempt and evidence ledger

Add identity-bearing call evidence, six-way rejection taxonomy, telemetry
sidecar, and append-only run receipts.

**Green:** rejected parsed blobs survive; telemetry changes do not change
semantic identity; request/prompt/response changes do.

### Unit 4 — one Evolving Intent domain

Implement GSM8K extraction through deterministic provider fakes first, then one
live smoke. Port typed states and scheduler from characterization evidence.

**Green:** structural parity, deterministic-prefix text parity, oracle/wrong
evaluation, locked replay, and imported-output production refusal.

### Unit 5 — controlled experiment slice

Run static, turn-matched, and evolved GSM8K with blocked assignment,
replication, capability gates, fixed metrics, and uncertainty.

**Green:** rerunning analysis from the frozen reports reproduces results and
refuses undeclared contrasts.

### Unit 6 — external-asset domain

Choose BIRD-SQL only if its database/evidence assets are available. Add explicit
catalog injection and a separately installed wheel contract.

**Green:** DB tamper changes identity or fails admission; native execution
passes oracle and fails known-wrong.

### Unit 7 — evaluator-native stochastic domain

Add BrowseComp+ only with licensed assets and committed live judge calls.

**Green:** corpus/index and judge prompt tamper tests, raw call retention, and
judge sensitivity reporting.

### Unit 8 — persistent workspace domain

Migrate SWE-bench with enforced state policy, per-run workspaces, remote
reproducible image, official harness integration, and valid boundary-model
calibration.

**Green:** precursor write policy is adversarially tested, full harness
classifies results, and repeated controls avoid floors and ceilings.

### Unit 9 — checkpoint evolution

Import a pinned SloP problem and implement its distinct workspace state machine.
Reset conversation/runtime state per checkpoint while preserving only declared
workspace state; include prior tests as regression obligations.

**Green:** real problem checkpoints reproduce workspace, context-reset,
snapshot, and evaluation behavior; quality metrics are diagnostic outputs.

### Unit 10 — training experiment

Only with training access, define train/eval splits, policy updates, reward,
checkpoints, and held-out evaluation.

**Green:** treatment and control differ only by the pre-registered training
intervention and report uncertainty across seeds.

## No-go conditions

Stop before implementation or claims if:

- required benchmark assets, licenses, or redistribution rights are unknown;
- the real path cannot run and only a proxy fixture is available;
- source, environment, policy, verifier, or intervention cannot be pinned;
- controls are floor- or ceiling-saturated;
- treatment and control budgets differ without a declared estimand;
- invalid submissions or harness faults are counted as model failures;
- an LLM judge call is not committed and retained;
- write isolation is instructed but not enforced;
- train/evaluation contamination cannot be ruled out;
- the analysis plan was chosen after observing treatment outcomes;
- exact paper-output reproduction is claimed from artifacts upstream did not
  publish.

## Researcher choices still required

- Is the first product an evaluation harness only, or must it support policy
  training in the first architecture generation?
- Which causal claims are in scope: policy behavior, prompt interventions,
  environment design, or training-algorithm effects?
- What training access and seed budget are available?
- What per-experiment compute and dollar ceilings are acceptable?
- Which stochastic evaluators are acceptable, and what replication/sensitivity
  threshold is required?
- May Parallax retain or redistribute BIRD, BrowseComp+, SWE-bench, and SloP
  assets, or only content digests and acquisition instructions?
- Should SloP import use the released problem catalog unchanged, or should
  Parallax author new problems under the same construction protocol?

## Primary sources

- [LLMs Get Lost in Evolving User Intent](https://arxiv.org/abs/2607.20734)
  and pinned [Microsoft implementation](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
- [SlopCodeBench v2](https://arxiv.org/html/2603.24755v2), runner
  [`v0.2`](https://github.com/SprocketLab/slop-code-bench/tree/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1),
  and the pinned
  [problem-design guide](https://github.com/SprocketLab/slop-code-bench/blob/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b/docs/contributing-problems/README.md)
- [HumanLayer Program Design](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c/wsff.md#program-design)

WSFF is design evidence, not an experimental result: plan product behavior,
system boundaries, and program structure before coding, then ship vertical
slices that prove the real path. That supports this architecture's
characterization-first, data-first, deletion-first sequence.
