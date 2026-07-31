+++
id = "concept.task-validity"
kind = "concept"
title = "Task validity"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["agent-evals", "task-design", "graders"]

[relations]
broader = ["concept.rl-task"]
related = ["concept.reward-integrity"]
supported_by = ["source.anthropic-demystifying-evals", "source.cursor-strict-harness"]
challenges = []
+++

# Task validity

## Definition

A task is valid when genuine possession of the target capability is necessary
and sufficient for reward under the specified environment and harness.

## Necessary conditions

- A known correct solution passes.
- The instruction determines every graded requirement.
- No-op, leakage, hardcoding, and tampering baselines fail.
- Plausible wrong solutions fail.
- Materially correct alternatives pass.
- Infrastructure failures remain separate from model failures.

## Excludes

Gold passing establishes solvability, not complete validity. Test determinism
establishes repeatability, not alignment with intent. Low model pass rates
establish observed difficulty only after task and harness defects are excluded.

## Operationalization

Use an admission matrix, independent task review, semantic mutants, alternative
solutions, grouped rollouts, and trajectory auditing. Record false-positive and
false-negative examples rather than only aggregate reward.

## Open questions

- How many semantic mutants are enough to estimate verifier discrimination?
- Can independent model review substitute for expert review in narrow domains?
- How should validity confidence propagate from individual tasks to a generated
  task family?
