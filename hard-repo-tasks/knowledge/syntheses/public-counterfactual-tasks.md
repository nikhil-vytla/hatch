+++
id = "synthesis.public-counterfactual-tasks"
kind = "synthesis"
title = "Counterfactual tasks reduce answer leakage but do not prove synthesis"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["counterfactuals", "coding-agents", "contamination", "task-validity"]

[relations]
broader = []
related = ["concept.causal-task-variant", "concept.reward-integrity", "synthesis.controlled-task-variation"]
supported_by = ["source.cursor-strict-harness", "source.deepswe", "source.hud-task-design"]
challenges = []
+++

# Counterfactual tasks reduce answer leakage but do not prove synthesis

## Question

Does creating a new behavior in a public repository, then withholding selected
gold implementation sites, avoid contamination and measure synthesis?

## Direct evidence

- Cursor shows that historical public-repository tasks can be solved through
  web and git-history retrieval unless the runtime blocks those channels.
- DeepSWE authors new tasks and solutions on public repositories, strips future
  history, and uses separate behavioral verifiers.
- HUD warns that widely scraped substrate, answer-shaped context, and
  same-shape tasksets can turn training into recall or shortcut learning.

## Synthesis

Parallax is not merely deleting upstream code and asking for reconstruction.
The target behavior did not exist upstream. That prevents direct recovery of
the exact solution if gold artifacts remain private.

The remaining risk is a gold shadow. Surviving declarations, call sites,
types, imports, comments, tests, and control flow may encode the architecture
and reduce the task to constrained completion. Familiar public code also gives
the model repository-specific priors even when it cannot know the exact patch.

Four concepts must remain separate:

1. Exact answer leakage invalidates the evaluation.
2. Gold-shadow leakage changes synthesis into completion.
3. Substrate familiarity is a real prior and a generalization confound.
4. Language, framework, and algorithm knowledge is legitimate capability.

## Decisive experiments

- Pair mutually incompatible counterfactuals from the same commit.
- Compare gold-first withholding against spec-first independent authoring.
- Run an information-removal ladder from body omission to pristine upstream.
- Cross familiar and private repositories with conventional and
  counterfactual behavior.
- Hold out generators, behavior families, repositories, and authors.
- Search semantic neighbors and stratify results by similarity.

## Decision for Parallax

Keep counterfactual compilation as one intervention family. Report
partial-gold completion separately from pristine-baseline synthesis. Do not use
the word contamination-free; record exactly which answer, retrieval, and
substrate channels were controlled.
