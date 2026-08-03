# Evolving Intent design selection

## Provenance

The architecture arena produced four candidate files. Their exact bytes are
preserved in the experimental archive:

- [Candidate A](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/arena/candidate-A.md):
  `eaad4ba0aa9918480ccce55c2b8f9b2a5efcb39bf30e13823e126e3dcac3e09b`
- [Candidate B](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/arena/candidate-B.md):
  `b129a8f9f0d3d808a7f161619a3686fc302706d11594dfcfd25f5da563460847`
- [Candidate C](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/arena/candidate-C.md):
  `dac5065bdecf2b32679d00598f4e5b8eb84a66d5579ce02d3d32659e61140ddc`
- [Candidate D](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/arena/candidate-D.md):
  `ee3deff3a39647b90a70eafa05a904b6099f4ff026e1d3c59e10c23fd929148e`

The archived
[cross-judge result](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/architecture/evolving-intent-pipeline/arena/judge.md),
SHA-256
`f77e17d3f66b48232be9907c85d91870ec4d9a208606da518b8fc1fa102cb1cc`,
preserves the final scorecard, winner, grafts, rejections, and unresolved asset
question. The original read-only cross-judge record was
`d85280db-5e58-4f8f-92a4-bd91546966ab.jsonl`, SHA-256
`a55e88b8592c2abbe7bf5e327ccd0a031b8abe760d283f20e0e6b95ccf93ddb4`.
These provenance hashes remain unchanged. The judge checked disputed claims
against Microsoft Evolving Intent commit
[`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a).

## Candidate summaries

- **A** specified the upstream stages and restoration rules in detail, with a
  clear imported-upstream characterization path. Its domain contract exposed
  extraction substeps, and its evidence values remained hand-constructible.
- **B** had the strongest failure taxonomy, crash-safe journal, external-asset
  commitments, and wheel-installed custom-domain test. Its `Revise` type could
  not express upstream counterfactual-to-counterfactual corrections, and its
  three-release migration retained a forbidden dual path.
- **C** used upstream type names but required kernel edits for a closed domain
  enum. Domain seams returned traces by value, which reopened fabricated
  provenance, and its proposed characterization shapes were not surviving
  upstream output.
- **D** placed one hard type boundary at `SpecPack`: provider-backed
  construction and an append-only evidence ledger above it, then typed,
  provider-free scheduling, rendering, sealing, replay, and native evaluation
  below it. Its `CallRef` minting and ledger resolution made fabricated
  generation provenance a construction error.

## Decision

Candidate D is the base. The cross-judge scored D 29/30, ahead of A at 25, B
at 23, and C at 15. D was strongest on upstream fidelity, domain seams,
provenance enforcement, hard-cut migration, and API depth. The judge directly
verified D's claims about predecessor escalation, the
`[v2, ..., vN, source]` correction chain, SWE symptom strip/re-injection,
the SWE recap refusal, argument-ID offsets, and the upstream class-name
collision.

Structural scheduler parity is the primary upstream gate. Exact rendered-text
parity is required only with deterministic injected prefix functions; production
must not copy upstream's mutable batch-order prefix counters. Domains use an
explicit constructor or import seam, not a closed enum or discovery scan.

## Accepted grafts

1. From B, keep the six-way attempt result taxonomy (`transport`, `provider`,
   `parse`, `schema`, `semantic`, `judge`), retain parsed rejected blobs, and
   keep request IDs, timestamps, and billing in a non-identity sidecar.
2. From B, require a wheel-installed custom-domain contract test and tamper
   checks for databases, indexes, Docker images, evaluator code, and judge
   prompts.
3. From A, allow source-digested upstream JSON for characterization only.
   Imported records must be marked and refused at production sealing. Also use
   deterministic prefix injection for exact renderer checks.

## Rejections

Rejected choices include C's closed enum and seam-authored traces, B's
multi-release dual path and source-only `Revise`, A's stage-shaped domain
methods and mutable-prefix parity, any runtime naturalizer below the freeze
line, and migration of `parallax.frozen-proposal.v1`. The hand-authored
placeholder format must be deleted or rejected in the first implementation
unit rather than converted into valid provider provenance.

## Open ambiguity

The arena did not resolve the acceptance scope for BIRD-SQL, BrowseComp+, and
SWE-bench because upstream publishes ID lists rather than Stage-3 outputs and
the required database, corpus/index, and Docker assets are not all available in
current evidence. GSM8K-only characterization can gate the first
implementation unit. Requiring all domains at that gate needs a separate asset
feasibility run, not a hand-authored substitute.
