+++
id = "source.prime-verifiers-v1"
kind = "source"
title = "Verifiers v1 taskset and harness decomposition"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "environment-design", "platforms", "harnesses"]
source_type = "documentation"
authors = ["Prime Intellect"]
year = 2026
url = "https://www.primeintellect.ai/blog/verifiers-v1"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.sutton-barto-agent-environment"]
supported_by = []
challenges = []
+++

# Verifiers v1 taskset and harness decomposition

## Why it matters

Verifiers v1 gives a current operational decomposition for agentic RL. It
separates what work is measured from how a model acts and where execution runs.

## Supported claims

### C1. A taskset owns data and scoring

The taskset produces typed tasks and owns rewards, metrics, task tools, and user
simulation.

### C2. A harness owns rollout execution

The harness is the program that drives the model, such as a ReAct loop or
command agent.

### C3. A runtime owns execution placement

The same harness can run locally or in a sandbox. The environment composes the
taskset and harness for evaluation or training.

## Limitations

- This is a platform API contract, not a mathematical definition.
- Other systems, including HUD, draw package boundaries differently.

## Parallax implications

Public task data and scoring should remain harness-agnostic. Sandbox placement
must be explicit because a taskset alone does not provide containment.
