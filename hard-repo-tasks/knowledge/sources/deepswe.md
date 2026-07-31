+++
id = "source.deepswe"
kind = "source"
title = "DeepSWE"
status = "active"
confidence = "high"
updated = "2026-07-31"
tags = ["coding-agents", "benchmarks", "task-validity", "contamination"]
source_type = "paper-and-code"
authors = ["Datacurve"]
year = 2026
url = "https://arxiv.org/abs/2607.07946"
accessed = "2026-07-31"
primary = true

[relations]
broader = []
related = ["source.microsoft-evolving-intent", "source.cursor-strict-harness"]
supported_by = []
challenges = []
+++

# DeepSWE

Code: [datacurve-ai/deep-swe](https://github.com/datacurve-ai/deep-swe) at
`e016041a6ccf8da29906afc9a3f5a8df940a1f78`.

## Why it matters

DeepSWE provides original coding tasks on public repositories with behavioral
verifiers and reference solutions that were not mined from public fixes. It is
a strong source substrate for studying controlled task variants.

## Supported claims

### C1. Original tasks reduce exact-solution contamination

The benchmark has 113 original tasks across 91 repositories and five
languages. Tasks and reference solutions were authored for the benchmark and
were not contributed upstream.

### C2. Behavioral verifiers reduce implementation coupling

Each task contains a prompt, reference solution, hidden fail-to-pass tests, and
pass-to-pass regression tests. Grading occurs in a separate pristine verifier
container and checks observable behavior rather than patch similarity.

### C3. Ten variants of one task are not ten independent tasks

This is an inference from the package structure. The instruction, base commit,
test patch, fail-to-pass list, pass-to-pass list, test runner, and image form
one validated tuple. Paraphrases that reuse the tuple are correlated robustness
conditions. Goal or state changes require regenerated tests and validation.

## Package details

Each task includes:

- `task.toml`
- `instruction.md`
- `environment/Dockerfile`
- `tests/test.patch`, `config.json`, `test.sh`, and `grader.py`
- `solution/solution.patch`

All tasks use no-network execution and a separate verifier environment in the
reviewed revision.

## Limitations

- There is no released train, validation, and test split.
- The public release starts a new contamination clock.
- Public repository architecture may still be familiar from pretraining.
- Prebuilt images and some generation artifacts live outside git.
- The paper does not report total authoring labor.
- Reusing a verifier after substantive intent changes is invalid unless a
  proved relation transports or augments it.

## Parallax implications

Treat variants as a cluster under one source task. Reuse the original verifier
only for intent-preserving instruction or budget interventions. Transforming
state, constraints, or goals requires an explicit verifier policy and fresh
admission evidence.
