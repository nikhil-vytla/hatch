+++
id = "concept.agent-harness"
kind = "concept"
title = "Agent harness"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["agents", "harnesses", "generalization"]

[relations]
broader = []
related = ["concept.rl-environment", "concept.rl-task"]
supported_by = ["source.prime-verifiers-v1", "source.zhang-khattab-harnesses"]
challenges = []
+++

# Agent harness

## Definition

An agent harness is the program that converts environment observations into
model calls and model outputs into actions. It owns the rollout policy around
the model, not the model weights or task goal.

## Includes

- System prompts and agent loop
- Context retention, compaction, and offloading
- Tool selection and result routing
- Parsing, retries, and invalid-action handling
- Subagents and recursive calls

## Excludes

The harness is not neutral plumbing. It changes the policy's effective
observations and actions. It also does not provide runtime isolation merely
because it invokes tools through an abstraction.

## Operationalization

Every result should name and version the model, harness, taskset, and runtime.
Cross-model comparisons should hold the harness fixed unless the evaluated
unit is explicitly the complete agent system.

## Open questions

- Which decomposition structures transfer across genuinely different task
  families?
- When does context offloading improve learning rather than hide relevant
  state?
- Should RL optimize model weights, harness policy, or both?
