# Literature review and evidence boundary

Status: primary-source review through 2026-08-02. This document supports
[`FORMAL-MODEL.md`](FORMAL-MODEL.md); it does not define implemented behavior.

The review uses papers, immutable repository revisions, release metadata, and
project documentation. It separates what a source records from what Parallax
requires. Author-reported benchmark results are evidence in their reported
settings, not independent replication.

## Why freeze before outcomes

The Center for Open Science defines preregistration as recording the research
plan before the study or analysis. Its purpose is to distinguish planned tests
from later exploration and prevent analytical choices from depending on
observed results. Exploration remains valid when it is labeled as exploratory,
and amendments remain visible.
[COS preregistration guidance](https://www.cos.io/initiatives/prereg)

Parallax therefore freezes the question, units, sampling and exclusion rules,
conditions, held constants, assignment, repetitions, metrics, estimands,
missingness, uncertainty method, and stopping rule before treatment outcomes.
This is stronger than pinning benchmark code. Neither paper below presents its
protocol as a preregistered Parallax-style experiment definition.

## What the source projects pin

### Evolving Intent

The paper fixes published source evaluation IDs for 200 GSM8K, 100 BIRD-SQL,
100 BrowseComp+, and 50 SWE-bench Verified records. It fixes the source intent
as the terminal anchor and reports a main comparison between one source turn
and a seven-turn condition with two revisions and two switches.
[paper](https://arxiv.org/abs/2607.20734)

Microsoft commit
[`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
fixes extraction, scheduling, prompt, renderer, and evaluation code. At that
revision, evaluation-mode prefixes cycle deterministically. Training-mode
prefixes use a seeded random generator. The scheduler constructs typed plans
before text rendering and restores the source values at the terminal turn.
[scheduler internals](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/INTERNALS.md)

The revision does not freeze the complete experiment:

- Generated extraction, counterfactual, predecessor, experiment, and log files
  are gitignored and must be regenerated.
- Models, ordering, turn counts, naturalization, workers, and other runner
  parameters remain configurable.
- Package requirements are lower bounds and `mini-swe-agent` has no version.
- BrowseComp+ code, corpus, and indexes are external.
- Provider model names do not identify immutable weights or serving behavior.
- Existing output files cause a run to be skipped; there is no immutable
  preassigned run ledger.

The project publishes source IDs and algorithms, not exact paper conversations,
all generation and judge calls, provider snapshots, or a complete result
bundle. It does not claim byte-identical dataset or result replay.
[construction guide](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/intent_construction/README.md),
[evaluation guide](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/evaluation/README.md),
[requirements](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/requirements.txt)

### SlopCodeBench

Paper v2 defines 36 human-authored problems and 196 ordered checkpoints. It
prints the prompt templates, reports native harness versions and reasoning
levels, gives each checkpoint a two-hour wall-clock limit, starts a fresh
non-root container, and carries only the working directory forward. Regression
tests include prior checkpoint tests. The main model table reports the best
`just-solve` run per model, selected by isolated solve rate with stated
tie-breakers.
[paper v2](https://arxiv.org/html/2603.24755v2)

Zenodo record
[`19257129`](https://zenodo.org/records/19257129) links runner release `v0.2`.
The GitHub tag resolves to exactly
[`bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`](https://github.com/SprocketLab/slop-code-bench/tree/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1).
The similar hash containing `...ae2ecf5...` is wrong. GitHub's
[`v0.2` tag API](https://api.github.com/repos/SprocketLab/slop-code-bench/git/ref/tags/v0.2)
and
[commit endpoint](https://api.github.com/repos/SprocketLab/slop-code-bench/commits/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1)
both return the hash containing `...ae2ec8f5...`.

That release does not freeze a complete run:

- `pyproject.toml` uses lower-bound dependencies.
- The environment uses
  `ghcr.io/astral-sh/uv:python3.12-trixie-slim`, a tag rather than a digest.
- The Zenodo record contains the paper PDF, not all tasks, images, workspaces,
  assignments, traces, and outputs.
- The paper selects one best run per model and does not report replicated-seed
  uncertainty for every configuration.
- The metadata does not identify a separate paper-era problem-catalog commit
  or immutable image digest.

Current commit
[`8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b`](https://github.com/SprocketLab/slop-code-bench/commit/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b)
later pinned `scb-check==0.1.3` after a fixed input produced 2.42 times the
verbosity under that version compared with several other releases. This shows
why metric dependencies need identities. It does not retroactively establish
which `scb-check` version produced every paper result. SlopCodeBench does not
claim byte-identical replay.

## Reproducibility boundary

The Reproducible Builds project calls a build reproducible when the same
source, build environment, and instructions recreate bit-for-bit identical
specified artifacts.
[definition](https://reproducible-builds.org/docs/definition/)

Parallax locked replay is analogous to that contract and to content-addressed
artifact storage. It canonicalizes frozen inputs, compiles without network or
model calls, and checks exact bytes, digests, task IDs, and family ID. It is not
agent execution replay. It does not make proprietary model responses,
timestamps, logs, evaluator behavior, or undeclared assets deterministic.
Neither Evolving Intent nor SlopCodeBench claims this property.

## What the studies can establish

### Evolving Intent

The paper uses source-task baselines, isolated transition types and counts,
composition and order analyses, turn-matched repeated-turn controls, prompt and
oracle recap, BIRD hint contrasts, and native final evaluators. These support
descriptive fixed-policy contrasts on the verified generated sample. The
turn-matched control addresses added turns alone.

They do not isolate belief-state failure from context interference, renderer
effects, tool use, or harness behavior. GPT-5.1 generates construction
components, LLM judges filter some components, only the terminal source is
natively verified, and the retained sample conditions on surviving generation
and validation. The reported Qwen3-4B GRPO before-and-after result is a useful
training demonstration, not an identified training effect.

### SlopCodeBench

The ordered workspace recurrence establishes that an agent inherits its own
earlier code under the benchmark protocol. Native hidden tests establish
checkpoint correctness, while erosion and verbosity measure declared code
properties. Prompt comparisons show that `anti-slop` and `plan-first` reduce
some initial diagnostic values in the reported runs. Paper v2 also reports
higher average cost and lower strict correctness for those prompts.

The paper does not identify the causal effect of iteration alone. Checkpoint
index, cumulative requirements, inherited decisions, and compute all change
together. The 473-repository comparison is observational. Erosion and
verbosity are proxies, not measured maintenance effort. Best-run selection and
limited replication also rule out population-level model rankings with strong
uncertainty claims.

### HumanLayer

At commit
[`a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c`](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/tree/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c),
`wsff.md` recommends product requirements, system architecture, program design,
review, and vertical slices to narrow implementation search. It also says the
maintainability thesis lacked a good benchmark. This is practitioner design
evidence, not causal evidence.
[Program Design](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c/wsff.md#program-design)

The Opus 5 report runs three Claude models on three selected SCBench problems,
17 checkpoints total, with the same prompts, Claude Code, and fresh context per
checkpoint. It reports four strict passes for Opus 5 and one each for the other
models. The author explicitly says the subset cannot establish a cost effect
and that the link from code metrics to ease of later change is unestablished.
This is observational and hypothesis-generating. It does not test the complete
reviewed HumanLayer workflow against a randomized control.
[benchmark report](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c/benchmarking-opus-5-on-slop-code-bench.md)

## Intervention evidence

The following papers support interventions in their own reported settings.
They do not establish transfer to Parallax.

- [U-Fold](https://arxiv.org/abs/2601.18285), published 2026-01-26, recomputes
  intent-aware dialogue summaries and filtered tool logs. The paper reports
  Avg@4 gains across three user-centric benchmarks under a unified setup.
  This supports testing a memory-state intervention.
- [InfoPO](https://arxiv.org/abs/2603.00656), published 2026-02-28, combines
  masked-feedback information gain with outcome reward for multi-turn RL. The
  paper reports gains and ablations across UserGym, ColBench, and
  \(\tau^2\)-Bench. It supports a training experiment, not an inference-only
  claim.
- [VeRPO](https://arxiv.org/abs/2601.03525), published 2026-01-07, uses
  difficulty-calibrated partial-test reward plus terminal correctness. Its
  evidence concerns code-generation RL, not repository evolution.
- [SWE-Adept](https://arxiv.org/abs/2603.01327), published 2026-03-01, combines
  structured hypotheses, adaptive plans, test feedback, and Git checkpoints.
  Reported gains support testing that full agent-system intervention. They do
  not isolate checkpointing by itself.
- [SCAFFOLD-CEGIS](https://arxiv.org/abs/2603.08520), published 2026-03-09,
  reports that static-analysis gating alone can worsen latent security
  degradation in its setup, while explicit semantic constraints, tests, and
  rollback reduce it. This supports hard invariant gates for declared security
  properties, not a general maintainability claim.
- [SWE-MeM](https://arxiv.org/abs/2606.28434), published 2026-06-26, combines
  synthesized memory trajectories, curriculum fine-tuning, and memory-aware
  GRPO. It reports SWE-bench Verified gains under a 32K context budget.
  Proprietary-model judgments in data construction and author-run evaluation
  remain replication limits.
- SlopCodeBench directly tests prompt-only `anti-slop` and `plan-first`
  interventions. They improve some quality diagnostics but do not reliably
  stop degradation, improve strict correctness, or reduce cost. Prompt-only
  planning is not established as a sufficient intervention.

Explicit intent state, adaptive memory, dense verifiable feedback, structured
planning, and hard invariant gates have evidence worth testing separately.
Their composition, causal pathways, and transfer to Evolving Intent or
checkpoint evolution remain Parallax hypotheses.

## Implications for Parallax

1. Keep stochastic construction outside deterministic compilation and preserve
   accepted and rejected attempts.
2. Make the experiment and analysis plan identity-bearing, not only the tasks.
3. Define the policy as weights, harness, prompts, memory, tools, and decoding.
4. Label a prompt, memory, tool, environment, reward, or update change at its
   actual intervention layer.
5. Use pinned upstream code as an executable characterization oracle. Parallax
   still owns a first-principles production implementation, identity model,
   admission rules, runtime, and evidence.
6. Keep one app-level `verify-parallax` skill. Add independent feature helpers
   and receipts only when real user paths exist. Create another skill only for
   a secondary interface with genuinely different launch or isolation
   semantics. Do not add proposed features to the current feature map.

## Excluded or still unverified

- The incorrect SCBench `v0.2` hash containing `...ae2ecf5...` is excluded.
- No source supports a claim that either paper offers byte-identical replay.
- The exact Evolving Intent paper conversations, provider snapshots, all judge
  calls, and full result rows are unavailable.
- The SCBench Zenodo record does not identify a complete paper-era problem,
  image, dependency, assignment, and output lock.
- External benchmark asset rights and exact paper-era BIRD, BrowseComp+,
  SWE-bench, and hidden SloP assets remain unresolved.
- Recent intervention results are preprints and author-reported. Independent
  replication and combined-intervention effects remain open.
