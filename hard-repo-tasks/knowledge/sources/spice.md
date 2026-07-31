+++
id = "source.spice"
kind = "source"
title = "SPICE"
status = "active"
confidence = "medium"
updated = "2026-07-31"
tags = ["coding-benchmarks", "task-validity", "automation", "cost"]
source_type = "paper"
authors = ["SPICE authors"]
year = 2025
url = "https://arxiv.org/abs/2507.09108"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.the-agent-company", "source.deepswe"]
supported_by = []
challenges = []
+++

# SPICE

## Why it matters

SPICE estimates the human cost of validating SWE-bench tasks and tests an
automated pipeline for issue clarity, test coverage, and effort labels.

## Supported claims

### C1. Manual SWE-bench validation is expensive

The paper estimates approximately 2,265 engineer-hours and more than $170,000
for the SWE-bench Verified labeling campaign that screened 1,699 candidates and
released 500 tasks.

### C2. Mechanical triage can become very cheap

SPICE estimates roughly 25 machine-hours and $5.10 in API cost to label 1,000
existing issue/test pairs with its selected model pipeline.

### C3. Automation does not remove validity disagreement

The reported issue-clarity and test-adequacy agreement between human reviewers
was low to moderate. SPICE automates labels on existing candidates; it does not
author the environment, behavioral goal, verifier, or human baseline.

## Limitations

- Cost estimates reconstruct another project's workflow and depend on assumed
  reviewer roles and rates.
- Automated labeling accuracy does not establish task validity.
- The result should not be read as a 19,000-fold reduction in complete
  benchmark construction cost.

## Parallax implications

Automate candidate rejection, metadata extraction, and obvious verifier checks.
Reserve expert time for intent validity, semantic alternatives, reward hacks,
and whether the task teaches useful behavior.
