# When should an email specialist answer locally?

- Owner: training/runtime, with root/design engineering
- Stage: next wave; extend the [richer email workflow decision](../../roadmap/decisions/email-workflows.md)
- Status: proposed experiment; data, protocol and implementation not frozen
- Source: [Andrew Prifer's Jimothy, pinned review](../jimothy-analysis.md)
- Dependencies: redistributable labeled inputs; task-hash runtime adapter; browser worker and asset lifecycle; explicit review policy; measured-runtime calibration; installation/export integrity

## Decision

Investigate a fixed-task local classifier through **an email review tray**. The visitor first opens an authored example and runs its local prediction, then sees the predicted purpose, probability distribution, evidence condition and either an accepted suggestion or a review request. Optional hosted comparison is a separate user action. Explicit `.eml` import can follow once parsing is supported; this experiment does not access or modify a mailbox.

Use the existing `action_required`, `transactional`, `newsletter`, `personal`, and `uncertain` labels with frozen descriptions. `uncertain` is a semantic label; operational abstention is a separate status. Export a versioned model/evaluation manifest and a local decision record containing task/model hashes, runtime identity, full distribution, chosen label, policy result, coverage reason and timing. Corrections enter a separate draft dataset; they never silently update the installed model or published results.

## Proposed bounded protocol

1. Build 1,000 short, redistributable, human-reviewed examples with stable IDs and explicit source rights. Target 200 per label for this controlled comparison; do not call that a representative mailbox distribution. Keep paraphrases, templates and related threads in one group. Add 100 separate challenge cases for long inputs, malformed MIME, quoted instructions, ambiguity and unsupported languages; describe their expected status before execution. Do not upload private examples to a teacher by default.
2. Freeze 500 fitting, 300 development and 200 final-test rows by group before teacher labeling or fitting. Freeze content hashes, duplicate exclusions and split IDs. Within development, use Jimothy's grouped stratification for separate tuning, calibration and acceptance subsets; record exact counts. Predefine seeds 11, 23 and 42 for these partitions, keep the outer test fixed, and report every repeat. Jimothy's head fitting is deterministic; these seeds measure partition sensitivity, not random weight initialization.
3. Compare class priors, frozen lexical rules, Jimothy TF-IDF and frozen-MiniLM heads. For both fitted backends, compare human hard targets against Jev soft targets on the same fitting inputs. Human targets govern development and final correctness; teacher agreement is secondary. Include unchanged hosted Jev and the existing installed local readout as separately identified references on exactly the same supported task. Neither changes the completed study or default selection.
4. Bound each fit to the pinned five-value regularization grid and 200 epochs per candidate. Keep task text fixed. Use tuning only to select heads, calibration only to fit temperature and acceptance data only to choose the advisory cutoff. Propose a 90% lower-bound correctness target using the existing corrected threshold procedure; retain null when no cutoff qualifies. Freeze any runtime-specific policy before opening test results. A small acceptance subset may support no useful coverage.
5. Evaluate the selected bundles in Node and browser q8 WASM using singleton and fixed batch sizes 8 and 32, with deterministic order permutations. Report full decision-level label/probability differences and acceptance changes. FP16 WebGPU is deferred until a separate calibration condition is justified. Overlong or unsupported rows remain in attempted denominators with explicit reasons; never trim them into apparent successes.

## Outcomes and acceptance

Primary outcomes are final human accuracy and accepted coverage under the frozen policy. Report accepted accuracy with interval and denominator, per-class recall, macro-F1, Brier/log loss against human labels, teacher agreement separately, and unsupported/error/abstention rates. Use paired group-resampled intervals for method differences; show all seeds and avoid treating repeated predictions of one email as independent emails. A high maximum probability alone is not a quality guarantee.

Measure network bytes, cold asset loading, first inference, warm p50/p95, memory, complete training and labeling costs, and total time to the first useful result. Include retries, failures, evaluator overhead and missing usage. Break-even volume is a labeled scenario based on measured costs, not a saving already achieved. Show local fallback identity and reject unmatched tasks; there is no automatic cloud fallback.

Release the experience only after fresh browser loading, checksum failure, offline-after-cache, stale-result cancellation, disposal, file parsing, keyboard/touch and mobile checks pass. Low coverage or negative quality findings can ship if the interaction and evidence are honest. This research adds no mailbox action, public catalog entry or default promotion. Implementation tasks belong in the root-owned checklist after protocol review.
