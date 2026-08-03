# Primary-source pins

This page promotes the primary-source pin table from the archived
[literature review](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/LITERATURE-REVIEW.md).
It records the exact papers, repository revisions, and release records that
[`ADR-001.md`](ADR-001.md) and [`DESIGN-SELECTION.md`](DESIGN-SELECTION.md)
were checked against, and what each source does and does not fix.
Author-reported benchmark results are evidence in their reported settings, not
independent replication.

## Pin table

| Source | Pinned identity | What it fixes | What it does not fix |
| --- | --- | --- | --- |
| Evolving Intent paper | [arXiv 2607.20734](https://arxiv.org/abs/2607.20734) | Published source evaluation IDs for 200 GSM8K, 100 BIRD-SQL, 100 BrowseComp+, and 50 SWE-bench Verified records; source intent as the terminal anchor; a main comparison between one source turn and a seven-turn condition with two revisions and two switches | Exact paper conversations, all generation and judge calls, provider snapshots, or a complete result bundle |
| Evolving Intent code | Microsoft commit [`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a) | Extraction, scheduling, prompt, renderer, and evaluation code; deterministic evaluation-mode prefix cycling; seeded training-mode prefixes; typed plans before text rendering with source values restored at the terminal turn ([scheduler internals](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/situated_simulation/INTERNALS.md)) | Generated extraction, counterfactual, predecessor, experiment, and log files (gitignored); models, ordering, turn counts, naturalization, workers, and other runner parameters; exact dependency versions ([requirements](https://github.com/microsoft/evolving-intent/blob/993d6be9597ac03854b46362ccd647eb1bfd267a/requirements.txt) are lower bounds and `mini-swe-agent` has no version); BrowseComp+ code, corpus, and indexes (external); immutable provider weights or serving behavior; an immutable preassigned run ledger |
| SlopCodeBench paper | [paper v2](https://arxiv.org/html/2603.24755v2) | 36 human-authored problems and 196 ordered checkpoints; printed prompt templates; native harness versions and reasoning levels; a two-hour wall-clock limit per checkpoint; fresh non-root containers carrying only the working directory forward; regression tests including prior checkpoint tests | Replicated-seed uncertainty for every configuration; the main model table reports the best `just-solve` run per model, selected by isolated solve rate with stated tie-breakers |
| SlopCodeBench release | Zenodo record [`19257129`](https://zenodo.org/records/19257129), runner release `v0.2` at commit [`bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`](https://github.com/SprocketLab/slop-code-bench/tree/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1) | The runner code at the tagged revision. The similar hash containing `...ae2ecf5...` is wrong; GitHub's [`v0.2` tag API](https://api.github.com/repos/SprocketLab/slop-code-bench/git/ref/tags/v0.2) and [commit endpoint](https://api.github.com/repos/SprocketLab/slop-code-bench/commits/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1) both return the hash containing `...ae2ec8f5...` | Lower-bound dependencies in `pyproject.toml`; the environment image `ghcr.io/astral-sh/uv:python3.12-trixie-slim` is a tag, not a digest; the Zenodo record contains the paper PDF, not all tasks, images, workspaces, assignments, traces, and outputs; no separate paper-era problem-catalog commit or immutable image digest |
| SlopCodeBench metric pin | Commit [`8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b`](https://github.com/SprocketLab/slop-code-bench/commit/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b) | Pins `scb-check==0.1.3` after a fixed input produced 2.42 times the verbosity under that version compared with several other releases — metric dependencies need identities | Which `scb-check` version produced every paper result; SlopCodeBench does not claim byte-identical replay |
| HumanLayer | Commit [`a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c`](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/tree/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c) | [`wsff.md` Program Design guidance](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c/wsff.md#program-design) and the [Opus 5 benchmark report](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/a2da7968c7d5cbc8a58e9c559f4d9eea6d460d6c/benchmarking-opus-5-on-slop-code-bench.md) (three Claude models, three selected SCBench problems, 17 checkpoints) | Practitioner design evidence and an observational, hypothesis-generating report; the author states the subset cannot establish a cost effect and the link from code metrics to ease of later change is unestablished |
| Preregistration standard | [COS preregistration guidance](https://www.cos.io/initiatives/prereg) | The definition Parallax follows: record the research plan before the study or analysis, distinguish planned tests from later exploration, keep amendments visible | Neither source paper presents its protocol as a preregistered Parallax-style experiment definition |
| Reproducibility standard | [Reproducible Builds definition](https://reproducible-builds.org/docs/definition/) | The contract Parallax locked replay is analogous to: same source, build environment, and instructions recreate bit-for-bit identical specified artifacts | Agent execution replay; proprietary model responses, timestamps, logs, evaluator behavior, or undeclared assets; neither Evolving Intent nor SlopCodeBench claims this property |

## Intervention evidence pins

The following papers support interventions in their own reported settings.
They do not establish transfer to Parallax.

| Paper | Pinned identity | Reported evidence and limits |
| --- | --- | --- |
| U-Fold | [arXiv 2601.18285](https://arxiv.org/abs/2601.18285), published 2026-01-26 | Recomputes intent-aware dialogue summaries and filtered tool logs; reports Avg@4 gains across three user-centric benchmarks under a unified setup. Supports testing a memory-state intervention |
| InfoPO | [arXiv 2603.00656](https://arxiv.org/abs/2603.00656), published 2026-02-28 | Combines masked-feedback information gain with outcome reward for multi-turn RL; reports gains and ablations across UserGym, ColBench, and \(\tau^2\)-Bench. Supports a training experiment, not an inference-only claim |
| VeRPO | [arXiv 2601.03525](https://arxiv.org/abs/2601.03525), published 2026-01-07 | Difficulty-calibrated partial-test reward plus terminal correctness; evidence concerns code-generation RL, not repository evolution |
| SWE-Adept | [arXiv 2603.01327](https://arxiv.org/abs/2603.01327), published 2026-03-01 | Structured hypotheses, adaptive plans, test feedback, and Git checkpoints; reported gains support testing that full agent-system intervention, not checkpointing in isolation |
| SCAFFOLD-CEGIS | [arXiv 2603.08520](https://arxiv.org/abs/2603.08520), published 2026-03-09 | Static-analysis gating alone can worsen latent security degradation in its setup, while explicit semantic constraints, tests, and rollback reduce it. Supports hard invariant gates for declared security properties, not a general maintainability claim |
| SWE-MeM | [arXiv 2606.28434](https://arxiv.org/abs/2606.28434), published 2026-06-26 | Synthesized memory trajectories, curriculum fine-tuning, and memory-aware GRPO; reports SWE-bench Verified gains under a 32K context budget. Proprietary-model judgments in data construction and author-run evaluation remain replication limits |

SlopCodeBench itself directly tests prompt-only `anti-slop` and `plan-first`
interventions: they improve some quality diagnostics but do not reliably stop
degradation, improve strict correctness, or reduce cost. Prompt-only planning
is not established as a sufficient intervention.

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
