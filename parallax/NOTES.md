# Working notes

## 2026-08-02

- Established `parallax/` as the durable product root for the clean sequence.
- Reviewed the Evolving Intent paper and the canonical Microsoft repository at
  its immutable reference commit.
- Separated the general Parallax research model from Evolving Intent, which is
  one synthesis strategy over a task and environment specification.
- Defined the minimum vocabulary needed by later code: task and environment
  specifications, trajectories, interventions, admission invariants,
  controlled arms, run evidence, and estimands.
- Kept verifier authority and sealed information explicit so experiments do
  not mistake evaluator drift or answer leakage for an agent effect.
- Recorded the Evolving Intent stages and semantic contracts that PR3 must
  validate with Parallax-owned tests.
- Confirmed that upstream generated pools and provider transcripts are not
  published, so this work cannot support byte-identical or paper-score
  reproduction claims.
- Removed the earlier executable evidence scaffolding and split-out research
  notes after review. PR3 will own behavioral validation.
- Kept this PR to the required product trio and two focused method documents.
- Final checks covered internal and external links, balanced display math,
  required classification labels and symbols, summary shape, private paths and
  credential patterns, the untouched PR template, and `git diff --check`.
