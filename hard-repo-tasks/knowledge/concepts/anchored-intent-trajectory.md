+++
id = "concept.anchored-intent-trajectory"
kind = "concept"
title = "Anchored intent trajectory"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["evolving-intent", "multi-turn", "verifiability"]

[relations]
broader = ["concept.task-specification"]
related = ["concept.causal-task-variant", "concept.task-validity"]
supported_by = ["source.microsoft-evolving-intent"]
challenges = []
+++

# Anchored intent trajectory

## Definition

An anchored intent trajectory is an ordered sequence of reveal, revision,
switch, and repeat events whose terminal latent intent exactly reconstructs a
source task. The source verifier then grades the final outcome.

## Includes

- A typed anchor goal and argument slots
- An initial partial or counterfactual intent state
- Ordered deltas with explicit before and after values
- A replay check that reconstructs the anchor
- A declared state-side-effect policy

## Excludes

Returning to the anchor does not erase actions already taken. It guarantees
terminal intent equivalence, not workspace equivalence, intermediate
correctness, or policy compliance.

## Operationalization

Use read-only precursor turns or a staged read-only-to-transactional runtime
when reusing the source verifier. Persistent predecessor edits require an
episode verifier that observes their effects.

## Open questions

- Which intent transitions remain adversarial after matching token and tool
  budgets?
- Does training on one transition taxonomy transfer to unseen compositions?
- How should a user simulator signal completion without revealing evaluator
  structure?
