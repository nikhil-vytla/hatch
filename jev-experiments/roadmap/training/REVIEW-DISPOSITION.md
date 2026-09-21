# Protocol review disposition

Fable findings were resolved before fitting. The earlier feature cache was discarded and the corpus was frozen again after these amendments.

| Finding | Disposition and evidence |
| --- | --- |
| 1, content leakage | Added semantic-task hashes and deterministic exclusion of lower-priority splits. The frozen selection has zero exact cross-split task matches. Repeated passages alone are not identical BoolQ tasks; STS-B sentence order does not affect duplicate identity. This check does not detect paraphrases or unknown upstream pretraining. |
| 2, SummEval length | Fluency input contains only the system summary. Source-document hash and reference count stay in provenance. Required source fields now fail loudly. Full text is never truncated. |
| 3, unseen priors | Uniform fallback for any unseen choice value and for ordinal scales other than 0..5. Per-row outputs record the applied rule. |
| 4, candidate forms | Both exact forms and all instruction paraphrases are recorded in the manifest. |
| 5, choice key identity | Lowercasing applies only to boolean values. Choice IDs preserve case. |
| 6, model provenance | Published backbone contamination is distinct from new readout train/test separation. Unknown exposure is disclosed; known dataset overlap is recorded in the provenance table. Merely seeing training examples does not establish test leakage. |
| 7, complete exports | The conversion bridge takes token IDs/masks, includes all frozen backbone tensors and readout, and returns final probabilities. Both CPU_ONLY and ALL are required for the gate. Model input/output specifications, tensor counts, hashes and a fixed validation timing ID are recorded. |
| 8, adapter limits | Mac runtime declares and enforces 32 questions, eight options, 768 tokens, 64 KiB state and 128 KiB request limits before inference. |
| 9, validation reuse | Explicitly disclosed in the protocol. No held-out or transfer metrics select configurations or default. |
| 10, scope | Every result is described as a readout adapted on three datasets; candidate-selection/ordinal derivatives retain their labels. |

The review's statement that no manifest existed described its earlier snapshot. The completed preparation and source manifests are separate evidence and were rerun after review.

## Independent evidence review

The CPU-only [review and reproduced fixtures](../playable/review/training/README.md) verified all 27 saved seed/split metric aggregates, row alignment, split hashes and validation minima. Four implementation findings were accepted.

- Release auditing now checks metric structure, exact split counts, expected seeds, complete compute comparisons, selected validation minima, corpus/model revisions and input provenance. Publication rejects stale or malformed training evidence. Empty placeholder objects cannot pass.
- When no dataset has a supported prediction, macro NLL is unavailable, represented by JSON null. It is never reported as zero. All current model rows have coverage 1, so this correction changes no measured score or selection.
- The frozen ECE implementation measures top-label confidence against membership in the soft-gold argmax set. It does not measure calibration against the full soft distribution. For example, prediction and gold `[0.5, 0.5]` have ECE 0.5 under that hard correctness definition, despite Brier error zero. The definition is now explicit in publication metadata; no ECE values were rescored and the frozen protocol bytes remain unchanged.
- Core ML warm/cold prediction timings cover `model.predict` on prepared token-ID/mask tensors. They exclude tokenization and input compilation. MLX robustness timings include preparation, so they are reported as separate timing conditions. This annotation changes no recorded timing.

The evidence review also prompted fresh three-kind batch checks, four validation rows per kind across all three seeds, and input provenance on future robustness/baseline/export runs. A retrospective provenance verification is explicitly labeled when applied to the already-running Laya export; its saved package metadata and all artifact hashes must match before the link is recorded.

The [default-package review](../playable/review/default-promotion/README.md) found two additional release-path defects before any default promotion. Installer diagnostics now have a runtime-only mode, so installing the toolkit succeeds before the selected model files exist. The package test supplies the proposed registry to the installer from the start. Package verification and promotion bind the runtime, original MLX helper, installer, inference requirements, bundled readout and authored first-action fixture through a shipped-source manifest. Independent CPU probes verified that an edited helper prevents promotion and that a selected default with no downloaded model does not break runtime-only diagnostics. These fixtures are separate from the required actual fresh package test.

One protocol sentence, “No official test labels are needed or inferred,” was too broad. Held-out scoring uses the labels publicly released in the pinned source files, including BANKING77 and STS-B test labels. No hidden benchmark-server labels are inferred or obtained. The per-dataset split descriptions, selected row manifests and actual preparation code were already explicit; this wording clarification changes no rows, scores, selection or frozen protocol bytes.
