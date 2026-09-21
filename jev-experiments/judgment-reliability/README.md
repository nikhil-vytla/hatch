# Judgment reliability on complete JudgeBench

Completed: 7,440/7,440 evaluation records, covering 14,880/14,880 independent question decisions. The frozen study includes all 620 released response pairs, both orders, three unchanged pairwise passes, pair-context whole-answer scoring, and isolated-candidate whole-answer scoring. Pass 1 official two-order accuracy is 66.29%, compared with 74.68% single-order accuracy and 16.77% answer-identity disagreements between the two orders.

## Design and source

[JudgeBench](https://github.com/ScalerLab/JudgeBench/tree/e2c52c284e735e139b3daa61c206ee208f36c461) supplies 350 GPT-4o pairs and 270 Claude 3.5 Sonnet pairs. These are 620 candidate pairs from 528 source-question groups, with 308 MMLU-Pro, 239 LiveBench and 73 LiveCodeBench pairs. The source commit is pinned to `e2c52c284e735e139b3daa61c206ee208f36c461`; manifest.json stores source-file SHA-256 values, complete input hash, protocol hash and maximum input size. cases.jsonl contains the full original question and both answers plus provenance and content triage. No candidate generation or model training occurred.

The frozen v2 encoding follows the [TypeSafe independent-question contract](https://docs.typesafe.ai/primitives). Each question contains its exact complete evidence. Pairwise and shared pointwise questions each see the entire pair; isolated pointwise questions see one candidate as answer A. All questions share only a constant policy state. The provider contract says questions are evaluated independently, so another question's opponent text is not part of the isolated question's information set. This is a documented API assumption, not an empirically proven absence of provider cross-question interference.

Both orientations use the same pairwise instructions and whole-answer correctness questions. Repeats keep per-question content and hashes unchanged. Three sequential passes use scheduling seeds 42, 43 and 44; these seeds do not control sampling inside the model. Within each pass, cases and methods are interleaved. Native batches are limited to 24 questions and 64,000 serialized bytes. There is no concatenation of unrelated evidence inside one question and no gold leakage. Batch mappings, original question hashes, whole request hashes, timestamps, returned model identifiers and attempts remain in the append-only events.jsonl.

The original state-encoded pilot recorded 75 successful evaluation records before shared-key rate limits made separate HTTP requests wasteful. It lives in pilot/ and is excluded from every v2 aggregate. The v2 encoding changes context placement, so these results cannot be pooled with that pilot or the historical 100-pair gallery.

## Results

| Pass | Pairwise official | Pair-context pointwise official | Pairwise ordered | Isolated accuracy | Complete paired orders |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 66.29% | 55.65% | 74.68% | 75.00% | 620/620 |
| 2 | 65.16% | 55.65% | 74.35% | 75.16% | 620/620 |
| 3 | 65.97% | 57.26% | 74.52% | 75.48% | 620/620 |

The [official scorer](https://github.com/ScalerLab/JudgeBench/blob/e2c52c284e735e139b3daa61c206ee208f36c461/utils/metrics.py) reverses the second displayed vote, adds +1 for a correct vote, -1 for an incorrect vote and 0 for a tie or null, and credits a positive sum. With two completed A/B votes this requires the correct answer in both orders. Nulls retain official behavior, so a correct vote plus a null can receive official credit; availability remains explicit. Pair-context pointwise ties remain exact ties instead of becoming answer A. Isolated scoring ranks two separate scores and has no genuine two-order score.

| Source response model | Pairs | Mean official pairwise over 3 passes | Mean official pair-context | Mean isolated accuracy |
| --- | ---: | ---: | ---: | ---: |
| gpt-4o-2024-05-13 | 350 | 70.57% | 58.95% | 78.19% |
| claude-3-5-sonnet-20240620 | 270 | 59.63% | 52.59% | 71.36% |

| Method | Complete 3-pass sets | Answer identity flips | Tie transitions | Nonzero score drift | Mean score range |
| --- | ---: | ---: | ---: | ---: | ---: |
| pairwise | 1240/1240 | 53 | 0 | 1079 | 0.03111 |
| shared | 1240/1240 | 76 | 64 | 1236 | 0.04738 |
| isolated | 620/620 | 32 | 21 | 611 | 0.04400 |

Answer flips require both A and B to win within a matched set. A winner/tie transition is separate. Numerical drift is the range of canonical P(A) for pairwise judgments, or the larger of the two candidate score ranges for pointwise judgments. A score can move while the best answer stays fixed. The 1,240 pair-orientation repeat sets are not independent source questions. Order comparisons also include run-to-run variation; an answer disagreement across orders is not an isolated causal estimate of position bias.

## Paired uncertainty

Analysis amendment judge-reliability-analysis-v2.1 corrects the frozen manifest's erroneous 268-question count. Missing original IDs had grouped unrelated questions together. The source cases, request protocol, recorded decisions and accuracy counts remain unchanged; question grouping and uncertainty intervals are corrected. The original manifest stays available as historical evidence alongside the amendment.

Intervals use 10,000 reproducible bootstrap draws over 528 source-question groups, preserving candidate pairs, both response models, orientations and repeats within each group. Group every pair by source plus SHA-256 of its exact question string. This keeps repeated questions together when original_id is missing or when identical text has different source IDs. The archive is checked to contain no non-null source+ID spanning multiple question texts; such variants would require connected-component grouping. They estimate variation across broader questions, not uncertainty in the fixed benchmark count. Comparisons use the same original cases. Missing matched sets are excluded from intervals and their counts are explicit.

| Quantity | Matched pairs | Clusters | Estimate | 95% interval |
| --- | ---: | ---: | ---: | --- |
| pairwise_official | 620 | 528 | 65.81% | 62.12% to 69.46% |
| shared_official | 620 | 528 | 56.18% | 52.40% to 59.96% |
| isolated_accuracy | 620 | 528 | 75.22% | 71.90% to 78.45% |
| pairwise_minus_shared_official | 620 | 528 | 9.62% | 6.47% to 12.87% |
| pairwise_minus_isolated_ordered | 620 | 528 | -0.70% | -3.24% to 1.81% |

Analytic controls include fixed displayed-A voting, which earns 50% ordered accuracy and 0% official two-order accuracy; independently random votes, with 25% expected official accuracy; and one random canonical answer held constant across swaps, with 50% expected official accuracy. Shorter/longer original-text baselines are evaluated deterministically, with equal lengths represented as ties. These controls explain why the two accuracy measures differ without changing the official metric.

## Availability and limitations

1177 native batches returned 14,880 question decisions across 1779 network attempts. 602 attempts were unsuccessful, 5 logical batch invocations exhausted transient retries, and 0 nontransient failures were retained. Median successful-batch latency was 487ms and the 95th percentile 36546ms, including internal retries. The observed window is 2026-09-20T20:05:27.680Z to 2026-09-20T22:46:50.077Z. Returned model aliases: typesafe-ai/jev. The provider did not expose a separate immutable model revision. Reported cost is $0; a zero metadata value is not a billing audit.

All 14,880 question outputs are retained in normalized evaluation records. Of these, 14,614 also match saved native-batch answer maps exactly; the earliest 21 accepted batches, containing 266 questions, predate batch-map logging and retain normalized outputs only.

Repeated observations share one collection window and do not establish long-term provider stability. The benchmark is public, so training-data contamination is not ruled out. Model confidence and correctness scores are not calibrated truth probabilities. Whole-answer scoring is not claim-level verification. No labels or response models were sent in evidence; the upstream objective label supplies the scoring target. We retained incorrect judgments and exact returned numbers. Only transport/transient failures can be retried. Completed judgments cannot be replaced by more favorable answers.

## Explorer and content handling

The replacement JudgeBench component navigates unique pairs, preserves answer identities across swaps, saves the first blind practice vote on the device, and requires a separate reveal for labels. Diagnostic filters preserve entire pairs across methods and repeats. The matrix distinguishes canonical winner flips, pointwise ties and score drift. It shows full raw question/answer text, expanded reading, source links, exact hashes, exports, split metrics, score distributions and separate provider availability. Per-pair chunks load independently of the complete evidence archive.

Content triage reuses 10 exact-question matches to prior human review and adds 11 lexically flagged pairs. Those 21 pairs require a deliberate text reveal. The lexical scan is not an exhaustive human audit. Original strings render as React text, including HTML syntax, and no raw HTML executes. The source and evidence archives require an explicit download click.

## Reproduction

Run from the repository root, using Bun and the existing local recording credential loader. Credentials remain server-side and are never imported into the frontend.

```sh
bun jev-experiments/judgment-reliability/prepare-source.ts
bun jev-experiments/judgment-reliability/record.ts
bun test jev-experiments/judgment-reliability/scoring.test.ts
bun jev-experiments/judgment-reliability/verify.ts --complete
bun jev-experiments/judgment-reliability/analyze.ts
bun jev-experiments/judgment-reliability/prepare.ts /tmp/judge-preview
bun jev-experiments/judgment-reliability/report.ts
```

prepare-source.ts uses the pinned upstream files in the existing ignored cache and refuses source/protocol drift. A clean checkout already contains cases.jsonl and manifest.json, so recording and analysis can start without that preparation step. record.ts resumes only unanswered evaluations, verifies successful question hashes, logs retries and recovers normalized rows from complete recorded batches if interrupted. Set JUDGE_CONCURRENCY only to change recording pace. prepare.ts exposes prepareJudgmentReliability(target) for the app's clean build; it generates hashed chunks from committed evidence and returns the compact publication document.

Ten deterministic tests cover the full official vote/tie/null truth table, identity remapping, ties versus numeric drift, all source coverage, exact candidate preservation, no gold metadata in model evidence, content gate retention, and unchanged per-question hashes/information sets across all three repeats. Regression cases also check missing source IDs, identical questions with different IDs, and unchanged headline scores after the grouping correction. Browser validation is recorded in NOTES.md.

For an already-running recording, `bun jev-experiments/judgment-reliability/finalize.ts --wait-for-pid=PID` waits for that process, requires its lock to be gone, then runs complete verification, analysis and report generation. It makes no model calls, commits or deployments. An ignored `.finalization.json` records completion or a failure requiring review. Publish a final data snapshot only after inspecting the verified reports.
