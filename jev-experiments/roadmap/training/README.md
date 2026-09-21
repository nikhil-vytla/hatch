# Typed readout study

This study adapts small typed readouts on three datasets while keeping the Laya, SmolLM2-360M-Instruct and Qwen3-0.6B backbones frozen. It is separate from the earlier workflow specialist. All three candidates completed the frozen three-seed training recipe, full Core ML graph comparisons, baselines and robustness checks. Validation selected the experimental Laya seed17 readout; its fresh installation passed the offline first-action check before promotion. The [protocol](PROTOCOL.md) and immutable source/corpus manifests were frozen before fitting. The [review disposition](REVIEW-DISPOSITION.md) records subsequent checks and corrections; the [provenance table](PROVENANCE.md) discloses known and unknown upstream exposure.

The corpus contains 768 adaptation examples, 192 validation examples, 384 held-out decisions and 2,384 transfer decisions. Transfer includes every question from all 400 released Typed Decisions cases. Exact task-content checks found zero cross-split matches in the chosen corpus. Candidate-selection BANKING77/CLINC tasks, STS-B ordinal targets and MultiRC answer validation are explicitly labeled derivatives. SummEval fluency receives only system summaries, with source-document hashes retained for provenance. Inputs beyond 768 tokens remain unsupported rows in coverage totals; they are never truncated.

Evaluation uses labels publicly released in the pinned source files, including released test labels where available. Hidden benchmark-server labels are neither inferred nor obtained; the review disposition clarifies an overbroad sentence in the frozen protocol.

Readout selection uses only macro validation negative log likelihood, two learning rates, checkpoints after epochs one and three, three seeds and validation temperature fitting. The same validation sample is reused for these decisions and default selection. Public benchmark exposure in the published backbones is not ruled out; the upstream Laya repository specifically documents BoolQ in its training mix. Neither exact split separation nor the 400-case transfer evaluation establishes general-purpose capability.

Run the study with the existing Apple Silicon environment, or install `requirements-training.txt` in a separate environment:

```sh
PYTHON=jev-experiments/.venv/bin/python
"$PYTHON" jev-experiments/roadmap/training/download_models.py
"$PYTHON" jev-experiments/roadmap/training/prepare.py
"$PYTHON" jev-experiments/roadmap/training/study.py baselines
"$PYTHON" jev-experiments/roadmap/training/study.py extract --model laya
"$PYTHON" jev-experiments/roadmap/training/study.py fit --model laya
"$PYTHON" jev-experiments/roadmap/training/study.py frozen-baselines --model laya
"$PYTHON" jev-experiments/roadmap/training/robustness.py --model laya
"$PYTHON" jev-experiments/roadmap/training/export_coreml.py --model laya --seed 17 --precision float32
"$PYTHON" jev-experiments/roadmap/training/verify_export_provenance.py --model laya
"$PYTHON" jev-experiments/roadmap/training/measure_export_runtime.py --model laya
"$PYTHON" jev-experiments/roadmap/training/export_decision_rows.py --model laya
```

Repeat the model commands for `smol` and `qwen`. `download_models.py` populates the pinned local cache layout shared with the earlier Apple study; existing mismatched files are rejected, and `--verify-only` forbids downloads. [models-manifest.json](models-manifest.json) records every used file checksum. Corpus preparation downloads only revision-pinned dataset files into `jev-experiments/.cache/typed-study-v1`. Model weights, features and full source-text predictions stay in the ignored cache. Committed files contain new code, protocols, hashes, small learned readouts and evidence with source text omitted.

After all three models have complete evidence, the default and package checks are separate steps:

```sh
"$PYTHON" jev-experiments/roadmap/training/publish.py
"$PYTHON" jev-experiments/roadmap/training/select_default.py
"$PYTHON" jev-experiments/roadmap/mac/verify_default_package.py --model-source /path/to/verified/laya-readout-experimental
"$PYTHON" jev-experiments/roadmap/training/promote_default.py
"$PYTHON" jev-experiments/roadmap/training/publish.py
```

The selector uses the predefined seed17 export's validation metrics, never the best repeated seed or test scores. Package verification installs the proposed registry into a fresh toolkit, rechecks the previously downloaded model files in an empty model directory, verifies the installed source bytes and credits, and runs the authored first-action example with networking blocked. Promotion refuses changed sources or evidence. Selection alone never changes the installed default; the package path currently supports the Laya readout candidate.

The Core ML bridge contains the full frozen backbone, typed readout and calibration. Its inputs are token IDs and masks, and its output is the final probability vector. It records parameter counts, input/output shapes, artifact hashes and complete decision comparisons for CPU_ONLY and ALL. `--limit N` is an explicit pilot that cannot satisfy the export gate. A failed bridge or export records failure evidence instead of claiming success. Device placement is not inferred from ALL.

Each compute condition compared all 2,960 supported validation, held-out and transfer decisions. Six public JSONL files retain all 17,760 pairs of MLX/Core ML probabilities and semantic option IDs without source passages, prompts or gold distributions. Hashes and links are recorded in the export reports.

| Complete seed17 graph | CPU argmax agreement | ALL argmax agreement | Maximum probability delta, CPU / ALL |
| --- | --- | --- | --- |
| [Laya](export-laya-17.json) | 99.966% | 99.966% | 1.82e-5 / 2.29e-5 |
| [SmolLM2](export-smol-17.json) | 100% | 100% | 5.69e-6 / 4.08e-6 |
| [Qwen3](export-qwen-17.json) | 100% | 100% | 1.94e-5 / 3.08e-5 |

All three have 100% validation argmax agreement. The [default-selection record](default-selection.json) uses validation NLL 0.8843 for Laya, 1.0972 for Qwen and 1.5150 for Smol; no held-out score chooses the model. The [fresh package record](../mac/default-package-verification.json) verifies the selected registry, installed sources and credits, rehashed model files, diagnostics and correct boolean/choice answers with socket connections blocked. These are the study and local-runtime gates; broader application release checks are tracked separately in the roadmap.

Ten provider-free study/selection checks cover ordinal mapping, probability metrics/coverage, candidate gold identity, state-blind priors, complete transfer inclusion, validation-only default selection and source-text-free comparison exports:

```sh
python3 -m unittest discover -s jev-experiments/roadmap/training -p 'test_*.py'
```

Current baseline evidence is in [baseline-results.json](baseline-results.json). The state-blind and lexical conditions have held-out macro NLL 1.5402 and 1.4001 respectively. Model-specific results, when present, explicitly distinguish trained readouts, exports, robustness checks and release gates.

Laya held-out derivative macro NLL is 0.9267–0.9284 across three seeds, and Qwen spans 1.1775–1.2070. SmolLM2 is weaker at 1.5183–1.5255, compared with the lexical baseline at 1.4001. Reversing options changes many causal-readout answers: agreement spans 4.2%–21.9% for SmolLM2 and 45.6%–46.1% for Qwen. Laya spans 67.7%–94.5%, so its ordering weakness also matters. These are measured results on frozen derivative tasks, with known/unknown upstream exposure disclosed. Compact UI data is generated in [publication.json](publication.json); [release-status.json](release-status.json) derives completion and installation gates from current evidence. Newly trained readouts are retained in [checkpoints/manifest.json](checkpoints/manifest.json), each below 100 KB.

A post-freeze [metric implementation correction](metric-correction.json) removes first-position bias when soft-gold probabilities tie. The record preserves before/after Laya accuracy and ECE on the same hashed prediction files. NLL and every recipe/calibration selection remain unchanged; the frozen protocol file was not rewritten.

ECE measures top-label confidence against soft-gold argmax-set agreement, rather than full-distribution calibration. Brier error compares the full probability vectors. Core ML prediction timing starts from prepared tensors; MLX timing includes tokenization. Fresh Core ML process timings and memory are recorded separately from the process that converts and compares the model. Float16 Laya exports returned invalid probabilities on validation inputs; those failures remain in `export-attempts`, and the complete float32 condition is evaluated explicitly.

Native MLX evaluation casts floating model parameters to float32. Qwen retains its pinned four-bit packed weights with float32 scales and biases; its Core ML graph expands those weights to dense float32. Core ML inputs are padded to 768 tokens, while MLX runs the actual input length. These conditions must accompany any latency or memory comparison. The frozen protocol's opening status describes the pre-fit snapshot; current completion and installation status comes from `release-status.json`.
