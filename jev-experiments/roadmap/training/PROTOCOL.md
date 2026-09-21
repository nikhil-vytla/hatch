# Typed decision study v1

Status: frozen design; no configuration or installed default has been selected. The earlier Typed Decisions workflow specialist is excluded from general adaptation. Any partial execution is a pilot until every gate below passes.

## Questions and conditions

Compare the published Laya encoder/scorer, SmolLM2-360M-Instruct typed label readout and Qwen3-0.6B typed label readout. Each backbone stays frozen; adaptation learns a small residual typed readout with MLX. This is a readout adaptation study, not full-backbone fine-tuning. Compare the original frozen readout, state-blind per-kind priors, lexical overlap and a frozen embedding similarity condition. Embedding extraction must use the same pinned backbone and report its method. The earlier Laya workflow specialist remains a separate historical result.

## Corpus and splits

All upstream revisions and source SHA-256 values are fixed by `sources.json`; `prepare.py` emits a manifest with every transformed row hash and split ID before model extraction. Public source text stays in the ignored cache. Dataset IDs plus source-row positions identify examples. Train-source rows are ordered by SHA-256 of `jev-typed-v1:dataset:source-id`; the first 256 are train and next 64 validation. Public held-out splits supply the first 128 hash-ordered rows per dataset. No official test labels are needed or inferred.

- BANKING77: official train supplies adaptation and validation; official test supplies evaluation. Each task contains the true intent and seven deterministic distractors selected from the remaining intents. Names become descriptions by replacing underscores with spaces. This is an eight-candidate derivative, never a full 77-label BANKING77 score.
- BoolQ: original train supplies adaptation and validation; released validation supplies held-out evaluation. The entire passage is state, and the original question becomes a boolean question.
- STS-B: sentence-transformers train supplies adaptation; validation supplies validation; test supplies evaluation. Original sentence pairs are state. Its normalized [0,1] score is multiplied by five. The target distributes mass linearly between adjacent integer levels 0..5, preserving the original expected score. Report ordinal MAE on [0,5]. This is an ordinal derivative, never the original correlation benchmark.
- CLINC: 128 held-out test examples, with the true intent and seven deterministic distractors. No CLINC example enters adaptation or configuration selection. Out-of-scope rows are separately sampled and identified if evaluated.
- MultiRC: 128 released validation answer candidates, each represented as a boolean decision given the entire paragraph, question and proposed answer. This measures answer validation, never paragraph-level exact match.
- SummEval: 128 summary-system pairs, with mean expert fluency mapped by linear interpolation to ordinal 1..5. Source document, reference and system summary remain distinct. No labels enter adaptation. If annotations cannot be fetched with a stable source and understood rubric, coverage is zero and the gate fails.
- Typed Decisions: all 400 released test cases, all questions, using the original gold distributions. No Typed Decisions train case enters general adaptation, hyperparameter selection or calibration. Report all cases and per-kind coverage, with unsupported rows retained.

Training examples cycle through three fixed instruction paraphrases; candidate descriptions have two semantically identical textual forms; option order uses a seeded permutation keyed by case ID and epoch. Validation and evaluation use canonical wording and order. A second held-out evaluation reverses options while retaining identities. Priors are learned only from adaptation labels and align by semantic value rather than position.

## Fixed search and selection

Backbone/tokenizer revisions are immutable. Input limits are 768 tokens, eight options and 32 questions. No truncation is allowed; rejected examples remain in the coverage denominator. A one-layer residual readout is the only trainable module. Search learning rates {0.0001, 0.001}, weight decay 0.01, batch size 16, epochs {1, 3}, AdamW, gradient norm at most 1.0. Use seed 17 for recipe selection. Select epoch and learning rate by macro-average validation negative log likelihood across the three adaptation datasets, breaking ties by lower parameter count, then lower learning rate, then earlier epoch. Fit temperature from {0.7, 1.0, 1.3, 1.6, 2.0} on validation only. Repeat the selected recipe from the same frozen base with seeds 17, 29 and 43. Never select from test or unseen-dataset results. If no model satisfies validation coverage >= 0.95 and finite probabilities, there is no installed default.

The default is selected by lowest validation macro NLL among complete exports that preserve >=99% validation argmax agreement and <=0.02 maximum probability error against MLX; ties within 0.01 NLL use lower measured warm median latency. Final test results cannot change the default. Experimental models require an explicit install choice until this gate passes.

## Evaluation and evidence

Primary metrics: per-dataset and macro negative log likelihood, top-label accuracy/agreement with soft-gold argmax, multiclass Brier score, ten-bin expected calibration error, ordinal expected-value MAE where applicable, and coverage. Report rejected counts/reasons, option-order agreement and total-variation distance, and independent versus batched output delta. Report all three seeds rather than only the best one.

Export the complete inference graph to Core ML, including backbone, typed readout, calibration and masking. A readout-only export does not satisfy the gate. Compare every supported held-out and transfer decision against MLX. Record prediction agreement, probability delta, calibration and ordinal changes, cold load plus first prediction, warm median/p95 over 30 repetitions, peak process RSS, MLX peak memory and artifact SHA-256. CPU_ONLY and ALL are separate conditions; do not infer Neural Engine placement. Serialize GPU work and timing runs.

Commit code, manifests, hashes and aggregate measurements. Do not commit model weights or copied upstream datasets. A failed export or weak model is publishable evidence but does not meet the distributable runtime gate. All release claims link to this protocol and measured outputs.

## Pre-fit review amendment, 2026-09-20

Fable reviewed the protocol before any readout fitting. Exact task-content hashes now exclude train or validation rows that duplicate a higher-priority evaluation split, with exclusions listed in the manifest. Repeated BoolQ passages with different questions are distinct tasks; STS-B pair identity ignores sentence order. This prevents exact task overlap in the selected corpus, not all semantic similarity or unknown pretraining exposure.

SummEval fluency receives only the system summary. Source-document hashes and reference counts remain provenance fields; source articles and references do not enter the model prompt. This tests grammar/readability, not faithfulness or relevance, and avoids making unrelated source length the main coverage limitation. Choice gold keys retain case; only boolean gold keys are lowercased.

Choice priors use training label counts with Laplace-one smoothing only when every candidate has been observed. Otherwise the complete distribution is uniform. Ordinal priors are uniform on any scale other than the exact training 0..5 scale. Each baseline output records which rule applied. Candidate forms are exactly `{intent name with underscores replaced by spaces}` and `The request concerns {intent name with underscores replaced by spaces}.`; the manifest records both forms and all three instruction paraphrases.

Published Laya was trained for typed decisions. Its original training provenance is not independently sufficient to rule out exposure to these evaluation datasets; all Laya transfer cells carry `upstream training overlap unknown`. Exposure to Typed Decisions training alone does not establish test leakage, so this is a provenance limitation, not a declaration of leaked test labels. SmolLM2 and Qwen pretraining exposure to the public benchmarks is likewise unknown. The new readout adaptation excludes all Typed Decisions examples. The same 192 nominal validation rows, minus reported duplicate exclusions, select recipe, temperature and eventual installed default; test and transfer labels do not select any of them. This validation reuse can make validation estimates optimistic.

Complete export evidence must list token-ID/mask input specifications, final probability output specifications, backbone and readout parameter counts, artifact hashes and compute units. Embeddings supplied by MLX are forbidden as Core ML inputs. Both CPU_ONLY and ALL must pass the agreement gate; ALL warm timing breaks validation-quality ties. The first supported validation row in corpus order is the fixed 30-repetition timing input and its ID is recorded. Runtime adapters override general contract limits with 32 questions, eight options and 768 tokens, rejecting oversized inputs before inference. Release wording is `readout adapted on three datasets`, never a general-purpose typed-decision model.
