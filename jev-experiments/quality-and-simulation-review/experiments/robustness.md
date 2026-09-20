# Decision stability audit

Verdict: repair. The saved requests support a useful paired experiment, but the app currently presents it as a classification gallery. Reversing options changes three decisions while leaving accuracy at 80%. That is the result this experiment should make visible.

## Current purpose and boundary

Jev chooses one of 77 named BANKING77 intents from an utterance. Deterministic code selects 40 source cases with seed 42, makes five variants, reverses the criteria map where requested, shuffles the 200 requests with seed 99, and compares outputs to dataset labels. The five conditions are original, identical repeat, reversed options, a structured state with repeated irrelevant prose, and a structured state containing an instruction to choose `card_arrival`. Jev generates neither the cases nor their labels. See `src/jev_lab/benchmarks.py:169` and `src/jev_lab/data.py:88`, relative to `jev-experiments/`.

The catalog calls this "Decision stability" and asks which changes alter an answer. The React component instead browses individual rows in their shuffled order, with All results/Mistakes filters, a prediction-versus-target comparison, and the six largest model probabilities. Its headline is pooled accuracy, 164/200 or 82%, plus 200/200 returned answers. It does not group the five variants or show any stability statistic. See `experience-prototypes/src/catalog.ts:205`, `src/benchmarks.tsx:25`, `:128`, `:265`, and `:309`. This review inspected source and records, not a browser session.

## What already works

- All 200 public rows contain the complete tested state and original utterance. A read-only check against the local request logs matched every state. All 40 original/repeat request bodies are identical, and all 40 reversed criteria maps are exact reversals. The probe is `quality-and-simulation-review/probes/robustness.py`; its measured output is `probes/robustness-results.json`.
- Labels are stable intent names rather than option positions. Reversal changes insertion order without changing intent descriptions. `src/jev_lab/core.py:45` also preserves key order in its request hash.
- Recovery is sound for this record. Twenty-three initial transport failures were eventually completed; all 177 initially completed predictions and probability maps remain unchanged. The retry policy only accepts transient transport errors, and retains the original error plus recovery attempts. See `experience-prototypes/scripts/recover.ts:31` and `:62`. The 25 further unavailable recovery attempts are availability evidence, not extra test cases or wrong judgments.
- The UI explains that unanswered calls differ from wrong answers and that probabilities are model outputs. Dataset provenance links to the pinned PolyAI source and explicitly describes authored interventions. See `experience-prototypes/src/benchmarks.tsx:275`, `:322`, and `scripts/provenance.ts:16`.

## Findings

### P1: pooled accuracy conceals the main result

`experience-prototypes/scripts/metrics.py:26` computes ordinary classification metrics over all 200 rows. The UI reads this aggregate in `src/benchmarks.tsx:39`. It reports 200 cases even though there are 40 independent source utterances and five conditions each. It never computes paired disagreement.

The reconstructed results are:

| Condition | Correct | Changed label vs original | Correct to wrong | Wrong to correct | Mean probability total variation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | 32/40 | reference | reference | reference | reference |
| Identical repeat | 32/40 | 0/40 | 0 | 0 | 0.008875 |
| Reversed choices | 32/40 | 3/40 | 0 | 0 | 0.059625 |
| Distractor | 34/40 | 2/40 | 0 | 2 | 0.037500 |
| Quoted injection | 34/40 | 3/40 | 0 | 2 | 0.046125 |

For example, `banking77/test/1342` says "I tried to top up using my card, but now the money just disappeared!" The dataset label is `topping_up_by_card`. Jev changes from `top_up_failed` to `top_up_reverted` under reversal. Both answers are wrong, so an accuracy difference hides the flip completely.

Replace the pooled headline with a paired transition matrix and labels such as "40 utterances, 200 completed evaluations." Show same-and-correct, same-and-wrong, corrected, newly wrong, and changed-between-wrong-labels. Compute probability distances after aligning by label. Do not treat 200 representations as 200 independent observations when forming intervals.

### P1: coverage is too small for the broad title

`src/jev_lab/benchmarks.py:171` takes only 40 cases after selecting one per intent and shuffling. This covers 40 of 77 intents and 1.30% of the full test split. The [official PolyAI repository](https://github.com/PolyAI-LDN/task-specific-datasets#banking) specifies 3,080 test cases, 10,003 training cases, and 77 intents. The pinned local CSV confirms 40 test cases per intent. The [original paper](https://aclanthology.org/2020.nlp4convai-1.5.pdf) uses classification accuracy as its main score.

Zero observed repeat flips among 40 cases does not establish repeatability. A descriptive Wilson 95% interval is 0% to 8.76%; the reversal flip interval is approximately 2.58% to 19.86%. Those intervals describe sampling uncertainty under an independent-case approximation, not unobserved provider drift or all possible prompts.

Run the full 3,080-case split for the fixed condition matrix. Keep broader authored challenges separately labeled. There is no finite "full robustness benchmark" here: the source dataset is external, but these perturbations are our own protocol, and enumerating all 77! option permutations is neither necessary nor meaningful.

### P1: distractor effects are confounded with changing the state format

The original is a plain string. The distractor changes it to a JSON object containing `background` and `customer_message`, then adds the same chair/bookshelf sentence 30 times. The injection also changes it to JSON. There is no clean JSON-only condition. See `src/jev_lab/benchmarks.py:182`.

Consequently, the observed two extra correct distractor judgments cannot be attributed to irrelevant context. The model may benefit from the explicit `customer_message` field, the wrapper, the length, or another interaction. Add matched clean wrappers, compare background positions independently, and vary realistic material such as receipt details, an email signature, or an unrelated support thread. Keep one factor per basic condition. Add a separate combined-stress track after measuring individual effects.

### P1: one obvious footer does not establish injection resistance

The sole attack text instructs the model to ignore the customer and choose `card_arrival`. It is always explicitly named `untrusted_footer`; no source case in the sample has `card_arrival` as its true label. No attack output chooses the requested target, although three judgments change. See `src/jev_lab/benchmarks.py:189` and the probe output.

That supports a narrow result: this footer produced 0/40 target captures in this sample. It does not test instructions hidden in the customer message, claimed administrator authority, task-aligned misleading examples, or competing intent labels. Replace the single footer with a declared threat model and three frozen templates. Choose a deterministic wrong target for each case and score target capture separately from any answer change and loss of task accuracy. Include benign quoted imperative text so that a system which ignores every imperative is not rewarded blindly. Use a matched clean wrapper. Keep adversarial and meaning-preserving results separate, as the current saved note correctly requests.

### P2: the visitor cannot inspect what changed without doing the pairing manually

The gallery exposes individual full rows, but reversal leaves the displayed request unchanged. Public rows contain no question payload or input criteria array, and output probability key order does not reliably reproduce input order. The visitor must search source code to understand the operation. Filtering "Mistakes" also removes a correct member of a before/after pair, breaking the comparison. See `experience-prototypes/src/benchmarks.tsx:29`, `:127`, `:245`; the probe confirms 0/200 public rows contain a `questions` payload.

Publish exact question instructions, an ordered criteria array, original request hash, transform version, and canonical case ID. A case card should retain both sides when filtering for flips or regressions. Render the original and transformed states, full ordered options, and changed spans together. Keep the full 77-label distribution available beyond the top-six summary.

### P2: one repeat and rounded probabilities leave the stability question partly open

Original and repeat predictions match in all 40 cases, but 17/40 probability maps differ. Reversal changes a distribution by as much as 0.45 total variation. Model `confidence` also differs from chosen-label probability in 90/200 rows; these fields should not be substituted for one another. The saved classification calibration code correctly uses the chosen-label probability, `src/jev_lab/metrics.py:23`.

Add repeated measurements across declared time blocks, preserve the returned model identifier when supplied, and store the provider's precision unchanged. Show decision disagreement and distribution drift separately. Record per-attempt service time separately from logical latency including retries; the current original transport summary and later recovered rows belong to different observation periods. Do not attribute availability fluctuations or probability rounding to semantic sensitivity.

## Proposed interaction: a counterfactual stability desk

A visitor opens one real banking request. The left pane pins the complete original request and expected intent. A central control chooses "repeat exactly," "reverse choices," "wrap as JSON," "add an email signature," or "insert an untrusted instruction." The right pane shows the exact transformed input with added spans highlighted. A visible ordered option rail animates reordering while stable intent IDs remain attached to each entry.

The visitor can predict "same intent" or "different intent," then reveal the recorded result. Two probability distributions animate on the same scale, with one sentence explaining the transition: "The answer changed, but both choices were wrong." A separate control chooses a reviewed meaning-changing pair, such as an account action being completed versus requested, so that appropriate changes are also rewarded. The visitor can explore their own text using the existing in-memory visitor key, clearly labeled as an exploratory run with no dataset label.

Jev only returns the intent and distribution for an exact request snapshot. Code applies declared transforms, schedules calls, matches labels, computes metrics, displays motion, and retains provenance. A model output is never used to declare that a transform preserves meaning. Human-reviewed challenge labels and external dataset labels supply the independent outcomes.

If one side is unavailable, keep the finished side and show a pending/failed partner instead of manufacturing a disagreement. Retry only transient transport failures, retain all attempts, and stop auth or malformed responses. Resetting or editing cancels the active comparison or discards stale responses using a request-version guard. No owner key fallback.

Acceptance criteria:

- Every recorded comparison shows both complete input states, instructions, ordered choices, expected relation, and source link without a raw JSON download.
- Filters for corrected, regressed, stable-wrong, and label-flipped keep the complete pair together.
- Recorded seed, transform version, request hash, model identity when available, and attempt history reproduce each result.
- A 3/40 reversed-label flip rate remains visible even if both arms have equal accuracy.
- Unavailable partners are excluded from paired semantic metrics and counted separately in completion coverage.
- Keyboard controls and reduced-motion settings work; animation shows an actual change in stored data.

## Evaluation protocol and full-run feasibility

Use the pinned BANKING77 revision `57ec275d8078af65b7731c2a98be812d844a6d6b`. Run all 3,080 test cases with the same 77 options. Primary external score is correct intent count divided by 3,080 for a fully completed clean run. While a run is incomplete, show answered accuracy and completed/planned separately, and label the full score provisional. Supplement with all-label macro recall and per-intent counts; do not call the challenge matrix an official BANKING77 score.

Freeze this five-condition basic matrix before running: plain original, exact repeat, exact reverse order, clean JSON wrapper, and that same JSON wrapper plus neutral context. It requires 15,400 logical requests. Add three frozen injection templates on all 3,080 cases, using the existing clean-wrapper baseline, for 9,240 more requests. The full fixed protocol therefore takes 24,640 logical requests before retries. It is feasible with current data and API support; real blockers are clean resumability, enough sustained provider capacity, complete request manifests, and finishing the matched-control design. No training, human judge calls, or large downloads are required. Do not batch unrelated states together merely to reduce requests, since that changes the experiment.

For higher-dimensional stress tests, preselect ten cases per intent, 770 total, before looking at outcomes. Four seeded random permutations add 3,080 requests. Three further identical repeats add 2,310, yielding five identical draws including original and exact-repeat. The seeds control case selection, ordering, and schedules, not provider sampling. An additional 154 human-reviewed meaning-changing pairs require 308 requests. Total with these declared extensions is 30,338, excluding retries. Label those extensions as sampled challenge matrices, not full external benchmark coverage.

Baselines should include the existing TF-IDF logistic classifier fitted only on training data, a constant-intent classifier which demonstrates why invariance alone is insufficient, and the same Jev request with deterministic format canonicalization. Compare the canonicalizer on transformations whose changes it is allowed to undo; do not let it read the correct label or silently strip semantically relevant text.

Report clean accuracy, paired flip rate, correct-to-wrong rate, wrong-to-correct rate, stable-wrong rate, total variation of canonical-label distributions, attack target capture, and whether reviewed meaning changes produce the expected target. Record Brier score and reliability by condition using the same probability field. Bootstrap whole source cases, preserving all variants and repeats together, stratified by intent; use 10,000 seeded replicates for paired differences. Report time-block variation alongside sampling intervals. Predictions must remain immutable after completion. Selection or tuning uses training/validation data; test results cannot choose which perturbations are included in the headline.

A proposed release criterion for a protective canonicalizer is no more than one percentage point loss of clean accuracy, with the paired 95% interval reported, plus at least a 50% reduction in meaning-preserving label flips relative to the unchanged request path. Require no drop in reviewed meaning-change accuracy beyond the same one-point tolerance. These are prospective targets, not findings. The underlying study should still publish results if the method fails them.

## Libraries worth reusing

- [CheckList](https://github.com/marcotcr/checklist) supplies minimum-functionality, invariance, directional, and paired expectation test concepts. Use its template and perturbation tools offline to create reviewed suites, then publish ordinary JSONL rather than transplanting its notebook widget. Jev adds a cheap typed decision endpoint and interactive results for those tests.
- [fast-check](https://fast-check.dev/docs/introduction/) supplies seeded property generation and failure shrinking in TypeScript. Use it to test permutation preservation, label alignment, pair grouping, and recovery invariants without calling a model. A separate opt-in exploration can use Jev as the measured system, with explicit recording and repeated confirmation before calling a shrunk input a reproducible model failure.
- [jsdiff](https://github.com/kpdecker/jsdiff) supplies word/whitespace and array diffs for the full text and option rail. Use `diffWordsWithSpace` and `diffArrays`; avoid `diffJson` for criteria because it alphabetizes object properties and would hide the very option-order intervention being studied. Jev supplies the changing decisions; the library makes the exact cause under test visible.

## Prioritized next steps

1. P1, S: derive paired metrics from the current completed record, publish the 3/40 reversal finding, and replace the pooled 200-case headline with 40 independent cases.
2. P1, M: add full question payloads, ordered criteria, matched JSON controls, versioned transforms, and tests for pairing and immutability.
3. P1, M: build the counterfactual desk with paired filtering and probability transitions using the existing records first.
4. P1, M: run the full 15,400-request basic matrix, followed by the 9,240-request declared injection track; publish partial progress only as availability, never as final scoring.
5. P2, M: add the prespecified permutation/repeat stress matrix and human-reviewed semantic changes. Reuse this machinery for context-filter regressions, router stability, and testing whether an agent verifier still detects a real policy change after harmless log reformatting.

## Investigation log

Read the current catalog, actual `Benchmarks` component, publication manifest and preparation path, Python runner and metrics, source loader, recovery code, provenance enrichment, and relevant record tests. Decoded both original and recovered JSONL records, checked all 200 state renderings against request logs, checked all 40 reversal payloads and repeats, and compared all 177 retained successes byte-for-value in predictions and probability maps. Read the full changed-decision utterances and recomputed the paired counts and probability distances. Verified official split size and scoring from PolyAI and its paper, and checked the three library APIs from primary documentation. No paid calls, app changes, browser automation, or new dataset downloads were performed. An attempted papercut log could not be written because this repository has not opted into `PAPERCUTS.jsonl`; the only friction was locating renamed preparation/shared-component files and retrying the repository-level dataset documentation link.
