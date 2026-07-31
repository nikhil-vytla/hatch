+++
id = "concept.causal-task-variant"
kind = "concept"
title = "Causal task variant"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["task-variation", "causal-evaluation", "synthetic-data"]

[relations]
broader = ["concept.task-specification"]
related = ["concept.anchored-intent-trajectory", "concept.task-validity", "concept.reward-integrity"]
supported_by = ["source.microsoft-evolving-intent", "source.deepswe", "source.hud-task-design"]
challenges = []
+++

# Causal task variant

## Definition

A causal task variant is a task derived through a declared intervention on one
or more task-spec components, with an explicit relation between source and
variant outcomes and a compatible verifier policy.

## Includes

- Changed component set
- Intent relation: preserve, refine, generalize, shift, invert, or corrupt
- State mode: read-only, transactional, staged, or persistent
- Verifier policy: reuse, transport, augment, compose, replace, or reject
- Source digest, generator version, and semantic-family label
- Admission evidence and clustered analysis identity

## Excludes

Ten paraphrases of one prompt are not ten independent benchmark tasks. They
are ten correlated robustness conditions under one source-task cluster.

## Operationalization

Reuse the source verifier only when semantic state, goals, and constraints are
unchanged. Transport a verifier through a proved state mapping. Augment it for
refined constraints, compose it for goal extension, and reject transformations
without a defensible outcome relation.

## Open questions

- Which task interventions preserve model rankings?
- Which variant families teach transferable behavior rather than generator
  recognition?
- How should clustered variants contribute to RL sampling without overweighting
  one source task?
