# Working notes

## 2026-08-02

- Established `parallax/` as the durable product root.
- Reviewed the Evolving Intent paper and the canonical Microsoft repository at
  its immutable reference commit.
- Separated the general Parallax research model from Evolving Intent, which is
  one synthesis strategy over a task and environment specification.
- Defined the minimum vocabulary needed by implementations: task and environment
  specifications, trajectories, interventions, admission invariants,
  controlled arms, run evidence, and estimands.
- Kept verifier authority and sealed information explicit so experiments do
  not mistake evaluator drift or answer leakage for an agent effect.
- Recorded the Evolving Intent stages and semantic contracts that require
  Parallax-owned behavioral regression coverage.
- Confirmed that upstream generated pools and provider transcripts are not
  published, so this work cannot support byte-identical or paper-score
  reproduction claims.
- Removed the earlier executable evidence scaffolding and split-out research
  notes after review. Behavioral validation remains unimplemented.
- Kept the versioned documentation to the required product trio and two
  focused method documents.
- Final checks covered internal and external links, balanced display math,
  required classification labels and symbols, summary shape, private paths and
  credential patterns, and Markdown formatting.

> [!NOTE]
> Current capability is documentation-only: the model and Evolving Intent
> contract exist, while synthesis, native verification, regression tests, and
> experiment execution do not.
