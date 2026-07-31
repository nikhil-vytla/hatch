+++
id = "source.kaelbling-pomdp"
kind = "source"
title = "Planning and acting in partially observable stochastic domains"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["rl", "pomdp", "partial-observability"]
source_type = "paper"
authors = ["Leslie Pack Kaelbling", "Michael L. Littman", "Anthony R. Cassandra"]
year = 1998
url = "https://people.csail.mit.edu/lpk/papers/aij98-pomdp.pdf"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.sutton-barto-agent-environment"]
supported_by = []
challenges = []
+++

# Planning and acting in partially observable stochastic domains

## Why it matters

This paper anchors the observation component that is often missing from
provider task schemas. Agent tasks rarely expose complete repository, service,
user, or evaluator state in each model observation.

## Supported claims

### C1. Partial observability requires an observation model

A POMDP separates latent state from the observations available to a policy.
The policy must condition on interaction history or a belief over hidden state.

### C2. Identical goals do not imply identical decision problems

Changing what the agent observes can change the policy problem even if state
dynamics and terminal reward remain fixed.

## Limitations

- The formalism does not specify natural-language instructions, containers,
  tool schemas, provenance, or software verifiers.
- Modern agent runtimes often expose observations through harness-specific
  rendering rather than an explicit observation kernel.

## Parallax implications

Task variants that alter context reveal order, tool output, or hidden state
perturb the observation process. They must be labeled separately from goal or
state transformations.
