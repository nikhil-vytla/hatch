# Cross-judge result

The cross-judge recommended [Candidate D](candidate-D.md) as the base. It won
five of six criteria, and the judge found its upstream claims accurate against
Microsoft Evolving Intent commit
`993d6be9597ac03854b46362ccd647eb1bfd267a`.

## Final scorecard

| Criterion | A | B | C | D |
|---|---:|---:|---:|---:|
| 1. Upstream stage fidelity + source restoration | 5 | 3 | 3 | 5 |
| 2. Domain seams without kernel branching | 4 | 4 | 2 | 5 |
| 3. Stochastic/deterministic split, evidence provenance | 4 | 5 | 2 | 5 |
| 4. Hard-cut migration, deletes duplicates and false claims | 4 | 2 | 3 | 5 |
| 5. Falsifiable verification harness | 4 | 5 | 2 | 4 |
| 6. Small deep API, short call chains | 4 | 4 | 3 | 5 |
| **Total** | **25** | **23** | **15** | **29** |

## Accepted grafts

1. From B, add the wheel-installed custom-domain contract test and external
   asset tamper checks for the SQL database, BrowseComp index, SWE Docker image,
   and judge prompt.
2. From B, replace D's three-way attempt outcome with `transport`, `provider`,
   `parse`, `schema`, `semantic`, and `judge`; retain parsed rejected blobs; and
   keep request IDs, timestamps, and billing in a non-identity sidecar.
3. From A, retain `from_upstream_json` for characterization, mark imported
   provenance, refuse imported packs at production sealing, and compare exact
   rendered text only under injected deterministic prefix functions.

## Rejections

- Reject C's closed domain enum, seam-authored provider traces, docstring-only
  demotion of duplicate intent models, mutable post-fill seam, and hand-authored
  characterization shapes.
- Reject B's three-release dual path, source-only `Revise` type, per-domain
  ownership of the shared extraction loop, and invented `RepeatEvidence`.
- Reject A's stage-shaped domain protocol, mutable-prefix exact-text parity, and
  migration gate that assumes upstream publishes Stage-3 fixtures.
- Reject a runtime naturalizer below the freeze line, upstream mutable prefix
  counters in production, the old matched-arm filler, and migration of
  `parallax.frozen-proposal.v1` into valid provider provenance.

## Open ambiguity

The judge could not determine the acceptance scope for BIRD-SQL, BrowseComp+,
and SWE-bench from the four designs. Upstream publishes evaluation ID lists,
not Stage-3 outputs, and the required database, corpus/index, Docker, provider,
and judge assets were not shown to be available in CI. GSM8K-only
characterization can gate the first implementation unit. Requiring every
domain at that gate needs a separate asset-feasibility run.

The surviving cross-judge JSONL record has SHA-256
`a55e88b8592c2abbe7bf5e327ccd0a031b8abe760d283f20e0e6b95ccf93ddb4`.
This file preserves only the final decision, not tool chatter or intermediate
metadata.
