# SmolLM decision model

Verdict: redesign the task and evaluation, preserve the architecture pilot. Highest priority: P1. The recorded four-choice gain is real within this run, but it does not establish useful yes/no decisions, ordinal scoring, or Jev distillation.

## What runs today

The catalog asks whether a small local model can learn choices, probabilities, and scores. `experience-prototypes/src/catalog.ts:246` calls it "SmolLM decision model"; `publication.json:23` publishes `results/replica.jsonl`. The published run uses SmolLM2-360M, 225,280 trainable LoRA and pointer-head parameters, 308 available training records, 40 validation records, and 77 test records. Its 240 replacement-sampled updates visit 163 distinct training records, as reproduced from seed 42.

The local model scores supplied options. Deterministic code constructs four-way choices using the gold intent plus three random distractors, generates a yes/no question, and derives a three-option score from the same intent-equality label. Code handles sampling, attention isolation, cross-entropy training, checkpoint selection, and metrics. Jev only answers the held-out four-choice reference requests after local training; none of its answers train this model. This is supervised architecture transfer inspired by [Kev](https://github.com/jaredpalmer/kev), whose published implementation also uses a shared document, isolated question branches, and an option readout. It is not a reproduction of Kev's training data or results.

The visitor sees three before/after accuracy panels, prose about the mixed outcome, a limitations list, and expandable raw JSON. The component has no replica-specific case selection, training replay, input field, or local inference control. This audit inspected React source, not a browser session. Evidence: `src/jev_lab/replica.py:21`, `:60`, `:103`, `:151`, `:314`; `experience-prototypes/src/benchmarks.tsx:473`, `:572`.

## What already works

- The architecture has real trainable parameters, a frozen base, LoRA in the last eight layers, reset branch positions, and a shared pointer readout. The saved adapter/head is 913,829 bytes. `replica.py:103`, `:195`, `:243`; `artifacts/MODEL_CARD.md:3`.
- Training and validation come from the upstream training split; evaluation comes from upstream test. Checkpoint selection uses validation choice accuracy. Reconstruction found no normalized exact-text overlaps between the selected train, validation, and test records. This does not check paraphrase overlap or base-model pretraining exposure. `data.py:59`, `:160`; `replica.py:165`, `:231`.
- Every published accuracy and Brier score reproduces from the saved distributions. Choice improves from 25/77 to 51/77, with 32 corrected cases and six regressions. A descriptive Wilson 95% interval for the final proportion is 55.1%–75.8%; it does not measure variation across training seeds. `results/replica.jsonl:1`, `:26`, `:103`; `probes/replica.results.json`.
- The UI explicitly distinguishes labeled-data training from Jev distillation and says the binary task did not improve. Its limitations disclose supplied distractors and endpoint-only scores. `benchmarks.tsx:508`; `results/replica.jsonl:180`.
- The existing branch-mask test passes. One recorded three-question example has maximum packed/separate probability difference 1.64e-6. Saved inference checks parameter names and enforces explicit document/request bounds. `tests/test_contracts.py:173`; `replica.py:250`; `replica_infer.py:14`, `:36`.

## Findings

### P1: The score task has no middle, and both secondary tasks largely collapse

`replica.py:26` uses one equality test to label both yes/no and score. `:51` permits only score labels 0 and 2. The reconstructed training set has 154 examples at each endpoint and zero at level 1; the test has 47 at level 0 and 30 at level 2. Thus 231 recorded outputs are three views of 77 inputs, not 231 independent examples or three independently established abilities.

After training, yes/no predicts yes on 74/77 cases and gets 31/77 correct. Its summed two-class Brier score worsens from 0.5460 to 0.7202; a uniform 0.5/0.5 forecast has Brier 0.5. Score chooses level 2 on 66/77 cases and never chooses level 1. Its 35/77 accuracy is below the descriptive always-zero result of 47/77, or 61.0%. The endpoint prior also has Brier 0.5, below the trained score's 0.6255. This is more informative than "binary did not improve." For example, `results/replica.jsonl:129` assigns 95.8% yes to "receiving money" for a query about Apple Pay top-up problems, despite a negative target.

Correction: label the existing task "intent match, endpoint labels" and show distributions, priors, false positives, and Brier beside accuracy. A true ordinal experiment needs independently annotated middle cases and an ordinal metric. Independently label the binary question too, or present it honestly as a second encoding of intent matching. Do not treat a softmax as evidence of calibrated probabilities.

### P1: The gain has only a narrow baseline and a single small selection run

`replica.py:168` samples four training examples per class, 40 validation examples from only 40 of the 77 classes, and one test example per class. `:194` evaluates an untrained, randomly initialized readout as "before"; `:231` selects among four checkpoints using only choice accuracy. The baseline is not the untuned language model's normal answer capability. No head-only ablation, lexical baseline, multiple training seeds, or selection metric covering the other tasks is recorded. The training curve is sampled single-example loss, not validation learning curves.

The test covers 77/3,080 official test records, or 2.5%, and supplies the correct label in a four-item shortlist. Including that label is part of the task definition, not hidden leakage, but it removes much of the original 77-way classification problem. Both the runner and model card already disclose this restriction. Neither currently supports a general local-model quality claim.

Correction: keep four-way reranking as a named task with locked candidate seeds; add the full 77-way classification track and equal-data baselines below. Use validation objective and per-task guardrails selected in advance, save every validation measurement, and evaluate five training seeds. Treat the original 77 public cases as development-visible in subsequent work.

### P2: The hosted comparison combines availability and correctness in one field

The reference has 32 completed requests and 45 HTTP 429 failures. All 32 answers are correct; the local model gets 19/32 on those same records. `replica.py:333` reports only `accuracy_all_attempted`, 32/77 or 41.6%, which is a valid end-to-end success measure but cannot by itself measure Jev's conditional model accuracy. `core.py:393` preserves failures, which is good. The current main panels do not claim that the replica beats Jev.

Correction: publish attempted, answered, unavailable, answered-case accuracy, end-to-end success, and the paired completed subset. Mark the quality comparison incomplete until coverage is adequate. Keep failed cases in service-success denominators, but do not describe rate limits as wrong semantic answers. A future comparison should pace requests and bound retries instead of selecting only easy-to-complete records. Evidence: `results/replica.jsonl:184` through `:260`; first rate-limit failure at `:187`.

### P1: The page cannot perform the inspection promised by the catalog

`benchmarks.tsx:473` renders only accuracy bars. Brier, target distributions, confidence errors, learning history, and the hosted outage are buried in `State` at `:618`. The published row format has IDs, target indices, and probability arrays, but no utterance, question, or option text. `replica.py:332` removes `test_records` before publishing; provenance enrichment adds a dataset link rather than the missing record contents. Visitors cannot interpret a probability array without reconstructing data and random sampling outside the page.

The CLI does support saved local inference, but there is no replica route in the website or Python server. Its default question is banking intent, yet custom inputs/options receive a result without an in-domain check. This is acceptable for a clearly marked exploratory tool, not a calibrated general-purpose form filler.

Correction: add the recorded case inspector described below first. Persist the supplied question/option text and stable option IDs with each prediction. Add optional local execution through an explicit local runtime connection, with a model-status panel, token validation, duplicate-option rejection, and separate saved versus edited cases. A hosted website should remain useful when the local runtime is absent. Evidence: `replica.py:176`, `:332`; `replica_infer.py:36`, `:62`; `src/jev_lab/server.py:34`.

### P2: The checkpoint and architecture checks need a reproducible envelope

The result pins base/data revisions but does not store train/validation IDs, the selected checkpoint step, checkpoint hash, or code revision. `artifacts/MODEL_CARD.md:11` says train/test split identifiers are recorded, but only test IDs occur in the committed result. Reconstruction is possible from current code and the cached source, as this audit demonstrates; preserving the exact selection is still preferable.

Training resolves the current base revision at `replica.py:162`; inference always loads a hard-coded revision at `replica_infer.py:11`, even when `--weights` supplies another checkpoint. They match for this artifact. A later same-shaped checkpoint could silently use the wrong base. The recorded equivalence check covers just one example, and the mask unit test checks a six-token layout rather than output invariance across shapes.

Correction: save a checkpoint manifest containing base/tokenizer revisions, head configuration, split IDs and hashes, all seeds, selected step, code revision, and artifact SHA-256. Make inference read that manifest and reject a mismatch. Expand architecture tests over branch counts and lengths; measure packing speed against equivalent separate requests before claiming acceleration. The current artifact SHA-256 is `050419120237e05da6b12defeeea18f6df202403fd9aee0438fb65e90ab796ea`.

## A useful interaction: the decision-model inspection bench

The visitor opens a recorded case and sees its utterance, supplied options, gold intent, before/after distributions, and a simple baseline. Selecting "wrong with high confidence" immediately exposes the Apple Pay example above. A task switch shows the binary and score targets, including a visible zero count for middle-level training examples. A checkpoint timeline shows training loss and validation results only; the locked test report remains a separate snapshot.

Next the visitor adds an unrelated sibling question, removes a sibling, or changes option order. With a connected local runtime, the first two operations test branch isolation; option-order changes are a measured robustness intervention, not an assumed invariant. Without the runtime, the page offers only recorded interventions and labels them recorded. Editing the utterance creates an exploratory case with no gold label and never changes benchmark totals. The current artifact offers before/after replay; additional checkpoint replay requires deliberately recorded checkpoints.

State consists of the immutable run manifest, case and stable option IDs, model/checkpoint choice, input edits, branch list, inference status, and comparison result. Code owns dataset selection, packing, limits, scoring, identity checks, and metric computation. The local model owns option probabilities. Jev is an optional separately labeled hosted comparator with independent availability; it never supplies evaluation truth. Runtime absence, overlength text, unsupported option count, duplicate IDs, and provider outage show specific errors while retaining the last valid record.

Acceptance criteria:

- All 77 existing cases replay with exact published targets/distributions and readable source text/options; filtering never changes the reported denominator silently.
- The visitor can explain the 74/77 yes predictions and the absence of middle labels without opening JSON.
- Every inference result identifies checkpoint hash and whether it is recorded or newly computed. Edited cases cannot enter the held-out score.
- Adding/removing unrelated sibling questions stays within 1e-5 absolute probability difference in the declared FP32 runtime on 100 seeded valid requests. Option reorder disagreement is shown, not hidden.
- An absent local runtime needs no API key and leaves the recorded inspector usable. Requests at document/packed limits get clear validation feedback, with no silent truncation.

## Evaluation protocol

### Independent outcomes and baselines

Freeze the official source revision and publish the exact training, validation, calibration, and evaluation IDs before further model changes. Retain the original 308-record training budget for an equal-budget comparison. Reserve 308 validation and 308 calibration records from the remaining official training data, four per class in each partition. Group exact duplicates and known paraphrase families before splitting. The previous 77 test examples have been exposed; report both the official full result and the 3,003 previously uninspected records, without selecting another model on either result.

Run five seeds each for the existing LoRA-plus-head method and a head-only method on the same frozen base and equal examples. Compare them with the original random readout, a training-label prior with a declared tie rule, and a TF-IDF plus logistic-regression classifier trained on the same source records. For four-way evaluation, restrict the lexical classifier's probabilities to exactly the supplied candidates. An optional ordinary SmolLM language-model option-likelihood baseline should be named separately because it uses another readout. Jev is a comparator, not a teacher or judge.

Use accuracy and macro-F1 against the official intent labels; report summed multiclass Brier, log loss, confidence-error rate at 0.9, and accuracy/coverage curves for abstention. Declare the Brier convention since the current two-class score sums both classes. Fit any probability calibration on the calibration partition only. Publish per-seed results and a 95% paired bootstrap over utterance IDs, with 10,000 resamples. Keep all questions and option permutations for one utterance in the same resampling group. Also report the range across training seeds instead of treating repeated predictions as new independent evidence.

For an ordinal claim, first collect an additional task-specific set with independent blinded annotations, including truly adjacent and partly related intents. Reserve 360 unseen utterance/question pairs, 120 at each ordered level; have two raters label and adjudicate disagreements before inference. Keep separate training, development, and calibration partitions and record their sampling. Report ordinal MAE, quadratic-weighted kappa, class recall, Brier, and inter-rater agreement. This is a new annotated evaluation, not an existing external ordinal benchmark. A binary claim needs a separately defined yes/no gold criterion and another 360-case test, 180 positives and 180 negatives, including hard near-neighbor negatives. A three-class target converted back to binary is not another independent task.

Success gates are proposals: choice must beat the strongest equal-budget baseline by at least five percentage points with a positive paired 95% interval; binary must achieve at least 0.70 balanced accuracy and beat the validation-selected prior in Brier; ordinal must achieve macro recall at least 0.60 and MAE at most 0.50, while beating its prior. Report each gate separately, including failures. Select checkpoints using preregistered per-task validation loss and guardrails, never test outcomes. Calibration must improve held-out Brier without lowering retained-case accuracy at the declared coverage.

### Full external coverage and request volume

[PolyAI's official Banking77 repository](https://github.com/PolyAI-LDN/task-specific-datasets#banking) lists 10,003 training examples, 3,080 test examples, and 77 intents. The [original paper](https://arxiv.org/html/2003.04807v1) reports intent-classification accuracy on the standard test set. Its official task is one prediction among all 77 intents; the pilot's four-way shortlist score is a derived evaluation. Current coverage is 77 sampled external utterances with three constructed questions each.

A full 77-way local pass needs 3,080 inference requests per checkpoint. Five seeds times before/after LoRA-plus-head plus head-only evaluation require 46,200 local requests if all three states are evaluated per seed. Priors and lexical baselines need no model service requests. Full coverage for one hosted comparator needs 3,080 logical requests, with actual attempts and retries counted separately. A budgeted policy of at most two attempts per case has a ceiling of 6,160 attempts; unresolved failures remain unavailable. No such run was made in this audit.

The mechanical blocker is the local helper's 32-option cap, `replica_infer.py:41`. Offline tokenizer preflight of all cached test rows found a maximum 83-token document and 592 total tokens for one 77-option question, so the current 160/2,048 token bounds would accommodate this particular split after the option-count contract is extended and tested. Quality at 77 options remains unknown because training used four. No shortlist may use the gold label in the official track. The recorded 23.1 ms median covers small warm packed requests and cannot predict runtime for 77 options.

A separate option-robustness pass can use three distractor seeds and four cyclic orders for every test utterance: 36,960 four-way requests per chosen checkpoint. This is optional and reports derived-task performance only. The observed hosted 429 rate makes an immediate full hosted run impractical until request pacing and quota are settled; full local evaluation needs no paid calls once weights are present.

## Libraries worth using

| Library | Concrete contribution | What this experiment adds |
| --- | --- | --- |
| [scikit-learn](https://scikit-learn.org/stable/modules/calibration.html) | Reuse TF-IDF/logistic regression, confusion matrices, proper scoring functions, and held-out calibration rather than custom summary-only metrics. Its [metric reference](https://scikit-learn.org/stable/modules/model_evaluation.html) covers the classification and ordinal agreement measures. | Link every aggregate to the exact utterances and changing confidence distributions. |
| [PEFT checkpoint support](https://huggingface.co/docs/peft/en/developer_guides/checkpoint) | The runner already uses PEFT. Use its adapter configuration and serialization alongside a separately saved custom readout and a strict run manifest. Preserve the base revision instead of relying on one constant. | Make a small, reproducible local decision artifact inspectable alongside the hosted Jev reference. |
| [Hypothesis](https://hypothesis.readthedocs.io/en/latest/) | Generate branch shapes, request boundaries, and reorderings; shrink packing/isolation failures into small reproducible examples. | Turn a failed property into a visible branch-isolation demonstration with measured differences. |

## Next steps

1. P1, S: publish the collapse counts, priors, Brier convention, and endpoint-only label directly beside the existing metrics. Add complete case text/options to published records.
2. P1, M: build the recorded inspection bench and separate edited cases from the frozen evaluation. Add explicit runtime states before exposing optional local inference.
3. P1, M: freeze splits, save checkpoint metadata and all validation measurements, add head-only/lexical baselines, and extend/test 77-option inference. Run the full independent intent evaluation when compute is authorized.
4. P1, L: collect independently judged intermediate-score cases and a distinct binary task, then train/evaluate five seeds with per-task selection guardrails.
5. P2, M: add bounded hosted comparison recovery and property-based architecture checks. Keep availability, quality, and speed separate.

The same artifacts support a future abstaining local router: let the small model handle only cases above a validation-chosen confidence threshold and route the rest to Jev. Evaluate routing savings and independent intent accuracy on the locked set; do not optimize against agreement with Jev.

## Investigation log

- Read the current catalog, publication map, `Learning` component, provenance enrichment, runner, inference helper, model card, data split functions, and existing mask test.
- Decoded every committed before/after/reference row. `probes/replica.py` independently recomputed all reported accuracies and Brier scores, confusion counts, paired choice changes, reference availability, descriptive intervals, and representative full cases.
- Reconstructed train/validation/test selections from locally cached CSVs after validating their recorded SHA-256 hashes. Verified selected test IDs and targets exactly match the publication, checked exact-text overlaps, and counted replacement-sampled training exposure.
- Loaded only the cached tokenizer with offline mode to check all 3,080 test lengths and the 77-option request size. Did not load model weights or run inference, training, downloads, paid requests, or browser automation.
- Ran `jev-experiments/.venv/bin/python -m pytest jev-experiments/tests/test_contracts.py::test_question_branches_cannot_read_each_other -q`: one test passed. Verified dataset counts, original scoring, and recommended libraries against the primary URLs above.
