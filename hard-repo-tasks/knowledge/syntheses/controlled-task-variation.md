+++
id = "synthesis.controlled-task-variation"
kind = "synthesis"
title = "Controlled task variation should be a causal study"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["task-variation", "evolving-intent", "synthetic-data", "verifiability"]

[relations]
broader = []
related = ["concept.causal-task-variant", "concept.anchored-intent-trajectory", "synthesis.public-counterfactual-tasks", "synthesis.provider-task-limitations"]
supported_by = ["source.microsoft-evolving-intent", "source.deepswe", "source.hud-task-design"]
challenges = []
+++

# Controlled task variation should be a causal study

## Question

Can one source task produce ten useful variants while preserving verifiability
and revealing which task changes are adversarial?

## Direct evidence

- Evolving Intent backward-constructs reveal, revision, and switch trajectories
  that return to the original terminal intent and reuse the source verifier.
- DeepSWE packages instruction, state, tests, verifier configuration, and image
  as one validated tuple. Changing one semantic component can invalidate the
  rest.
- HUD warns that same-shape tasksets, public substrate, answer leakage, and
  all-equal rewards provide poor or misleading training signal.

## Synthesis

Generate ten intervention families, not ten nominally independent tasks:

| Family | Main delta | Terminal relation | Verifier policy |
| --- | --- | --- | --- |
| Paraphrase | \(I\) | Preserve | Reuse |
| Delayed reveal | \(I,B\) | Preserve | Reuse |
| Argument revision | \(I,B\) | Preserve anchor | Reuse |
| Function switch | \(I,B\) | Preserve anchor | Reuse |
| Combined evolution | \(I,B\) | Preserve anchor | Reuse |
| Budget shift | \(B\) | Preserve | Reuse |
| Constraint refinement | \(I,C\) | Refine | Augment |
| Equivalent state | \(s_0\) | Preserve | Transport |
| Goal extension | \(I,G\) | Refine | Compose |
| Persistent episode | \(I,s_0,M\) | Shift | Replace |

The first six are correlated controls on one source task. The remaining four
can become new semantic tasks only after new verifier and admission evidence.

## State semantics

- Read-only precursors measure intent tracking without workspace mutation.
- Transactional work occurs in a disposable snapshot.
- Staged work permits read-only precursors and enables writes only for the
  terminal anchor.
- Persistent work retains obsolete effects and requires episode-level grading.

Returning to an anchor intent is insufficient when actions are
non-commutative or irreversible.

## Pipeline

```text
source task
  -> typed task tuple
  -> candidate transition generator
  -> anchor and consistency replay
  -> state-side-effect policy
  -> verifier reuse/transport/augment/compose decision
  -> clean candidate environment
  -> gold, no-op, mutant, leakage, and reset admission
  -> grouped weak/strong model calibration
  -> clustered task-family analysis
```

Every record contains source and variant hashes, changed components, intent
relation, state mode, verifier policy, generator and prompt versions, semantic
family, admission runs, and final reward components.

## Research questions

1. Which intent transition classes remain adversarial after matching total
   tokens, tools, and time?
2. Do source-task model rankings survive each intervention?
3. Does training on one transition composition transfer to unseen ones?
4. How much counterfactual performance disappears when gold scaffolding is
   removed?
5. Which transformed verifiers predict behavior under independently authored
   tests?
6. Does persistent-state training help maintenance episodes while harming clean
   task reliability?

## Failure conditions

Reject a candidate when:

- final anchor replay fails,
- predecessor actions can mutate authoritative state without an episode
  verifier,
- generated text reveals gold or hidden-test information,
- a changed goal reuses the old verifier,
- a state mapping is not invertible or behavior-preserving,
- no-op or seeded semantic mutants pass,
- variants differ only lexically outside the designated paraphrase control.

## Decision for Parallax

Implement the tuple, transition, verifier-policy, and admission types before
adding an LLM generator. The generator proposes candidates; deterministic rules
decide whether their declared relation is even eligible for validation.
Analyze every accepted suite as a source-task cluster.
