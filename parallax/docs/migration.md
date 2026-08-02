# Migration note

PR2 moves the PR1 characterization from `parallax-upstream-characterization/` to `parallax/characterization/`. Product history now lives in the single `parallax/NOTES.md`, and the short project entry lives in `parallax/_summary.md`. Durable decisions and asset findings moved to `parallax/docs/`.

## Accepted from the evidence branch

The clean implementation retained these validated concepts, then rewrote them from first principles:

- deterministic canonical bytes and domain-separated content IDs
- separate public and sealed commitments
- explicit source pins and individual asset provenance
- native verifier authority with closed grading outcomes
- atomic publication and locked byte replay
- a frozen provider-backed construction boundary for later work

PR1 showed that GSM8K is the only reviewed domain whose narrow native final-answer check needs no large evaluator asset. PR2 therefore implements GSM8K only.

## Rejected

The clean stack does not migrate `ProposalBundle`, `Reveal`, `Revise`, `Switch`, `compile_plans`, `_matched_turns`, or any class labeled `EvolvingIntent`. Those records did not execute the pinned extraction, counterfactual, predecessor, scheduler, fill, render, or `ChangePlan` paths.

PR2 also rejects the universal variant catalog, bespoke SWE schedules, checkpoint placeholders, synthetic campaign API, experiment runner, HUD adapters, Click recipes, and compatibility reads for `parallax.frozen-proposal.v1`. Repeated-character placeholder digests and hand-authored records do not become provenance by moving them into a typed schema.

## Characterization boundary

The pinned Microsoft repository remains a characterization oracle at commit [`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a), not a production dependency. Its generated conversation pools, provider transcripts, rejected attempts, dependency locks, and paper result bundles are unavailable. The machine receipt under `characterization/fixtures/receipt.json` preserves that finding.

PR2 makes no Evolving Intent compatibility claim and adds no generation or experiment execution. Those concerns remain outside this pull request.
