+++
id = "concept.rl-environment"
kind = "concept"
title = "RL environment"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "environment-design"]

[relations]
broader = []
related = ["concept.rl-task", "concept.agent-harness", "concept.reward-integrity"]
supported_by = ["source.sutton-barto-agent-environment", "source.prime-verifiers-v1"]
challenges = []
+++

# RL environment

## Definition

An RL environment determines what an agent can observe and do, how actions
change state, and when an episode ends. In agent engineering, it also includes
the operational boundary that realizes those dynamics.

## Includes

- Latent state and initial-state distribution
- Action and observation interfaces
- Transition, failure, and randomness models
- Reset, termination, truncation, and cleanup
- Runtime resources, permissions, and isolation
- Instrumentation needed to reconstruct a rollout

## Excludes

The reusable engineering definition excludes one task's particular goal and
scoring policy. Classical RL often includes reward and calls a complete
environment specification a task, so authors must state which convention they
use.

## Operationalization

An environment specification should name its image, dependencies, tools,
observation rendering, resource limits, network policy, filesystem policy,
random seeds, lifecycle, and harness revision.

## Open questions

- Which environment factors explain most cross-harness score variance?
- How much nondeterminism can online RL tolerate before reward variance
  dominates policy variance?
- Which deployment affordances should remain available when they create
  contamination risk but are legitimate in real work?
