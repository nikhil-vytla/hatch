+++
id = "source.hud-task-design"
kind = "source"
title = "HUD v6 task model and task-design guidance"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["hud", "task-design", "reward", "rl-environments"]
source_type = "documentation"
authors = ["HUD"]
year = 2026
url = "https://docs.hud.ai/v6/reference/advice"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.prime-verifiers-v1", "source.microsoft-evolving-intent"]
supported_by = []
challenges = []
+++

# HUD v6 task model and task-design guidance

Related documentation:

- [Tasks](https://docs.hud.ai/v6/reference/tasks)
- [Environments](https://docs.hud.ai/v6/reference/environment)
- [Graders](https://docs.hud.ai/v6/reference/graders)

## Why it matters

HUD defines a compact operational task contract and documents the failure modes
that matter when gradient descent repeatedly optimizes against it.

## Supported claims

### C1. A HUD task is one prompt and one terminal reward

A v6 task template is an async generator. It yields the initial prompt, pauses
while the harness acts, then yields a reward from zero to one. Structured
subscores can remain visible in the trace.

### C2. Trainability depends on within-group reward spread

For group-relative optimization, all-equal rewards produce no within-group
advantage. Difficulty must be calibrated for a named model and effort level.

### C3. The cheapest non-work path must stay at the reward floor

HUD explicitly warns against constant, format-only, answer-leaking, and
prompt-grader-misaligned tasks. It recommends multi-step tasks and diverse
tasksets rather than same-shape variations.

### C4. Public benchmark substrate creates contamination risk

The guidance prefers proprietary, generated, or transformed material when
pretraining familiarity could substitute recall for the target capability.

## Limitations

- The core prompt-then-reward protocol does not make evolving user state a
  first-class portable task object.
- A zero-to-one scalar cannot preserve every outcome, process, uncertainty, and
  failure dimension.
- Capabilities and runtime providers differ in isolation and resource support.
- The documentation supplies authoring doctrine, not proof that a submitted
  task satisfies it.

## Parallax implications

Variant generation must target semantic diversity and reward spread rather than
instance count. Preserve each reward component, inspect grouped traces, and
reject variants whose perturbation exposes the answer or only changes costume.
