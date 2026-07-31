+++
id = "synthesis.provider-task-limitations"
kind = "synthesis"
title = "Current provider task contracts leave semantic gaps"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["hud", "prime-intellect", "harbor", "task-specification"]

[relations]
broader = []
related = ["concept.task-specification", "concept.agent-harness", "concept.task-validity"]
supported_by = ["source.sutton-barto-agent-environment", "source.kaelbling-pomdp", "source.hud-task-design", "source.prime-verifiers-v1", "source.deepswe"]
challenges = []
+++

# Current provider task contracts leave semantic gaps

## Question

What do HUD, Prime Verifiers, and Harbor make easy or difficult across
\(T=(I,s_0,G,C,V,B,M)\)?

## Origin of the tuple

The tuple is a Parallax synthesis. Sutton and Barto motivate external state,
actions, transitions, reward, and task boundaries. POMDP theory separates
latent state from observations. HUD contributes prompt, capabilities, and
terminal reward. Prime Verifiers separates taskset, harness, and runtime.
Harbor and DeepSWE contribute executable state, artifact capture, separate
verification, and time/resource configuration.

No reviewed provider exposes the complete tuple as one portable, mandatory
contract.

## Limitations by component

### \(I\): instruction and observation schedule

- Natural language does not define one formal acceptable-outcome set.
- Prompt roles, rendering, truncation, and tool descriptions change across
  harnesses.
- HUD's core task has one initial prompt and one terminal reward. Evolving
  intent requires custom conversation logic.
- Prime supports user simulation, but simulator state, stopping, and
  compatibility remain task and harness concerns.
- Harbor supports fixed instructions and multi-step packaging, not a portable
  adaptive-user policy.

Research gap: version user simulators as policies with hidden state,
observation contracts, randomness, and explicit stopping.

### \(s_0\): initial state

- Containers implement an initial state; they do not specify an abstract state
  distribution.
- Images, package indexes, clocks, caches, external APIs, and service data can
  drift.
- HUD runtime providers differ in resource and isolation support.
- Prime composes several runtimes, but shared services and remote tools can
  reintroduce mutable state.
- Harbor has strong container and multi-service packaging, but backend support
  for Compose, networks, and artifacts varies.

Research gap: content-address the complete observable state and issue reset
certificates from replayed action sequences.

### \(G\): acceptable outcomes

- Most systems encode \(G\) indirectly in verifier code.
- Open-ended semantic equivalence can be undecidable or subjective.
- Final-state checks miss deleted evidence and irreversible external effects.
- Group rewards in Prime no longer have access to a torn-down runtime.
- Separate regrading in Harbor works only for evidence captured before teardown.

Research gap: version behavioral predicates, metamorphic relations, and known
alternative solutions independently from one test script.

### \(C\): constraints and policies

- Constraints are split across prompt prose, sandbox policy, tool permissions,
  and grader checks.
- The same final state may come from a compliant or forbidden trajectory.
- "No network" and "isolated" do not have one cross-provider enforcement
  meaning.
- Kernel, provider, MCP, and remote-tool boundaries differ.

Research gap: produce machine-readable policy manifests and signed evidence for
network, mounts, processes, credentials, and tool use.

### \(V\): verifier and reward

- Writing a sound, alternative-tolerant verifier remains expert work.
- Scalar reward aliases wrong answer, timeout, grader crash, policy violation,
  and uncertainty unless the trace preserves components.
- LLM judges drift and may truncate trajectories.
- HUD normalizes terminal reward to zero through one while retaining subscores.
- Prime sums weighted rewards and stores metrics separately.
- Harbor supports executable and judge-based scoring, but failure defaults and
  context limits affect results.

Research gap: return reward vectors, confidence, grader identity, failure
cause, and scalarization policy.

### \(B\): budget and stop rules

- Turns, model calls, tool actions, subagents, tokens, wall time, and money are
  different resources.
- Provider queueing, startup, retries, and grading may sit inside or outside
  the reported budget.
- Hidden time limits create partial observability.
- Runtime backends do not enforce every resource field identically.

Research gap: standardize budget ledgers and preserve termination separately
from infrastructure truncation.

### \(M\): provenance, generation, and splits

- Metadata fields are optional and do not prove lineage.
- No reviewed provider requires source hashes, generator prompts and models,
  parent task IDs, semantic-family IDs, deduplication evidence, or contamination
  audits.
- Random instance splits do not protect against generator, repository, or
  pretraining leakage.
- Public release starts a new contamination clock.

Research gap: require a content-addressed provenance DAG and report splits
across time, repositories, generators, semantics, and authors.

## Provider-level judgment

- Prime Verifiers has the clearest taskset, harness, and runtime decomposition.
- Harbor has the clearest executable package and separate-verifier pattern.
- HUD has the leanest prompt-to-reward authoring loop and the strongest
  explicit task-quality doctrine in the reviewed documentation.

None makes acceptable outcomes, reset distributions, policy enforcement,
budget accounting, or provenance independently portable.

## Decision for Parallax

Parallax variants must carry the complete task tuple, harness and runtime
versions, a typed delta, verifier policy, and provenance edge. Export adapters
may lose fields, but the sealed Parallax record must not.
