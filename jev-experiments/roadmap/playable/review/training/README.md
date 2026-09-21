# Independent training and evidence audit

The recorded training metrics reproduce exactly. The release checker and publisher now reject the stale and incomplete evidence fixtures found in this review. This review used only Python's standard library, frozen JSONL records and temporary fixtures. It did not run a model, download data, import MLX or use the GPU.

Results and pending work below describe the saved review run, not the current release state. The [release status](../../../training/release-status.json) tracks later evidence, and the [default-promotion review](../default-promotion/README.md) covers the subsequent package boundary.

## Findings

| ID | Priority | Finding and evidence | Disposition |
| --- | --- | --- | --- |
| T1 | High | `audit_release.py` and `publish.py` accepted stale corpus/revision metadata, a wrong export model/seed, empty comparison objects, an empty baseline and fake robustness seeds. The resulting public artifact claimed `researchEvidenceComplete: true`. [Before probe](probe-results-before.json) retains the result; the real current release remained blocked. | Fixed and independently rechecked. Structure/provenance checks reject the fixture, the selection CLI rejects wrong identities, and publishing recomputes release status inline so stale completion flags cannot carry forward. See the [after probe](probe-results-after.json). |
| T2 | Medium | `grouped_metrics` returned `macroNll: 0.0` when every row was unsupported. Zero is also the best achievable NLL and can misleadingly appear as a measured score. Every current model has full coverage, so this did not change the recorded selections. | Fixed and independently rechecked. The unavailable metric is `null`; the selection helper rejects unavailable NLL. |
| T3 | Medium | The `ece` calculation uses hard agreement with the soft gold's argmax set. A prediction exactly equal to gold `[0.5, 0.5]` gets ECE `0.5`, although its Brier error and ordinal error are zero. This is calibration against an argmax-agreement event, not calibration against the target distribution. | Fixed by explicit `metricDefinitions.ece` in the publication. Frozen metric numbers and protocol bytes remain unchanged. Root is also labeling the public UI. |
| T4 | Medium | Core ML's warm timer surrounds only `model.predict(timing_data)` after tokenization/packing. MLX's warm timer includes tokenization, packing and the complete decision. Identical field names obscure different measurement boundaries. | The exporter now records the boundary explicitly. An annotation for the then-active export was pending at this review's completion; no new end-to-end Core ML measurement is claimed here. |

T1 is a gate defect, not evidence that the existing metric values are wrong. Export failure and a negative model result can be valid research evidence when the attempted work and its limits are recorded. This audit does not require a positive result or change validation-only selection rules.

## Independent checks

- Whole-corpus hashes and source-manifest hash match the frozen manifest. Counts are 768 training, 192 validation, 384 held-out and 2,384 transfer decisions.
- All 400 Typed Decisions cases and their 2,000 questions are retained. No exact task overlap across selected splits or malformed gold distribution was found.
- All 27 prediction aggregates across three models, three seeds and three evaluation splits reproduce with maximum numeric difference `0`. Predictions align with the full frozen rows, including targets and semantic option identities.
- All three recipe choices and all nine temperature choices match the minimum recorded validation NLL. This check confirms the code and recorded candidate table; it cannot prove an absence of unrecorded prior experimentation.
- The reviewed training result protocol, corpus and model revision fields match the frozen artifacts. Default selection was `null` at this checkpoint.
- Eight provider-free study/selection unit tests pass, including invariance to held-out test scores/global export pass flags and rejection of incomplete validation evidence.
- All ten Mac toolkit provider-free tests also pass. No installation or inference was performed in this recheck.
- The selection CLI rejects a wrong-model export with missing provenance even when its numeric validation fields would qualify for the pure ranking helper.

The code review found validation-only recipe and temperature selection. Core ML uses validation parity for default eligibility and separates held-out comparison results. Fresh provenance-linked robustness and baseline runs were pending at this checkpoint, and their gates correctly reported incomplete. Active Core ML numerical repair belonged to the training owner and was deliberately excluded from this review.

## Reproduce

From the repository root:

```sh
python3 jev-experiments/roadmap/playable/review/training/probes.py probe-results-after.json
```

The saved-prediction checks require the existing ignored study cache. The release/publication probe runs the real scripts against temporary copies of Jev's own JSON reports; it never alters production evidence. The script records hashes of reviewed source files so later changes can be distinguished from this run. The [partial-fix result](probe-results-partial-fix.json) retains the stale-publication issue found before the final inline-audit correction.

See the [study protocol](../../../training/PROTOCOL.md), [probe code](probes.py) and [notes](NOTES.md).
