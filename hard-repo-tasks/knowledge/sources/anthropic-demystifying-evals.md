+++
id = "source.anthropic-demystifying-evals"
kind = "source"
title = "Demystifying evals for AI agents"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["agent-evals", "task-validity", "graders", "difficulty"]
source_type = "company-research"
authors = ["Anthropic"]
year = 2026
url = "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.cursor-strict-harness"]
supported_by = []
challenges = []
+++

# Demystifying evals for AI agents

## Why it matters

The article gives operational checks for whether agent tasks and graders
measure what their authors intended.

## Supported claims

### C1. Independent experts should agree on pass or fail

Anthropic proposes that two domain experts should independently reach the same
verdict. Ambiguous task specifications otherwise become metric noise.

### C2. Every graded requirement should follow from the description

An agent should not fail because a hidden test assumes an unstated path or
output convention.

### C3. Reference solutions are necessary validity checks

A known working solution demonstrates conditional solvability and catches
grader configuration errors.

### C4. Persistent zero success is often a harness warning

The article says 0% pass@100 with frontier models most often warrants checking
the task and grader before concluding that the capability is absent.

## Limitations

- Expert agreement does not prove that all valid implementations pass.
- A reference solution proves existence, not complete specification.
- The guidance concerns evaluation practice, not a universal RL theorem.

## Parallax implications

Admission should require a gold pass, independent task review, and explicit
failure classification. All-zero rollout groups should trigger
`repair_harness` before `harden`.
