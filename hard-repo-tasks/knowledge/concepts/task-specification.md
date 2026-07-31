+++
id = "concept.task-specification"
kind = "concept"
title = "Executable agent task specification"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["task-design", "agent-evals", "rl-environments"]

[relations]
broader = ["concept.rl-task"]
related = ["concept.rl-environment", "concept.agent-harness", "concept.task-validity", "concept.causal-task-variant"]
supported_by = ["source.sutton-barto-agent-environment", "source.kaelbling-pomdp", "source.hud-task-design", "source.prime-verifiers-v1"]
challenges = []
+++

# Executable agent task specification

## Definition

Parallax models one task as:

\[
T=(I,s_0,G,C,V,B,M)
\]

- \(I\): agent-visible instruction and observation schedule
- \(s_0\): initial state or state distribution
- \(G\): acceptable outcome set
- \(C\): constraints and policies
- \(V\): verifier and reward mapping
- \(B\): interaction, compute, and stopping budget
- \(M\): provenance, generator, split, and version metadata

This tuple is a synthesis for executable agents, not a standard copied from one
paper. MDP and POMDP theory motivate state, observations, transitions, reward,
and horizon. HUD, Prime Verifiers, and Harbor motivate the operational
instruction, runtime, verifier, budget, and metadata fields.

## Includes

Every hidden requirement that affects reward belongs in the effective task
specification, even if the author omitted it from \(I\). Harness and runtime
remain separately versioned because they change observations, actions, and
execution without necessarily changing the authored task row.

## Excludes

The tuple does not claim that components are independent. Changing \(s_0\) can
invalidate \(V\); changing \(C\) can narrow \(G\); changing \(B\) can make a
previously solvable task impossible.

## Operationalization

Hash each component, record visibility, and declare every variant delta.
Compare tasks only after checking verifier compatibility and runtime support.

## Open questions

- Can acceptable outcomes be represented portably beyond executable verifier
  code?
- Which policy constraints require trajectory evidence instead of final state?
- How should stochastic user simulators enter \(s_0\), dynamics, and metadata?
