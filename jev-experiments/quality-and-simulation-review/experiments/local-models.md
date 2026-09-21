# Decision models on a Mac

Verdict: repair. Highest priority: P1. Audited against `4c0c40d5`; the Apple runners, results and React component have no diff from that baseline.

## Current experiment and strengths

This is a recorded comparison of local probability readouts, a fine-tuned Laya decision head, its Core ML export and hosted Jev. Jev answers five typed questions for each case through AI Gateway. Local code packs text, branches cached prompts, computes token or option likelihoods, trains only the Laya head, selects checkpoint/temperature on validation, and scores every prediction. The browser makes no local inference call. It displays aggregate tables, a training curve and a complete case/question explorer. Paths below are relative to `jev-experiments`.

The experiment already does several difficult things correctly. It uses all 400 external test cases, with 100 cases in each workflow, five questions per case and ten fully populated model/baseline rows. The source pins model and dataset revisions. Case IDs join predictions, and option-key alignment is checked before publication. Source: `local-models-and-games/apple/prepare.py:9`; `aggregate.py:17`, `:178`; `experience-prototypes/src/local-models.tsx:333`.

The 960/240/400 training/validation/test split has no ID or exact-state overlap in the published manifest. Selection and calibration use validation before test evaluation. Input packing rejects oversized examples instead of silently truncating. Source: `train.py:20`, `:86`, `:97`, `:110`; `data.py:53`. The UI explicitly calls the target synthetic teacher agreement, warns that the fine-tune loses to the training prior, distinguishes specialized and general models, and explains differing timing workloads. Those warnings should remain. Source: `local-models.tsx:108`, `:159`, `:215`, `:239`.

The independent audit probe recomputed agreement, Brier and KL from all 20,000 published distributions. Every displayed value matches within 4.3e-9. The two applicable integrity tests pass 64,810 assertions. Core ML was actually run on the entire test set, and the UI discloses its 60 changed decisions rather than extrapolating its initial parity checks.

## Findings

### P1: a useful local decision policy has not been established

Fine-tuning improves teacher agreement from 727/2,000 to 939/2,000, but the input-independent training prior gets 979/2,000. A case-level paired bootstrap gives the fine-tune's difference from its base as +10.6 percentage points, interval +7.5 to +13.75. Its difference from the prior is -2 points, interval -4.8 to +0.8. These are conditional uncertainty estimates from the recorded cases, not variation across training seeds. The sample supports a training improvement; it does not establish an improvement over the prior.

All five argmax answers match the teacher in only 10/400 tuned cases, versus 30/400 prior cases and 89/400 Jev cases. This does not mean those forms are objectively right or wrong, but it shows why per-field agreement cannot become an automatic form-completion success rate. Source: [original probe](../probes/local-models.ts) and [results](../probes/local-models.json); `aggregate.py:122`.

The tuned head varies its argmax within all 20 workflow/question groups, so it is not literally a constant predictor. The missing test is whether its response to a changed fact helps the task. Add independently labeled minimal pairs, an abstention policy and full-case outcomes. Preserve the current warning until a useful risk/coverage trade-off beats the prior and code rules on held-out cases.

### P2: nominal runtime parity is not a deployment acceptance test

`export_coreml.py:198` sets `passed` from twelve initial checks, requiring equal argmax and probability error below 0.02. `aggregate.py:179` later attaches the full test but does not revise that flag. The full export changes 60/2,000 argmax choices and reaches a 0.14228 absolute probability difference. One changed decision has an MLX top-two margin of 0.13939, so the discrepancy cannot all be dismissed as near ties. `local-models.tsx:309` honestly discloses the full result, but the top-level flag still means only the small initial conversion check.

Keep separate fields for conversion success, initial smoke parity and full decision equivalence. Define tolerances by downstream decisions, including review thresholds, then test them on the full set. Investigate precision, fixed padding and batch shape separately before attributing the difference only to float16. Do not replace the measured Core ML row with MLX predictions.

### P2: the timing table compares different execution paths

The timing note discloses the differences, but they are large enough to determine the result. Laya MLX batches five complete rows with dynamic padding; Core ML makes five sequential batch-one calls padded to 768 tokens. First-token timing excludes tokenization, while full-option timing includes branch tokenization. Source: `benchmark_laya.py:26`; `benchmark_coreml.py:27`; `prefill.py:86`; `sequence.py:39`; `aggregate.py:201`.

Recorded medians are 186.8 ms for tuned MLX and 555.6 ms for Core ML, with different work included. They measure these implementations, not the intrinsic speed of MLX versus Core ML or the benefit of prefix reuse. Cache parity is tested, but there is no matched uncached timing condition. Add both end-to-end and inference-only boundaries, matched one/five-question batch conditions, cached/uncached comparison, cold load and memory measurements. Randomize run order and repeat on the same machine. Keep hosted latency separate and retain physical request IDs; copied per-case batch timings cannot reconstruct independent network samples.

### P2: the headline averages obscure readout failure patterns

For the Qwen 0.6B label readout, 10/20 workflow/question groups give the same argmax on all 100 states. Full-option scoring gives 12/20 constant groups, including every agent-trace question. The tuned Laya and Jev rows have none. These are exact published prediction counts, not a claim that tokenization or caching is broken. A label can be genuinely common, but these patterns deserve direct inspection before more training or larger downloads.

Jev also assigns exact zero to an option with positive teacher mass on 818/2,000 decisions. This explains why its strong argmax agreement and much worse KL can coexist; the shared 1e-12 floor is documented and consistent. Source: `metrics.py:6`; `local-models.tsx:233`; probe results. Add per-question confusion/entropy, label-position sensitivity and option-description paraphrases. Compare calibration fitted on validation for every readout, while keeping raw scores visible. Do not interpret restricted-label softmax or mean option likelihood as an independently calibrated probability of correctness.

### P2: the explorer cannot test a user's counterexample

The interface changes only model, workflow, case and question selection, plus a teacher-disagreement filter. It has no state editing, paired comparison, abstention policy or correction session. Source: `local-models.tsx:61`, `:338`, `:435`. This is a good evidence viewer, accurately labeled as recorded, but it does not answer what happens when one invoice amount or trace constraint changes. Add an explicitly separate experiment mode with frozen example pairs first, and optional local execution through a companion service later. An edited state must invalidate cached predictions immediately; matching a nearby record is not inference.

## Richer simulation: a local-first review desk

The visitor opens a fictional invoice and its purchase order, chooses local-only or local-with-hosted-escalation operation, and adjusts one fact such as quantity received or duplicate invoice ID. A structured form shows recommendations, supporting facts and a review state. The visitor can accept, correct or defer each field, then inspect a branch that changes one fact. A background replay can illustrate recorded decisions, but should always say it is replay.

Canonical state includes case revision, source facts, field proposals, accepted edits, model/runtime version, review policy and provenance. Code validates arithmetic, duplicates, allowed transitions and edits. The local model proposes typed judgments; Jev only handles an explicit escalation with the visible minimum context. It does not authorize payment. Corrections enter a separate training pool and never the frozen test set. A request created at revision N cannot overwrite a correction at N+1. Local service failure leaves the form editable; hosted failure leaves it awaiting review, with no fabricated substitute score.

Acceptance criteria are zero stale overwrites across edits/undo; no network request in local-only mode; visible provider and runtime for every suggestion; a repeatable recorded pair that changes the relevant output without changing unrelated accepted fields; export/MLX differences visible at review thresholds; and a complete submit-for-review outcome scored by independent invoice rules. The model must improve review effort or correct deferral at a declared error budget, not merely make probability bars move.

## Evaluation and full coverage

The official [Typed Decisions card](https://huggingface.co/datasets/LocalLLaMA/typed-decisions) specifies four workflows, each with 300 train and 100 test cases, and five questions per case. Current coverage is already the full 400-case, 2,000-decision test split at pinned revision `ea9306458d6e9563628369a3d1e72e362fb381d2`. The site's combined subset duplicates the per-workflow packaging; its 3,200-row display is not 3,200 independent cases. The card asks for distribution metrics alongside agreement and separates specialist from generalist evaluation. Its teacher is synthetic, so use independent task labels for deployment claims.

Preserve all released test cases. Publish a scoring contract with the exact KL floor, tie rule, expected ordinal score and Brier normalization. This repository averages squared error per option, and its uniform baseline chooses the first tied option; external leaderboard numbers must not be mixed without a scorer-parity check. Add macro-F1, per-question results and whole-case agreement. Bootstrap by case, not by the five correlated questions, and rerun training with five seeds using unchanged development/test separation. Compare the existing prior, uniform, original/tuned/export heads, both Qwen readouts and a simple frozen-embedding classifier fitted on the same 960 cases.

Add 200 independently checked counterfactual pairs, 50 per workflow. Change a decisive fact, reverse a negation or permute irrelevant fields; designate required output changes and invariances before inference. Score factual rule compliance, appropriate deferral, pair consistency and error at accepted-coverage thresholds. These 400 new cases are authored additions, not extra official test rows. For hosted comparisons, three repeats over the official set plus the paired set require 2,400 case evaluations or 12,000 typed decisions, with up to 600 physical batches at four cases per batch before retries. No such calls were made for this audit.

For runtime evaluation, use 40 stratified cases in one/five-question, cached/uncached and matched padding conditions, ten randomized repeats. Report end-to-end and inference-only p50/p95, cold load, peak memory, and actual threshold disagreement after export. Keep provider availability distinct from model accuracy. Check source-family and near-duplicate overlap in addition to the already passing exact-state split checks; do not claim pretrained contamination is known absent.

## Libraries and next steps

- [MLX](https://ml-explore.github.io/mlx/build/html/index.html) already supports the local implementation. Its evaluation and memory controls support matched cached/uncached timing and reproducible training runs. Jev can remain the optional general-schema escalation path.
- [Core ML Tools prediction](https://apple.github.io/coremltools/docs-guides/source/model-prediction.html) supports real converted-model execution with explicit compute-unit choices. Use it for threshold-aware export checks; `ALL` does not itself prove Neural Engine placement.

P1/M: add counterfactual rules and a validation-chosen review policy that must beat the prior at the chosen task loss. P2/S: publish the per-question and whole-case diagnostics plus case-level uncertainty. P2/M: split export acceptance flags and investigate the 60 changed decisions. P2/M: run matched timing conditions. P2/L: build the editable review desk and optional local companion runtime. The same correction/provenance design can later support an offline triage application without claiming the current static page runs models in the browser.

## Investigation log

Read catalog/publication routing, the complete LocalModels component, packing, prompt-cache and option-scoring implementations, training/selection, Jev recorder, export and aggregation paths, split manifest and relevant tests. Decoded full JSONL through `readRecord`; the original Bun probe recomputed all metrics, whole-case scores, constant-output groups, paired bootstrap intervals, split overlaps and export differences. Fixed one probe syntax typo before its successful run. Two filtered integrity tests passed 64,810 assertions. Verified primary dataset and runtime documentation; the pinned raw card was fetched directly after the browser reader rejected that URL. No model inference, training, browser interaction, app changes or commits.
