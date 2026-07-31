+++
id = "source.sutton-barto-agent-environment"
kind = "source"
title = "The agent-environment interface"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "environment-design", "reward"]
source_type = "textbook"
authors = ["Richard S. Sutton", "Andrew G. Barto"]
year = 2018
url = "http://www.incompleteideas.net/book/3/node2.html"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.prime-verifiers-v1"]
supported_by = []
challenges = []
+++

# The agent-environment interface

## Why it matters

This is the formal anchor for deciding what belongs inside an RL environment
and where the reward boundary should sit.

## Supported claims

### C1. The environment is everything outside the learner's direct control

The boundary marks the limit of the agent's absolute control, not the limit of
its knowledge. An agent may know how its environment and reward work while
still facing a difficult task.

Scope: the standard sequential RL formulation.

### C2. Reward computation belongs outside the agent

Reward defines the problem and therefore must not be arbitrarily changeable by
the policy.

Scope: conceptual agent-environment boundaries. The source does not prescribe
container permissions for software agents.

### C3. A complete environment specification defines a task

Classical RL terminology does not require the modern engineering split between
a reusable environment and a configured task instance.

## Limitations

- It does not address LLM harnesses, hidden tests, or executable sandboxes.
- The online chapter reflects the textbook's formal framing, not one platform's
  packaging contract.

## Parallax implications

Parallax should keep evaluator code and reward artifacts outside the writable
agent runtime. Its environment/task split is an engineering convention and
should not be presented as the sole formal definition.

## Quotable evidence

> The agent-environment boundary represents the limit of the agent's absolute
> control, not of its knowledge.
