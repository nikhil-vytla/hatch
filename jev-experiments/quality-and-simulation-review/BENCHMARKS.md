# Complete benchmark runs

Complete the released held-out split when available. Fix task and scoring mismatches before expanding a run. The counts below are verified by the dedicated audits against primary upstream sources and the committed records. Proposed calls are logical requests or judgments, not dollar estimates.

| Experiment | Current coverage | Complete target | Recommendation |
| --- | --- | --- | --- |
| Intent recognition, BANKING77 | 385 of 3,080 test requests, all 77 labels | 3,080 requests, 40 per intent | Run the complete test split and display the existing trained baseline. Current completed Jev accuracy is 81.56%, baseline 89.09%. |
| Intent recognition, CLINC150 | 300 in-scope plus 100 OOS cases | 4,500 in-scope plus 1,000 OOS test cases | Run all 5,500. Freeze OOS thresholds on validation and report false acceptance and false rejection separately. |
| JudgeBench | 100 response pairs, 200 orientations | 350 GPT plus 270 Claude pairs, 1,240 orientations | Run all 620 pairs with official two-order scoring. Current 77% ordered accuracy becomes 63% official score on the same sample. |
| Decision stability | 40 BANKING77 requests under five conditions, 200 rows | All 3,080 original requests under a frozen transformation matrix | Full coverage is feasible. Preserve matched representations, input hashes and original-case grouping. Five conditions would require 15,400 judgments, but a corrected matrix should add neutral wrappers and distinguish perturbation families. |
| RewardBench 2 | All 1,865 cases and 8,977 answers | Already complete | Keep the run. Add repeated full passes and paired Ties diagnostics. Three fresh passes require 26,931 candidate judgments before retries. |
| Decision models on a Mac | All 400 released Typed Decisions test cases, five questions each | Already complete for that release | More test coverage is not the current gap. Improve training/evaluation controls and inspect per-workflow errors; the source is synthetic-teacher supervision. |

The two classification test sets require 8,580 decisions total, compared with the existing 785. Completing only the missing cases requires 7,795 more under an unchanged protocol. A changed schema, option description, model contract, or calibration policy needs a fresh versioned full run rather than mixing old and new results. JudgeBench similarly needs a fresh run if its question formulation changes; rescoring the existing sample with the official rule needs no model calls.

The [Vercel model page](https://vercel.com/ai-gateway/models/jev), checked September 20, 2026, advertises free promotional pricing through September 25, 2026 and a 32K context. That supports ambitious coverage now. It is not a permanent price promise or evidence that old zero-valued cost fields reflect billing. Record actual usage, completion, attempts and dates. API availability and context fit are operational checks, not reasons to silently shrink a benchmark.

## Scoring and disclosure

For JudgeBench, a source pair is correct only when both answer orientations are correct. Keep ordered accuracy as a diagnostic, and show the 28 currently inconsistent pairs. Full upstream data includes repeated source questions across response-model splits, so uncertainty should group those dependencies. The [official runner and scoring implementation](https://github.com/ScalerLab/JudgeBench/blob/main/run_judge.py) define the protocol.

For RewardBench 2, retain the official six-category macro. Its 51 Ties pairs need paired margin diagnostics. Seven pairs currently pass ordinary ranking checks while failing the paired margin condition, so the current mistakes filter misses them. Full evaluation coverage does not mean every public text field is displayed: reviewed omissions remain explicit and hashed. See the [pinned dataset card](https://huggingface.co/datasets/allenai/reward-bench-2/raw/7ff08853b0d5686e79b13fda8677024f566a104a/README.md) and [pinned scoring functions](https://github.com/allenai/reward-bench/blob/05a9005efb607249822c193590c8ecab87c77052/rewardbench/utils.py#L1033).

For BANKING77 and CLINC150, preserve their distinct tasks and denominators. Classification accuracy over 77 intents and OOS rejection over 151 choices are different questions. Give users the complete request, intended label, predicted label, source ID, baseline result, and option definitions. Verify splits against [BANKING77](https://github.com/PolyAI-LDN/task-specific-datasets#banking) and [CLINC150](https://github.com/clinc/oos-eval#1-what-are-the-relevant-files).

## Authored and training experiments

A complete authored fixture set is useful for integration coverage. It is not an external benchmark. Drink finder currently omits eight of sixteen fully specified preference combinations. Enumerating all 81 partial states is cheap and exposes no-match and clarification behavior before adding independently written language.

Music has eight original briefs, with three transient provider failures left unresolved. Complete those after deciding which protocol is being preserved. Recovering them does not establish musical quality. A shared score, contextual phrase candidates and independent listening evaluation address the actual question.

Prompt evolution, active labeling, reward training and the small-model replica need separate training, selection and held-out evaluation. Their dedicated reports specify the relevant split and controls. A full test split can improve precision, but it cannot repair label leakage, an inappropriate baseline, a collapsed task, or repeated test-based selection.

## A complete-run publication contract

1. Freeze source revision, full case IDs, split, prompt/schema, model identity and scoring code before recording.
2. Preflight context and option counts. A too-large case gets an explicit unsupported status or a separately named protocol, never silent truncation.
3. Checkpoint every success. Retry transient failures with attempt history; do not replace a successful wrong answer to improve the score.
4. Preserve case identity through shuffles, retries, repeat runs and source deduplication.
5. Publish official scores, coverage and service availability separately. Report all selected cases, including failures.
6. Show readable complete evidence or explicit reviewed omissions. Keep full downloads while loading the on-screen case separately.
7. Compare methods on identical cases and report paired differences, source/case-cluster uncertainty and repeat-run variation.
