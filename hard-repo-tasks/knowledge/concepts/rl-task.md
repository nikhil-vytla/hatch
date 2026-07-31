+++
id = "concept.rl-task"
kind = "concept"
title = "RL task"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "task-design"]

[relations]
broader = []
related = ["concept.rl-environment", "concept.task-validity", "concept.reward-integrity"]
supported_by = ["source.sutton-barto-agent-environment", "source.anthropic-demystifying-evals", "source.prime-verifiers-v1"]
challenges = []
+++

# RL task

## Definition

In the Parallax engineering convention, a task is one configured decision
problem inside an environment. It specifies the initial state, instruction,
acceptable outcomes, constraints, budget, and verifier.

## Includes

- Agent-visible instruction
- Pinned initial state
- Intended and acceptable outcome set
- Permissions and constraints
- Episode budget and stop rules
- Verifier, reward policy, and diagnostic metrics
- Provenance, generator revision, and split membership

## Excludes

A prompt by itself is not a complete task. A hidden grader expectation is part
of the effective task even if the author forgot to state it. A task family or
generator is not one task instance.

## Operationalization

Publish enough metadata to reproduce the initial state and explain every
graded requirement. Keep hidden evaluator artifacts sealed while retaining
their hashes and version identifiers.

## Open questions

- Which task metadata can remain hidden without making a task underdetermined?
- How should clarification behavior be rewarded when real requests are
  intentionally ambiguous?
- What split strategy best measures transfer across repositories and semantic
  generators?
