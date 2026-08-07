# Research notes — index

Working research notes for strive's design. One numbered file per source/topic.
All six planned sources were examined 2026-08-06; repos pinned at exact SHAs.

| # | Source | Provenance | Status |
|---|---|---|---|
| 00 | This index | — | living |
| [01](01-let-the-model-write-the-code.md) | "Introducing Flex: Let the Model Write the Code" (cmpnd.ai blog) + DSPy Flex/GEPA docs, GEPA paper (arXiv:2507.19457) | blog fetched 2026-08-06 | done |
| [02](02-prime-agent.md) | primeintellect-ai/prime-agent (RLM runtime + Continual Harness state, /refine) | commit `0e0d23391bcd879f1aea70dbda4d07dda7970b34` | done |
| [03](03-arxiv-2605-09998.md) | arXiv:2605.09998 "Continual Harness: Online Adaptation for Self-Improving Foundation Agents" (Karten, Zhang et al.) — deep dive incl. appendices | v1, 2026-05-11 | done |
| [04](04-exo-harness.md) | exoharness/exo (Rust substrate + TS executor, self-rebuilding agent) | commit `8f7886661e41957a1d4909c1538cc720c9bbd740` | done |
| [05](05-rlm-recursive-language-models.md) | alexzhang13/rlm + RLM blog (Oct 2025) + paper arXiv:2512.24601 | commit `72d6940142ddfb84ee6be573dc999a37e633e671` (v0.1.3) | done |
| [06](06-nemo-labs-oo-agents.md) | NVIDIA-NeMo/labs-OO-Agents (NOOA) + paper arXiv:2607.20709 | commit `bfb347bca53c1eaa0449d7acfebdefb29075fc23` | done |
| [07](07-arxiv-2301-12987.md) | arXiv:2301.12987 "The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest" (Bennett, AGI-23) — theory of hypothesis selection; weakness vs MDL | v4, 2024-04-11; appendices repo `35a2a03` | done |
| — | [comparative-matrix.md](comparative-matrix.md) — cross-source synthesis + retain/replace/harden/generalize verdicts | synthesized from 01–06 | done |

Downstream documents built on these notes: [../ARCHITECTURE.md](../ARCHITECTURE.md),
[../ROADMAP.md](../ROADMAP.md), decisions + priorities in [../HANDOFF.md](../HANDOFF.md).

Conventions:

- Notes are evidence-first: cite file paths/sections; record what was verified versus
  assumed; separate source-supported facts, interpretations, hypotheses to test in
  strive, and prototype-vs-mature mechanisms.
- For repositories, always record the exact commit SHA examined; inspect source,
  tests, schemas, runtime boundaries, persistence, evaluation, and failure handling —
  not only READMEs.
- Each note ends with concrete implications for strive, or explicitly "none".
