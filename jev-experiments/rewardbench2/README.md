# RewardBench 2 with Jev

Experiment 28 now asks whether Jev can recognize better answers, using [RewardBench 2](https://huggingface.co/datasets/allenai/reward-bench-2). Ai2 supplies the prompts, candidate responses, and chosen/rejected labels. Jev assigns a reward score to each supplied answer; it does not generate the answers or determine the reference labels. The [public experiment](https://jev-experiments.vercel.app/#experiment/rewardbench2) replaces the earlier IFEval writing-selection demo.

## What the run measures

The full test split has 1,865 cases and 8,977 candidate answers. Its categories are Focus, Factuality, Math, Safety, Precise IF, and Ties. Precise IF still uses executable checks when constructing its reference labels, and the app identifies that category explicitly. The other categories make this a broader test of semantic reward judgments than the previous IFEval-only proposal.

Each answer receives an independent Jev `Score` question. Shared state contains only the evaluation policy. The question contains its own prompt and candidate answer as serialized structured JSON, without source IDs, preferred/rejected labels, other candidate answers, or model attribution. The runner batches these questions within 90 KB and 128-question limits, following TypeSafe's [documented question independence](https://docs.typesafe.ai/primitives). The exact policy and ten-level rubric are in [protocol.ts](protocol.ts) and in the app. A fractional score is the expected rubric level, shifted from 0–9 to 1–10; it is not the probability that the answer is correct.

The first five categories give a case one point when its preferred answer has the highest score. A tie for highest score splits that point equally. Ties uses all 51 pairs of reference and multiple-valid-answer prompts, checking separation between valid and invalid answers and spread among valid answers. Its pinned upstream formula includes an adjustment between −1 and +1 percentage points and can reach 101%. The headline is the unweighted mean of the six category scores.

This is an adapted Jev evaluation, not an official leaderboard submission. It uses a fixed rubric and one pinned split. It does not establish that Jev is a good reward model for every training task, and no policy model is trained here. No new Qwen responses or Gemini/OpenAI reference judgments are generated. GPT-5.6 Sol was used for the separately requested content review only.

## Reproducibility

- Dataset: `allenai/reward-bench-2`, revision `7ff08853b0d5686e79b13fda8677024f566a104a`, test split.
- Parquet SHA-256: `c8ec60efbd75d2f9dcba4121e6101f7a6015abc38a34e034ae2c7ae886265958`.
- Upstream scorer: `allenai/reward-bench`, revision `05a9005efb607249822c193590c8ecab87c77052`, particularly [`process_single_model`](https://github.com/allenai/reward-bench/blob/05a9005efb607249822c193590c8ecab87c77052/rewardbench/utils.py#L1033).
- Model route: `typesafe-ai/jev` through Vercel AI Gateway. The route is an alias; the recording helper does not expose a versioned model snapshot.
- Dataset license: ODC-BY. The source card also describes the terms attached to third-party generated responses.

From the repository root, with Bun and a Python environment available:

```sh
uv venv jev-experiments/.venv
uv pip install --python jev-experiments/.venv/bin/python pyarrow==25.0.1 numpy pandas
bun jev-experiments/rewardbench2/prepare.ts
bun test jev-experiments/rewardbench2
bun jev-experiments/rewardbench2/run.ts
bun jev-experiments/rewardbench2/validate.ts
jev-experiments/.venv/bin/python jev-experiments/rewardbench2/verify-upstream.py
```

Skip environment creation when using the lab's existing `.venv`. `RB2_PYTHON` can select another interpreter. The runner loads `AI_GATEWAY_API_KEY` from the process environment or the existing local credential helper. It never writes the key to result files. `RB2_LIMIT` makes a first-N integration run and labels it accordingly; omit it for the full benchmark.

Downloaded data and upstream scorer code stay under ignored `.cache/rewardbench2`. Candidate checkpoints are keyed by both subset and ID because IDs overlap across subsets. Protocol and source-input hashes prevent stale cache reuse. Gateway overloads and rate limits are retried with `Retry-After`; only completed cases appear in the browser, and overall quality remains pending until every case completes. The committed publication source is a JSONL display derivative, reconstructed into ordinary JSON during the app build. Its `manifest.publication_source` identifies the exact pre-derivation record by SHA-256; the derivative bytes are not the original evaluation record or the upstream dataset.

## Reading the published content

The app shows prompts and candidate answers subject to the display omissions below, with source attribution and pinned provenance. Its blind view lets readers choose an answer before revealing Jev's scores and the dataset labels. Supplied attribution sometimes names human editing or a source method rather than a model; it is not silently normalized into a guessed model name.

The [content audit](content-audit/README.md) flags 41 non-Safety cases, and all 450 Safety cases require deliberate reveal. Three prompts and six candidate fields across four cases contain explicit sexual descriptions involving minors and are omitted from both the committed JSONL and public JSON. Their hashes, positions, labels, and scores remain. All 1,865 cases still count toward the benchmark. Hash-checked publication tests enforce the omissions. The audit used lexical screening and contextual review, not exhaustive sentence-by-sentence human annotation.

Four additional candidate texts are withheld under a separate publication policy. Their `publication_omission` entries retain the original text hashes; all row identities, order, labels, model scores, requests and aggregate metrics remain unchanged. `publication-source.ts` applies this derivative when writing full results or partial checkpoints, and the app projection is idempotent. `validate.ts` uses the pinned upstream cache to restore those four fields privately and reconstruct the exact predecessor hash; it checks the four publication omissions separately from the three prompt and six candidate content-review omissions.

Earlier content-review findings also add notices to the public JudgeBench and CLINC150 views. Those views and the BANKING77-derived experiments now expose dataset provenance. The old language artifact is removed from the public publication manifest.

## Validation and results

All 1,865 cases completed, with an **80.90% six-category mean**. No unavailable cases are counted as incorrect answers or removed from the denominator.

| Category | Cases | Score |
| --- | ---: | ---: |
| Focus | 495 | 86.57% |
| Factuality | 475 | 85.89% |
| Math | 183 | 77.05% |
| Safety | 450 | 93.44% |
| Precise IF | 160 | 50.63% |
| Ties, special composite | 102 | 91.82% |

Precise IF was the weakest category in this run. This is useful evidence for the user's concern about using Jev to approximate executable validators, although differences between these categories do not establish a causal explanation of model behavior.

[validation.json](validation.json) checks every prompt, candidate, attribution, label, omission, and case key against the pinned input, then recomputes the metrics. [upstream-parity.json](upstream-parity.json) records an exact match with the original pinned Python scoring functions for all six categories. The run completed 255 batches; three earlier quota failures were recovered. Recorded successful batches reported $0 in gateway charges during Vercel's promotional pricing. Pilot calls and diagnostic probes are separate from this accounting.

Ten benchmark/publication tests and 17 existing server/credential tests passed. Browser checks passed for dark and light themes, blind selection, reveals, filtering, search, Safety gates, and 320-pixel layouts. No source cases were trimmed to fit a request.

The live exact-equality check **did not pass**: the same authored question scored 8.88 alone and 8.86 with an unrelated question on the native 0–9 scale. Four subsequent repeats in each condition both ranged from 8.87 to 8.88, with identical means of 8.8775. [Initial check](isolation-check.json) and [repeat controls](repeat-check.json) preserve the observations. This small study shows request-to-request variation and cannot isolate a general batching effect. Structural input isolation and the provider's documented contract do not imply bit-for-bit numerical reproducibility; tiny score gaps need caution.

See [NOTES.md](NOTES.md) for implementation findings and the discarded integration pilot.

## Deployment

[PR #55](https://github.com/nikhil-vytla/hatch/pull/55) is open under `nikhil-vytla`. The existing [public app](https://jev-experiments.vercel.app/#experiment/rewardbench2) runs Git commit `97093d30deb824c818dbd32536b4c605358a00e8`, built by Vercel from GitHub with the configured app root. [Production verification](deployment-verification.json) confirms all 1,865 cases, an exact data-file hash match with the verified local build, content omissions, and removal of the old public language artifact. The PR remains unmerged.
