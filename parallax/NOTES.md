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
> Current capability includes the formal model, Evolving Intent method contract,
> and a content-addressed GSM8K native-verifier core. Synthesis and experiment
> execution remain unimplemented.

## Domain and verifier core

- Added canonical UTF-8 JSON with explicit version, namespace, and SHA-256
  separators. Ambiguous and platform-dependent values fail validation.
- Added immutable source, asset, verifier, public task, sealed task, grade,
  publication, tree snapshot, and replay-lock records.
- Bound loaded evaluator, parser, and shared answer-validator code objects,
  policies, answer authority, assets, exact CPython runtime identity,
  dependencies, and schemas into sealed identity.
- Implemented only GSM8K native final-answer parsing and exact grading.
- Added admission checks before evaluator execution and closed verdicts for
  pass, task failure, invalid submission, harness failure, and verifier failure.
- Removed evaluator injection from grading. The public grading API accepts
  task, submission, and asset data only.
- Adopted a trusted controller/evaluator process threat model. Loaded-code and
  runtime commitments are reproducibility evidence, not protection from
  monkeypatching or code-object mutation inside that process.
- Added manifest-verified atomic publication and single-capture replay with
  lexical component-by-component no-follow root traversal, portable path
  checks, explicit post-rename durability states, and consistent receipt,
  snapshot, and replay policies.
- Used labeled synthetic test values; no benchmark rows or hidden answers are
  versioned.
- Focused tests cover evaluator injection, data-only APIs, answer boundaries,
  root and file swaps, symlinked parents, staging cleanup, publication races,
  parent fsync failure, portable paths, and replay-policy mismatch.
