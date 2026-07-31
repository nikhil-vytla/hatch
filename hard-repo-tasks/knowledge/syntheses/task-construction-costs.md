+++
id = "synthesis.task-construction-costs"
kind = "synthesis"
title = "Expert assurance dominates task and benchmark cost"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["task-authoring", "benchmarks", "cost", "verification"]

[relations]
broader = []
related = ["concept.task-validity", "concept.reward-integrity", "concept.causal-task-variant"]
supported_by = ["source.the-agent-company", "source.spice", "source.deepswe", "source.anthropic-demystifying-evals"]
challenges = []
+++

# Expert assurance dominates task and benchmark cost

## Question

What is most expensive when building one task from scratch, and what becomes
expensive at benchmark scale?

## Direct evidence

- TheAgentCompany reports roughly 3,000 person-hours for 175 tasks and a shared
  simulated-company environment. Some tasks exceeded ten hours for design,
  implementation, testing, and verification.
- SPICE estimates roughly 2,265 engineer-hours and more than $170,000 for the
  SWE-bench Verified labeling campaign.
- DeepSWE hand-authors an original prompt, reference solution, and behavioral
  verifier for each task, then audits passing and near-passing rollouts.
- Anthropic warns that expert agreement, reference solutions, clean resets, and
  trajectory review are necessary to distinguish capability from eval defects.

## Synthesis for one task

The expensive artifact is the trusted contract among intent, state, and
verifier. Prompt drafting and candidate generation are cheap. Expert work is
needed to:

1. choose meaningful work,
2. construct a reproducible state,
3. define acceptable alternatives,
4. write the reference solution,
5. build a behavioral verifier,
6. seed plausible wrong solutions,
7. audit reward hacks and false negatives,
8. calibrate difficulty and budgets.

When no reusable environment exists, environment and state engineering
dominate. Once that cost is amortized, verifier construction and adversarial
assurance become the marginal bottleneck.

## Synthesis for a benchmark

Benchmark cost adds:

- coverage and sampling design,
- cross-task consistency,
- human baselines,
- repeated model rollouts and statistical power,
- contamination policy,
- submission and leaderboard governance,
- maintenance, versioning, retirement, and refresh.

Automation drastically reduces candidate generation and mechanical triage. It
increases the number of candidates that need trustworthy acceptance decisions.

## Cost dimensions

Do not collapse cost into API dollars:

- Expert hours
- Engineering and infrastructure hours
- Model and sandbox spend
- Human baseline compensation
- Rejected-candidate sunk cost
- Opportunity cost of withholding tasks or fixes
- Recurring maintenance and governance

## Decision for Parallax

Optimize the pipeline for expert rejection throughput, not raw generation
count. Track candidate-to-admitted yield, expert review minutes, verifier
mutation score, rollout calibration cost, and maintenance burden per semantic
family.
