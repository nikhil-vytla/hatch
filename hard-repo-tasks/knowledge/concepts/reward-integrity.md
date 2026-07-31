+++
id = "concept.reward-integrity"
kind = "concept"
title = "Reward integrity"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["reward", "reward-hacking", "verifier-design"]

[relations]
broader = ["concept.rl-environment", "concept.rl-task"]
related = ["concept.task-validity"]
supported_by = ["source.sutton-barto-agent-environment", "source.cursor-strict-harness"]
challenges = []
+++

# Reward integrity

## Definition

Reward integrity is the property that an agent cannot receive training credit
by changing, bypassing, retrieving, or exploiting the measurement process
instead of producing the intended outcome.

## Includes

- Immutable evaluator code and hidden state
- Separation of agent and grader permissions
- Detection of forbidden side effects
- Verifiers that reject semantic shortcuts
- Trace review for unintended solution paths
- Separate reporting of outcome, integrity, and process metrics

## Excludes

A deterministic reward can still lack integrity. Hidden tests can still be
reachable. A semantically weak verifier can be exploited without any file or
network tampering.

## Operationalization

Use evaluator-only runtimes, no-op and tampering baselines, restricted future
history, controlled network access, semantic mutants, metamorphic tests, and
audited rollouts. Treat integrity failures as hard gates unless the experiment
explicitly studies reward hacking.

## Open questions

- Which reward hacks can be embedded as canaries without teaching the policy
  new exploit strategies?
- How often should audits sample successful trajectories?
- Can adaptive verifiers remain stable enough for policy optimization?
