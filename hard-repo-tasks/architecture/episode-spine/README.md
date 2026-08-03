# Episode spine architecture

## Problem

Parallax currently has three task models that do not execute through one
pipeline: repository `Recipe` and `TaskManifest` objects, symbolic `TaskSpec`
and `TaskVariant` objects, and synthetic `CampaignManifest` and
`ConversationVariant` objects. They assign identity, model interaction, and
verification independently. The result is disconnected generation,
admission, rollout, and reward logic, plus reward paths that trust
agent-controlled Git state and may turn tampering into an excluded harness
error.

The replacement must reuse four existing systems:

- Microsoft Evolving Intent generates function and argument decompositions,
  counterfactual arguments, predecessor functions, and scheduled user turns.
- mini-swe-agent owns the coding loop and submission interruption semantics.
- HUD v6 owns environments, capabilities, rollout records, tasksets,
  deployment, grouped evaluation, and training integration.
- The native benchmark verifier, such as the official SWE-bench harness, owns
  terminal correctness.

## Usage

### Compile and admit a family

```python
source = SweBenchVerified(
    instance_ids=("django__django-11099",),
    revision="pinned-dataset-revision",
)

family = (
    EvolvingIntentPipeline.from_upstream(revision="pinned-ei-revision")
    .derive(
        source,
        arms=(Arm.STATIC, Arm.MATCHED_NO_CHANGE, Arm.EVOLVED),
        state_policy=StatePolicy.STAGED,
    )
)

admitted = Admission(evaluator=official_swebench).admit_family(family)
```

### Run one persistent episode through HUD

```python
taskset = publish_hud(admitted)
agent = ScriptedTurnAgent(MiniSweConfig(model="gpt-5.6-sol-medium"))

job = await taskset.run(
    agent,
    runtime=HUDRuntime(),
    group=8,
    max_concurrent=4,
)
```

One HUD `Run` owns one workspace, one mini-swe-agent conversation, all
scheduled intent turns, and one terminal reward. `hud.Chat` remains available
only for stateless conversational tasks.

### Compile a skill-authored adapter

```python
bundle = compile_adapter(
    spec=AdapterSpec.load("adapters/new-benchmark.json"),
    fixtures="adapters/fixtures/new-benchmark",
)
registry.install(bundle)
```

Skills may author source mappings and backend projections. The compiler freezes
their output as content-addressed code and runs conformance tests. Skills
cannot define task identity, admission predicates, reward programs, or runtime
turn transitions.

## Shape

The canonical record is a content-addressed `TaskSpec`:

```python
@dataclass(frozen=True)
class TaskSpec:
    source: ContentRef
    state: StateRef
    episode: Episode
    reward: RewardSpec
    budget: Budget
    derivation: Derivation
    provenance: Provenance
    claims: frozenset[Claim]
    arm: Arm

    def digest(self) -> Digest:
        raise NotImplementedError


@dataclass(frozen=True)
class Episode:
    turns: tuple[Turn, ...]
    anchor_turn: int
    reveal_mode: RevealMode


@dataclass(frozen=True)
class RewardSpec:
    primary: RewardComponent
    gates: tuple[RewardComponent, ...]
    metrics: tuple[RewardComponent, ...]
    evaluator: ContentRef
```

`TaskSpec.digest()` commits to both public behavior and sealed verifier
commitments. A prompt, turn, initial state, verifier, reward policy, generator,
or source revision change creates a new identity.

Generation is allowed to be stochastic or skill-assisted. Compilation,
admission, rollout interpretation, and reward are deterministic after the
generated artifacts are frozen.

### Runtime flow

```mermaid
flowchart LR
    sourceTask[SourceTask] --> generator[EvolvingIntentPipeline]
    generator --> candidate[TaskCandidate]
    candidate --> admission[Admission]
    admission --> admitted[AdmittedTask]
    admitted --> hudTask[HUDTask]
    hudTask --> hudEnv[HUDEnvironment]
    hudEnv --> scriptedAgent[ScriptedTurnAgent]
    scriptedAgent --> submission[Submission]
    submission --> evaluator[SealedEvaluator]
    evaluator --> verdict[Verdict]
    verdict --> calibration[MatchedArmCalibration]
```

The HUD environment registers both workspace and intent-director capabilities
during initialization. At task start it resolves the admitted episode by
digest, provisions the workspace, initializes director state, and yields an
opening envelope containing only turn zero and an opaque episode token.

`ScriptedTurnAgent` strips the envelope before invoking the model. It opens the
workspace and director capabilities, then runs mini-swe-agent in a dedicated
thread. A HUD-backed mini-swe environment forwards synchronous command calls
to the asynchronous SSH client with `asyncio.run_coroutine_threadsafe`.
`Submitted` or per-turn budget exhaustion asks the director for the next turn;
global cost exhaustion terminates. Repository and conversation state persist
until the final submission.

The task template invokes the sealed evaluator before yielding its
`EvaluationResult`. HUD therefore records the real reward required by grouped
evaluation and training. Post-hoc grading may audit a verdict but cannot be the
primary reward path.

### Reward authority

`RewardLedger.score()` is total and returns a typed `Verdict`:

```python
class Outcome(StrEnum):
    SCORED = "scored"
    INVALID_SUBMISSION = "invalid_submission"
    ABSTAIN = "abstain"


@dataclass(frozen=True)
class Verdict:
    outcome: Outcome
    reward: float
    task_digest: Digest
    reward_spec_digest: Digest
    evaluator_digest: Digest
    transcript_digest: Digest
    gates: tuple[GateResult, ...]
    metrics: tuple[MetricResult, ...]
```

Reward equals the primary outcome after all required gates pass. Metrics never
raise reward. Agent-controlled Git metadata is not evidence. The evaluator
reconstructs a clean source state, applies only the submitted patch, restores
authoritative tests, and runs a pinned verifier. A fault may abstain only if it
occurs before applying the submission and reproduces on the untouched starter.
Everything the submission can induce returns a scored failure or an invalid
submission, never an excluded harness error.

## Ownership

```text
parallax/
  ids.py                   canonical serialization and content references
  spec.py                  TaskSpec, Episode, Turn, state, budget, claims
  reward/                  RewardSpec, RewardLedger, Verdict
  episode/                 TurnDirector and transcript replay
  sources/                 repository and benchmark source adapters
  generators/              Evolving Intent and counterfactual transforms
  admission/               structural, executable, and replay admission
  runtime/hud/             environment, template, agent, mini-swe adapter
  verify/                  native benchmark verifier drivers
  calibration/             matched arms, spread, curriculum decisions
  skilladapter/            hermetic adapter compilation and conformance
```

`spec`, identity, reward, and admission do not import HUD or Verifiers. Backend
publishers must report every field they cannot represent. Runtime modules
cannot import sealed artifact types.

## Synthesis decision

The Opus candidate became the base because it traced the actual HUD,
mini-swe-agent, Evolving Intent, SWE-bench, and Prime Verifiers APIs and gave
the strongest typed reward and abstention model. The final shape adds:

- the Fable candidate's untouched-starter fault reproduction rule,
  sealed-type import boundary, HUD pin canary, and in-place integrity fixes;
- the GPT candidate's hermetic adapter compiler, typed verifier evidence, and
  lossy-export reporting;
- the Grok candidate's explicit coupling between state policy and verifier
  policy, plus a named `StatelessChatRunner`.

Rejected shapes include per-turn HUD tasks, workspace restoration around
`Chat.send`, Prime's per-model-turn user simulator for coding tasks, post-hoc
zero-reward grading, platform-native objects as canonical identity, and
skill-generated reward code.

## Tradeoffs accepted

- We accept a custom HUD `Agent` in exchange for one rollout and persistent
  state across intent changes.
- We accept a synchronous-to-asynchronous bridge in exchange for reusing
  mini-swe-agent instead of copying its coding loop.
- We accept separate public and sealed artifacts in exchange for hidden future
  turns and verifier material.
- We accept one generated HUD environment per SWE-bench instance in the first
  hosted pilot in exchange for using official instance images without nested
  Docker.
- We accept pinned adapters and canary tests in exchange for integrating APIs
  that are still changing.

## Alternatives considered

- HUD `Chat` has a smaller interface but creates a fresh rollout and hosted
  environment per turn. It cannot preserve coding state or assign one episode
  reward.
- One HUD task per turn with a shared volume splits a training episode into
  several rewards and breaks grouped credit assignment.
- mini-swe-agent's own Docker environment nested inside HUD maximizes parity
  but hides work from HUD's workspace, network, and file tracking. It remains
  a temporary spike fallback only.
- Prime Verifiers remains an export target. Its user simulator advances after
  every model turn rather than after submission, so it is not the primary SWE
  interaction runtime.

## Open questions and risks

- Grouped Docker concurrency beyond the two-call bridge contract still needs a
  multi-container stress test.
- HUD deploy identity and `Task.env` must use the same canonical,
  hyphen-normalized name. Hosted tunnel runs also require telemetry so their
  trace is visible to the environment-session principal.
- What is the lowest-overhead way to run the official SWE-bench verifier
  during HUD grading while keeping the reward synchronous and verifier
  material hidden?
- Does Prime Verifiers v1 provide a genuinely separate harness runtime for
  sealed evaluation?

## Implementation status

The first migration unit is implemented. `TaskManifest` identity commits
separate canonical public and sealed digests; `TreeSnapshot` supplies the
authoritative baseline; grading has total typed outcomes; and verifier checks
require content-derived success markers in a scrubbed environment. The complete
local suite passes (47 tests), including 12 adversarial cases that reproduced
the prior reward-authority failures.

All 12 Click tasks were re-admitted against pinned revision
`00e592cea702e0b2caa0dee42489fdb1c22cd845`. The oracles passed
deterministically, and no-op, forbidden-path, and upstream-restore submissions
were rejected. The machine-readable result is in `admission-v2.json`.

The deployable environment passed a Docker episode containing three hidden
turns, one mini-swe-agent conversation, one persistent workspace, and one
terminal reward. The pinned official SWE-bench harness then resolved
`django__django-11099` from its gold patch with all 22 classified tests green;
see `swebench-proof.json`.

The same Django instance now runs as a local HUD episode in static,
matched-no-change, and evolved forms. All arms share one content-addressed
source commitment and one sealed verifier commitment. The grader restores the
official test file, applies the official test patch, and executes the pinned
harness command. Gold passed every arm and no-op failed. In the one-run-per-arm
gateway smoke test, GPT-5.6 Sol passed 3/3 arms while Qwen3 8B made no tracked
changes and received three invalid-submission zeros. This does not separate
model capability. It shows no observed matched-to-evolved difference within an
inconclusive smoke test. See `swebench-calibration-qwen3-8b.jsonl`.

[`parallax-episode-spine`](https://hud.ai/environments/ad29e1f1-a035-4b6c-98e1-9f035b5e6e16)
version 2 is deployed. HUD's remote build validated one task and three
capabilities over the v6 control channel, and the hosted `HUDRuntime` canary
passed without name overrides with reward 1. The earlier 404 came from an
underscore name that deploy normalized but `HUDRuntime` sent verbatim; disabling
telemetry in a follow-up diagnostic also prevented tunnel trace authorization.
`deployment.json` records the corrected proof.

## Next implementation step

Make the SWE-bench image remotely reproducible without relying on the official
harness's private cached `sweb.env` image. Then calibrate multiple harder
instances with repeated runs and models near their decision boundaries. Scale
intent expansion only after matched controls are neither ceiling- nor
floor-saturated and the evolved arm shows a stable paired degradation.
