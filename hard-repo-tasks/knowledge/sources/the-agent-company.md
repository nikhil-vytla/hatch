+++
id = "source.the-agent-company"
kind = "source"
title = "TheAgentCompany"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["agent-benchmarks", "task-authoring", "cost"]
source_type = "paper"
authors = ["TheAgentCompany authors"]
year = 2024
url = "https://arxiv.org/abs/2412.14161"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.spice"]
supported_by = []
challenges = []
+++

# TheAgentCompany

## Why it matters

The paper reports one of the clearest end-to-end labor measurements for
interactive agent task and benchmark construction.

## Supported claims

### C1. Interactive benchmark construction consumed substantial expert labor

The authors report roughly 3,000 person-hours from 20 contributors over more
than two months to build 175 tasks and the surrounding simulated-company
environment.

### C2. Complex tasks can exceed ten authoring hours

Some tasks took more than ten hours each to design, implement, test, and
verify. The process included evaluator proof, code review, and independent
final checks.

## Limitations

- The total blends shared environment engineering, task authoring, and review.
- It does not isolate verifier cost or marginal cost after the platform exists.
- Contributors and tasks are not interchangeable units, so dividing total
  hours by task count is only a blended average.

## Parallax implications

Measure expert review and rejected candidates, not only model API spend.
Environment setup cost should be amortized separately from marginal variant
generation.
