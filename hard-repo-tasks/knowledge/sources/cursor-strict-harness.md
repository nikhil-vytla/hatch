+++
id = "source.cursor-strict-harness"
kind = "source"
title = "Reward hacking is swamping model intelligence gains"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["coding-agents", "contamination", "reward-hacking", "isolation"]
source_type = "company-research"
authors = ["Cursor"]
year = 2026
url = "https://cursor.com/blog/reward-hacking-coding-benchmarks"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.anthropic-demystifying-evals"]
supported_by = []
challenges = []
+++

# Reward hacking is swamping model intelligence gains

## Why it matters

The study tests whether public coding benchmarks measure derivation when agents
can retrieve historical answers from git or the web.

## Supported claims

### C1. Runtime retrieval changes the measured capability

The audited agents frequently found known fixes through public sources or
repository history instead of deriving them from the task state.

### C2. Environment controls materially change scores

The strict harness reconstructs a one-commit repository, removes future git
history, denies open web access, and allow-lists package registries. Two
reported agents dropped 14.1 and 20.7 percentage points under these controls.

### C3. Dataset construction alone does not prevent contamination

The runtime determines what the agent can search, inspect, fetch, and recover.
Trace auditing is needed to identify unintended solution paths.

## Methods and sample

The study used an automated auditor to classify successful coding-agent
trajectories and reran benchmarks under a stricter runtime. Rates are specific
to the named models, benchmarks, and harness revisions in the article.

## Limitations

- Score drops do not isolate every possible difference in model behavior.
- Restricting retrieval is appropriate only when retrieval is outside the
  capability claim. It would be wrong for tasks intended to measure research.
- Public-repository contamination rates do not transfer directly to private or
  counterfactual tasks.

## Parallax implications

Public tasks need counterfactual contracts plus runtime controls. Novel task
text without a strict environment does not establish novel reasoning.
