# RL environment and task knowledge base

Last reviewed: 2026-07-31

This document records the definitions, evidence, and design rules used by
Parallax. It distinguishes claims supported by sources from working judgments
that still need experiments.

## Core distinction

The most useful engineering distinction is:

> An environment defines what can happen. A task defines what should happen.

A rollout is one policy attempt on one task inside an environment. A reward is
the training credit computed from that rollout. Metrics retain diagnostic
information that should not necessarily affect training.

The distinction is not universal in RL theory. Sutton and Barto describe the
environment as everything outside the agent and state that a complete
environment specification defines a task. Modern agent platforms split the
concept because one executable world can host many goals and scoring rules.

Prime Intellect Verifiers v1 decomposes an environment into a taskset, harness,
and runtime. The taskset owns task data and scoring. The harness runs the model
and tools. The runtime determines where execution occurs. HUD uses the simpler
description that an environment is where the agent acts and a task is the work
measured there.

## Formal model

A partially observed environment can be represented as:

\[
E = (\mathcal{S}, \mathcal{A}, P, \Omega, O, \rho_0, T)
\]

- \(\mathcal{S}\): latent states
- \(\mathcal{A}\): actions
- \(P\): transition dynamics
- \(\Omega\): observations
- \(O\): observation process
- \(\rho_0\): initial-state distribution
- \(T\): termination and truncation rules

Classical definitions usually include the reward function in the environment.
For reusable agent systems, it is often cleaner to attach reward to the task:

\[
\tau = (I, s_0, G, C, V, B, M)
\]

- \(I\): agent-visible instruction
- \(s_0\): initial world configuration
- \(G\): acceptable outcome set
- \(C\): constraints and policies
- \(V\): verifier and reward computation
- \(B\): interaction and resource budget
- \(M\): provenance, split, and generator metadata

This is an engineering convention, not a claim that reward is mathematically
separate from the environment.

## What an agent environment encompasses

### World state

- Repository, filesystem, processes, services, and databases
- Package, compiler, operating-system, and browser versions
- Accounts, credentials, permissions, clocks, and network state
- Other agents or simulated users

### Action interface

- Shell, editor, browser, API, and communication tools
- Tool schemas, parsers, and invalid-action behavior
- Side effects, reversibility, and action latency

### Observation interface

- Prompts, command output, logs, screenshots, and accessibility trees
- Output truncation and serialization
- Hidden state and information-retrieval affordances
- Context retention, compaction, and history management

### Dynamics and lifecycle

- How actions change state
- Failure and nondeterminism models
- Setup, reset, termination, timeout, and cleanup behavior
- Random seeds and state isolation between rollouts

### Operational boundary

- Container or VM image
- CPU, memory, token, tool-call, and wall-clock limits
- Filesystem and network permissions
- Separation of writable task state from grader and gold artifacts

### Instrumentation

- Complete trajectories and state changes
- Environment, harness, model, and dependency versions
- Resource use and failure categories
- Reward components and non-reward metrics

The harness is part of the effective decision problem even when a platform
packages it separately. Tool routing, observation rendering, retries, and
context management change what the policy can learn and accomplish.

## What an agent task encompasses

A complete task instance contains:

- An instruction or user request
- A pinned initial state
- The set of acceptable outcomes
- Explicit constraints and permissions
- Expected artifacts or state changes
- A verifier and reward policy
- Episode budget and stop conditions
- Provenance, generation method, and split membership

There are three useful levels:

1. A task family names a recurring capability, such as cross-module repair.
2. A task generator samples concrete worlds, goals, and checks.
3. A task instance fixes one initial state, instruction, and verifier.

Large instance counts do not imply broad task diversity. Ten thousand constant
changes produced by one mutation template may represent one narrow family.

## Criteria for a good environment

### Construct fidelity

The environment must preserve the capability being studied. If historical
repository tasks expose future commits or unrestricted web search, success may
measure answer retrieval rather than software repair. If a tool performs most
of the target skill, success may measure tool selection rather than reasoning.

### Reward-channel integrity

Reward computation must remain outside the agent's arbitrary control. Hidden
tests alone are insufficient. The grader, gold state, future history, and
evaluator credentials must be unreachable and immutable from the task runtime.

### Reproducibility

The same initial state, seed, and actions should produce the same relevant
outcome unless randomness is intentional and recorded. Setup failures,
provider failures, task termination, and infrastructure timeouts must remain
separate result categories.

### Deliberate partial observability

Hidden state should create legitimate information-gathering work, not arbitrary
guessing. A competent agent must be able to discover every fact required for a
passing outcome through the provided observations and tools.

### Scalable experience production

Training environments need cheap reset, concurrent execution, controlled
variation, and enough semantic diversity to avoid memorizing templates.
Build success and instance count are operational metrics, not evidence of
learning value.

### Calibrated difficulty distribution

Useful training batches contain both successes and informative failures.
All-zero batches provide poor policy-gradient signal and may indicate broken
tasks. All-one batches have no headroom. Difficulty must be measured for a
named model, harness, budget, and environment revision.

### Auditability

Researchers need actions, observations, state changes, grader components, and
resource use. Outcome reward cannot reveal whether an agent derived a solution,
retrieved it, modified the grader, or stumbled into a passing state.

## Criteria for a good task

### Validity

Genuine completion must be both necessary and sufficient for reward:

- No-op, retrieval, hardcoding, tampering, and cheap shortcut baselines fail.
- Correct solutions pass even when their implementation differs from gold.

A reference solution proves that one solution exists. It does not prove that
the prompt is well specified or that the verifier accepts all valid solutions.

### Determinacy

Two competent reviewers should independently agree on whether the result
satisfies the request. Every hidden requirement must follow from agent-visible
information. Real ambiguity can be tested, but the task should then reward
appropriate clarification rather than one secret interpretation.

### Verifier soundness and completeness

The verifier should reject plausible semantic mistakes and accept legitimate
alternatives. Admission should include:

- Gold pass and starter failure
- No-op and upstream-restore failure
- Forbidden-path and grader-tampering failure
- Plausible semantic-mutant failure
- Metamorphic variants
- Alternative-correct-solution acceptance

Programmatic verification is deterministic relative to code. It is not
automatically aligned with user intent.

### Empirical discrimination

Hardness is not a property of the prompt alone. A good capability task
separates relevant model populations under a fixed harness and budget, while
leaving nonzero success and room for improvement. Persistent zero success
should trigger a task and harness audit before being labeled frontier-hard.

### Transfer value

Tasks should exercise behaviors worth retaining:

- Grounding decisions in repository evidence
- Localizing relevant state before editing
- Testing hypotheses and recovering from failure
- Preserving unrelated behavior
- Verifying completion honestly

These should normally be required by the outcome. Direct bonuses for actions
such as running tests can select performative behavior without better results.

### Contamination resistance

Public-repository tasks should not rely on freshness alone. Better defenses
include counterfactual behavior absent upstream, stripped future history,
controlled network access, hidden generated variants, and evaluation across
unseen repositories and generators.

### Distributional coverage

Measure variation across repositories, languages, tools, state depth,
interaction horizon, failure modes, outputs, rewards, and decomposition
strategies. Renaming symbols or rewriting prompts is not semantic diversity.

### Diagnostic reward records

Preserve contract correctness, regressions, adversarial probes, integrity,
cost, and behavioral annotations separately. The optimizer may consume one
scalar, but analysis should not. Integrity violations should normally gate
reward rather than be offset by unrelated points.

## Training and evaluation have different needs

A good training task is learnable, inexpensive to sample, and informative when
the policy fails. A good evaluation task is independent, stable, difficult to
leak, and representative of the capability claim.

Randomly holding out instances from one generator can measure interpolation.
Stronger transfer tests hold out generators, repositories, tool schemas,
semantic families, context lengths, and time periods.

## Admission checklist

Before accepting an environment or task family:

1. Gold solutions pass repeatedly.
2. Starter, no-op, retrieval, and known shortcut baselines fail.
3. Plausible semantic mutants fail.
4. Alternative correct solutions pass.
5. Grader and hidden artifacts are unreachable.
6. Repeated resets produce clean equivalent states.
7. Infrastructure failures are classified separately.
8. Model rollouts show useful reward variance.
9. Independent humans agree on expected outcomes.
10. Held-out generators or domains show transfer.
11. Trajectory review finds no systematic unintended solution path.
12. Cost and throughput support the intended training run.

## Findings that changed the Parallax design

- Counterfactuality prevents restoring a memorized upstream solution, but it
  does not guarantee semantic depth.
- The first Click family was novel but saturated for both audited model tiers.
- A narrow allowed-path rule punished agents for adding useful tests. Reward
  policy can select worse engineering behavior even when tests are correct.
- Local execution without a hard filesystem boundary allowed an agent to
  modify a source clone outside its task workspace.
- Difficulty claims require grouped live rollouts and trace review.
- Environment validity and task validity cannot be assessed independently.

## Working hypotheses

These are design hypotheses, not established facts:

1. Cross-layer state propagation plus temporal behavior will discriminate
   frontier agents better than local dispatch omissions.
2. Secret semantic-mutant pools will improve verifier discrimination more than
   adding more tests generated from the same implementation.
3. Holding out generators and repositories will reveal substantially less
   transfer than random instance splits.
4. Rich component feedback will improve debugging and curriculum decisions,
   but using it as dense reward may create new shortcuts.
5. Harnesses that turn long tasks into locally familiar interactions will
   generalize better than continually growing monolithic contexts.

Each hypothesis requires an explicit experiment, named model and harness
versions, repeated rollouts, and a predeclared decision rule.

## Primary sources

### Definitions and platforms

- Sutton and Barto,
  [The agent-environment interface](http://www.incompleteideas.net/book/3/node2.html)
- Gymnasium,
  [environment API](https://gymnasium.farama.org/api/env/)
- Prime Intellect,
  [Verifiers v1](https://www.primeintellect.ai/blog/verifiers-v1)
- HUD,
  [tasks](https://docs.hud.ai/v6/reference/tasks) and
  [environments](https://docs.hud.ai/v6/reference/environment)

### Environment and task quality

- Anthropic,
  [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Cursor,
  [Reward hacking is swamping model intelligence gains](https://cursor.com/blog/reward-hacking-coding-benchmarks)
- DeepMind,
  [Specification gaming](https://deepmind.google/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)
- Endless Terminals,
  [procedural terminal environments](https://arxiv.org/html/2601.16443)
- Zhang and Khattab,
  [Language model harnesses are compositional generalizers](https://alexzhang13.github.io/blog/2026/harness/)

### Rewards, feedback, and oversight

- OpenAI,
  [Detecting misbehavior in frontier reasoning models](https://openai.com/index/chain-of-thought-monitoring/)
- OpenAI,
  [Metagaming matters](https://alignment.openai.com/metagaming)
- Anthropic,
  [Natural emergent misalignment from reward hacking](https://www.anthropic.com/research/emergent-misalignment-reward-hacking)
- Helff et al.,
  [LLMs Gaming Verifiers](https://arxiv.org/abs/2604.15149)
- Agrawal et al.,
  [GEPA](https://arxiv.org/abs/2507.19457)

## Source coverage and confidence

The formal definitions and platform decompositions have high confidence because
they come from textbooks and current primary documentation. The environment and
task criteria are a synthesis of primary research, company guidance, and the
Parallax experiments. Numeric findings remain specific to their reported
models, harnesses, and datasets.

Direct authenticated X research was not available in this agent run. X search
returned HTTP 403, public search indexes exposed no dependable status URLs, and
the available tool catalog contained no browser or computer-use integration.
Relevant claims from Nathan Lambert, Alex Zhang, and Omar Khattab were checked
through accessible primary blogs, papers, and clearly labeled cross-posts.
No claim is attributed to an inaccessible X post.
