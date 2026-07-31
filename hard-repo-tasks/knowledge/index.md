+++
id = "synthesis.knowledge-index"
kind = "synthesis"
title = "Parallax research map"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["index", "research-method"]

[relations]
broader = []
related = ["synthesis.environment-task-quality", "synthesis.public-counterfactual-tasks", "synthesis.provider-task-limitations", "synthesis.task-construction-costs", "synthesis.controlled-task-variation", "concept.rl-environment", "concept.rl-task", "concept.agent-harness", "concept.task-validity", "concept.reward-integrity", "concept.task-specification", "concept.anchored-intent-trajectory", "concept.causal-task-variant"]
supported_by = []
challenges = []
+++

# Parallax research map

## Start here

- [Environment and task quality are coupled](syntheses/environment-task-quality.md)
- [RL environment](concepts/rl-environment.md)
- [RL task](concepts/rl-task.md)
- [Agent harness](concepts/agent-harness.md)
- [Task validity](concepts/task-validity.md)
- [Reward integrity](concepts/reward-integrity.md)
- [Executable task specification](concepts/task-specification.md)
- [Anchored intent trajectory](concepts/anchored-intent-trajectory.md)
- [Causal task variant](concepts/causal-task-variant.md)

## Current syntheses

- [Counterfactual tasks reduce answer leakage but do not prove synthesis](syntheses/public-counterfactual-tasks.md)
- [Current provider task contracts leave semantic gaps](syntheses/provider-task-limitations.md)
- [Expert assurance dominates task and benchmark cost](syntheses/task-construction-costs.md)
- [Controlled task variation should be a causal study](syntheses/controlled-task-variation.md)

## Evidence map

### Formal definitions

- [Sutton and Barto's agent-environment interface](sources/sutton-barto-agent-environment.md)
- [Prime Verifiers v1 decomposition](sources/prime-verifiers-v1.md)

### Practical task and environment quality

- [Anthropic's agent eval guidance](sources/anthropic-demystifying-evals.md)
- [Cursor's strict coding harness](sources/cursor-strict-harness.md)

### Harnesses and generalization

- [Zhang and Khattab on compositional harnesses](sources/zhang-khattab-harnesses.md)

### Task variation and benchmarks

- [Microsoft Evolving Intent](sources/microsoft-evolving-intent.md)
- [DeepSWE](sources/deepswe.md)
- [HUD task-design guidance](sources/hud-task-design.md)

### Theory and construction cost

- [POMDP formalization](sources/kaelbling-pomdp.md)
- [TheAgentCompany](sources/the-agent-company.md)
- [SPICE](sources/spice.md)

## Current Parallax questions

1. Which generated task structures create transfer across repositories rather
   than generator-specific shortcuts?
2. How much do harness and context-management choices change measured task
   difficulty?
3. Which semantic mutants best predict verifier false positives?
4. Can task generators adapt difficulty while preserving a stable target
   capability?
5. Which behavioral signals should remain metrics instead of becoming reward?
6. How should public-repository environments preserve legitimate tool use while
   blocking answer retrieval?

## Known evidence gaps

- Authenticated X discussions were not accessible because this run had no
  browser or computer-use integration.
- Only one Parallax repository family has live model calibration.
- Hosted HUD sandbox rollouts did not provision, so containment findings come
  from local macOS execution rather than production isolation.
- Prime Verifiers packaging loaded successfully, but no paid Prime sandbox
  rollout was run.

## Legacy synthesis

`../RL_ENVIRONMENT_KNOWLEDGE_BASE.md` remains the long-form July 2026 synthesis.
New evidence should enter this typed note system first. Update the long-form
report only after source and concept notes have been validated.
