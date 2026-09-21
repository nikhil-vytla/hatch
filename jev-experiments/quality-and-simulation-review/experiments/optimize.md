# Prompt evolution

Verdict: repair. The corrected run performed real optimization, but found no held-out improvement. Its larger problem is that temporary provider failures enter the optimizer as task failures, and a 20-example validation set gives unstable rankings. Preserve the negative result and make the search inspectable before spending more on it.

## Current behavior and evidence

The catalog asks whether prompt optimization improves unseen cases at `experience-prototypes/src/catalog.ts:222`. `main.tsx:638` renders the `Learning` branch in `benchmarks.tsx:509`. Visitors see five final accuracy cards and collapsible candidate instructions with validation scores. This is recorded evidence, not a live optimizer or an editable simulation. I inspected the React source, not a running browser.

Jev chooses one of ten Banking77 intents for each utterance. It does not write the candidate prompts or decide which candidate wins. Deterministic code supplies seven authored mutation fragments for random search and hill climbing, compares exact predictions with dataset labels, and retains the first highest validation score. Gemini 2.5 Flash Lite writes OPRO proposals and GEPA reflections. The GEPA library chooses training minibatches and candidate parents; the adapter supplies Jev outputs, probabilities and gold-label feedback. See `src/jev_lab/optimize.py:15`, `:53`, `:105`, `:148`, `:176`, and `:204`. The lockfile pins GEPA 0.1.4 at `uv.lock:304`.

`experience-prototypes/publication.json:21` publishes `results/optimize.jsonl`, run `20260920T060113-optimize-fe1728`. Its 478 JSONL lines reconstruct one document. Lists in the first line are placeholders, not missing measurements. The decoder at `src/jev_lab/records.py:24` restores them.

| Method | Published candidates | Unique instructions | Best validation | Final test | Changed selected instruction |
| --- | ---: | ---: | ---: | ---: | --- |
| Unchanged | 0 | 0 | Not separately stored | 43/50 | No |
| Random mutation | 12 | 10 | 17/20 | 43/50 | No |
| Hill climbing | 12 | 7 | 18/20 | 43/50 | Yes |
| OPRO-inspired | 12 | 9 | 18/20 | 42/50 | Yes |
| GEPA | 5 retained, including seed | 5 | 18/20 | 43/50 | No |

The Bun probe checked all 250 final predictions. Unchanged, random, hill climbing and GEPA made exactly the same predictions, including seven errors. Six errors confuse `card_arrival` with `card_delivery_estimate`; the seventh confuses a missing refund with requesting one. OPRO adds one error on `banking77/test/1874`, choosing `transfer_timing` instead of `pending_transfer`.

GEPA made 11 successful reflection calls across 19 iterations. Four proposals passed the five-example training check and reached full validation, seven proposals were rejected, and eight iterations skipped reflection after a perfect training minibatch. Its retained validation scores were 90%, 80%, 85%, 85%, 80%, so the seed won. The current runner handles both string and message-list reflection inputs at `optimize.py:176`. The earlier run's repeated `'str' object has no attribute 'get'` failures at `runs/20260920T054909-optimize-e576f0/gepa/run_log.txt:3` are fixed in the published run. They must not be used to claim GEPA never ran.

## What already works

- Gold labels provide an outcome independent of the reflection model. Jev receives record text and option descriptions, not targets, at `optimize.py:60`. Reflection receives training targets at `:163`; final predictions are scored after all selected instructions are frozen at `:214`. I found no test-label path into reflection or selection.
- The published run has 50 training, 20 validation and 50 official-test IDs. The probes found no selected-split ID overlap or lowercase/whitespace-normalized text overlap. The source commit and CSV SHA-256 values are recorded, and the offline baseline verified them.
- All five final methods answered all 50 cases. `metrics.py:7` separately records attempted and answered accuracy. `tests/test_contracts.py:157` checks that failures remain in the operational denominator.
- The UI explicitly warns that a higher validation score alone does not establish improvement at `benchmarks.tsx:545`. The repository README also states the negative held-out result at `README.md:50`.

## Findings

### P1: provider outages alter the optimization objective

Evidence: `optimize.py:79` converts any exception into error rows, and `:83` scores those rows zero. The saved OPRO history contains two 45% scores at `results/optimize.jsonl:155` and `:157`. Each corresponds to one ten-record request exhausting three retries with HTTP 429, leaving only 10 of 20 records answered. The corrected GEPA run also lost two five-record training evaluations after three HTTP 429 responses each. Its log rejects both proposals with a new minibatch score of zero at `runs/20260920T060113-optimize-fe1728/gepa/run_log.txt:87` and `:124`.

Impact: OPRO receives outage-contaminated scores in its next prompt, while GEPA rejects proposed text because service availability failed. Successful predictions cannot establish how those candidates would have scored. This is distinct from the valid operational convention of counting unavailable final decisions against end-to-end success.

Correction: persist per-candidate attempted, answered, incorrect and unavailable counts. Mark incomplete optimization evaluations `pending`, apply a bounded transport-only recovery policy to the exact request, and compare candidates only on complete matched records. Keep completed predictions immutable. If recovery is exhausted, stop that search as incomplete rather than silently using a zero fitness. Retain all-attempted accuracy as a separate operational outcome. Do not retrospectively replace failed scores and continue the old search, since later proposals already depended on them. Start a new identified search.

### P1: validation rankings are too coarse and noisy to attribute gains to instructions

Evidence: validation has two examples per intent at `optimize.py:45`; one changed prediction moves accuracy five percentage points. The identical seed scores 85% for random search, 80% for hill climbing and OPRO, and 90% for the corrected GEPA run. Hill-climb history repeats one identical instruction at 85%, 90%, then 85%, at `results/optimize.jsonl:83`, `:84`, `:87`. Only seed 42 is used. Final coverage is 50 cases from ten intents, 1.62% of the official 3,080-case, 77-intent test split. A descriptive Wilson interval for 43/50 is 73.8% to 93.0%; it does not account for shared-request dependence.

Impact: best-of-many validation selection rewards random variation as well as useful edits. The final result supports "no improvement observed in this run," not a general conclusion about GEPA or prompt optimization.

Correction: enlarge validation, repeat optimization across five seeds, include a repeated unchanged-prompt control, and report paired changes with uncertainty. Deduplicate prompt proposals or identify deliberate repeat measurements. Keep ten-intent results explicitly separate from a full 77-intent task. Balance the test request schedule across methods to reduce time-dependent provider effects.

### P1: resumption preserves prompts but silently replaces completed held-out measurements

Evidence: `optimize.py:89` selects the newest prior run and accepts it based on manifest configuration equality. The recorded configuration is only `quick=false, seed=42`. It does not bind the dataset, label set, writer model, packing, code version or failure policy. Lines `:94` to `:103` resume random, hill-climb and OPRO validation searches, then `:216` reruns every method's test. The prior run had 50/50 completed test cases for every method. Hill climbing changed from 42/50 to 43/50 in the published run with the identical selected instruction. The separate recovery utility does not apply to optimize, see `experience-prototypes/scripts/recover.ts:13`.

Impact: the final held-out labels did not enter the code's prompt selection, but the result is a second observation of an already opened test set. Selecting a later complete record can hide repeat variability, and a future code change can resume incompatible searches. Resuming random search also changes RNG consumption for a still-pending hill search because all methods share one RNG at `:51`.

Correction: hash the full protocol and each selected instruction. Resume only matching candidates, records and evaluation states, with a separate RNG seed per method. Keep the original completed held-out evaluation immutable. A repeat should receive a new replicate ID and appear beside the original; the GEPA integration correction should explain which evidence it supersedes. Publish source-run links for all resumed method histories. Add offline contract checks for protocol mismatch, interrupted search, and preservation of completed predictions.

### P1: a missing test score can be displayed as held-out accuracy

Evidence: `benchmarks.tsx:518` falls back from test accuracy to validation accuracy, then zero. The note at `:524` still says "Accuracy on 50 held-out test cases." A quick run contains only 20 test cases at `optimize.py:47`. The current published record has complete tests, so its five cards are correct today. The renderer nevertheless gives partial or differently sized records false labels.

Impact: a partial run may present selected validation performance as unseen-case evidence. The hard-coded denominator prevents visitors from recognizing quick runs or future full evaluations.

Correction: require a completed held-out measurement for the held-out card. Otherwise show "not evaluated" with the actual status. Derive attempted and answered counts from the record. Display the selected instruction, changed/unchanged status and paired difference against the seed. Tests should cover complete, quick, partial and missing-test records.

### P2: the published candidate list omits the actual search decisions and resource differences

Evidence: GEPA `history` stores only retained candidates and aggregate validation scores at `optimize.py:209`. Rejected proposals, training feedback, proposal parents and acceptance reasons remain in local logs. Random and hill climbing use seven authored fragments; OPRO sees only the last six prompt/score pairs; GEPA sees labeled training traces. Their common record ceiling therefore compares different search procedures and information access. GEPA's 250 metric records comprise 100 validation and 150 training records; other methods use 240 validation records. GEPA training requests hold five records, while validation/test requests hold ten. Reflection requests and token counts are outside this record ceiling.

Impact: the gallery cannot explain why GEPA selected the original, and a visitor can mistake 250 metric records for 250 API requests or an equal-cost comparison. The shared state also lets every record's question see the other nine utterances, so grouping is a potential confound, not ten guaranteed independent contexts.

Correction: publish a small event stream with every proposal and decision, plus per-stage metric records, API attempts, generator tokens and latency. Name OPRO as inspired and keep information-access differences explicit. Freeze batch membership for matched comparisons, test singleton versus packed scoring on a train-derived diagnostic set, and compare methods under both record and monetary budgets.

## Proposed interaction: replay the search and choose a candidate

The visitor starts with the original instruction, ten supported intents and a declared budget. A timeline advances through proposal, training check, validation, retain/reject and freeze events. Selecting an event shows an instruction diff, the cases that informed it, Jev's predictions and probabilities, gold labels, errors, and why deterministic selection kept or discarded it. Rejected candidates remain visible. The visitor can guess which candidate will win, then reveal the recorded selection and final held-out outcome. Editing an instruction forks a clearly labeled sandbox; it does not rewrite published evidence.

State includes protocol and split hashes, immutable candidate IDs, parent IDs, request groups, prediction IDs, proposal source, evaluation status and budget totals. Actions are step, play, select candidate, compare with seed, inspect case and fork. Jev only classifies utterances. Gemini proposes text, GEPA controls its search, and deterministic code computes scores, validates options, records costs and selects candidates. A replay makes no model calls.

On provider failure, the live fork stops at `evaluation incomplete`, preserves successful records and explains the recovery state. It cannot award a zero-quality score or reveal final test labels while search remains editable. When test results are revealed, the fork is frozen and further edits create a new exploratory branch.

Acceptance criteria:

- The published replay reconstructs 11 GEPA proposals, seven rejects, four retained mutations, eight perfect-minibatch skips and the seed selection. It identifies the two transport-caused rejections.
- Every shown score has a split name, numerator, denominator, completion state and evidence record. All 250 published test predictions reproduce the table above.
- The unchanged winner is visibly unchanged. A higher validation score cannot be labeled a held-out improvement.
- A request timeout never replaces a successful answer or turns an incomplete comparison into a ranked result.
- A replay is deterministic and uses zero API calls. A sandbox records its own protocol and cannot alter the published run.

## Evaluation protocol and full-benchmark feasibility

Current evidence is an external-data subset, not an authored fixture and not a full Banking77 result. The official source supplies 10,003 training utterances and 3,080 test utterances across 77 intents. I verified those counts online and against the pinned local CSVs. The test has 40 examples per intent. The benchmark paper reports exact intent-classification accuracy as its main metric. Use all 77 allowed labels and exact predicted-label equality for the comparable full score; macro-F1, class recall and coverage are secondary. Sources: [official Banking77 data](https://github.com/PolyAI-LDN/task-specific-datasets) and [original evaluation paper](https://arxiv.org/html/2003.04807v1).

An offline feasibility probe fitted the repository's TF-IDF bigram plus logistic-regression recipe, `C=4`, on all 10,003 training examples and predicted all 3,080 test examples with scikit-learn 1.9.1. It scored 2,741/3,080, 88.99% accuracy and 0.8903 macro-F1. Fit plus prediction took 3.68 seconds locally. This baseline uses more labeled data than the existing optimizer and is a separate reference, not proof that it beats Jev. Seven official test rows have lowercase/whitespace-normalized text matches in official training; removing them for a sensitivity check gives 88.97% over 3,073 rows. Preserve the official score, disclose overlap, and group duplicates when making new train/validation splits.

Run the repaired ten-intent protocol first, then expand all methods to 77 intents. Do not apply the ten-label OPRO winner to a 77-label task and call that a fair comparison. For the full experiment, preregister seeds 11, 23, 42, 67 and 89; set aside 770 train-derived validation examples, ten per intent with duplicate groups kept together; use the remaining train examples for reflection. The test set remains closed until all runs and selection rules are frozen. Since 50 test cases and many public labels have already been inspected, identify the full official score as reproducible benchmark evaluation, and separately report the 3,030 cases unused by this optimize pilot. Public model pretraining contamination remains unknown.

Baselines are unchanged Jev with repeated measurements, random mutation, hill climbing, OPRO-inspired search, GEPA, and the offline TF-IDF reference. Give search methods a ceiling of 16,000 classified records per seed, at most 19 new proposals plus the seed, and an explicit separate generation budget. The same labels and descriptions must be available to all. Also include a label-definition-only prompt constructed from training data to test whether gains come from clearer categories rather than optimizer sophistication. Fit the supervised reference on the same training partition for a data-matched comparison; retain the full-training reference in a separate column.

For five methods and five seeds, final full-test scoring is 77,000 Jev decisions, or 7,700 ten-record logical requests before retries. Four searches across five seeds have a maximum 320,000 record evaluations. At the present ten-record validation and five-record GEPA training packing, budget roughly 32,000 to 40,000 evaluator requests plus up to 190 OPRO/GEPA generation calls, before retries. These are upper planning figures, not a cost quote. The additional fixed definition-only control adds 15,400 decisions or 1,540 packed final requests across five seeds. Start with one seed and the frozen baseline plus winner, 6,160 decisions or 616 packed requests, to verify serving and cost accounting before the full comparison. With singleton final scoring the five-method, five-seed test costs 77,000 requests. A ten-intent intermediate test contains 400 official cases, requiring 200 packed requests for five methods in one replicate. No paid calls were made in this audit.

Measure matched per-case accuracy change, macro-F1, per-intent recall, unavailable rate, validation-to-test change, changed prediction count, proposal acceptance rate, generation tokens, reported cost and end-to-end latency. Repeat the unchanged control on 200 stratified validation cases in three identical and three shuffled batch layouts before freezing packing. That adds 120 packed requests; singleton versus packed comparison adds 220 requests for one pass. This diagnostic uses no official test data.

Report each seed, the mean seed difference and paired 95% intervals using 10,000 resamples. Resample shared request groups and optimizer seeds, with a case-level sensitivity analysis; never count five methods applied to 50 cases as 250 independent cases. Preregister GEPA versus unchanged as primary, with Holm adjustment for the four optimized-method comparisons if all receive formal claims. A useful success criterion is at least a two-percentage-point mean held-out gain, a positive adjusted interval lower bound, and no more than a 0.5-point increase in unavailable rate under the declared cost ceiling. An inconclusive or negative result is still publishable. Do not use test results to choose a more favorable seed or rerun policy.

The data and deterministic scoring are ready. Remaining blockers are outage-safe selection, protocol/event recording, validated 77-option request size, and an approved paid run budget. Full Jev evaluation was not executed here.

## Libraries worth using

- [GEPA 0.1.4 source](https://github.com/gepa-ai/gepa/blob/v0.1.4/src/gepa/api.py) is already the optimizer. Keep the pinned adapter and add callback events for proposal and evaluation decisions; check version support before using newer documentation APIs. [Current callback and optimization documentation](https://gepa-ai.github.io/gepa/api/core/optimize/) describes candidate events and validation policies. Jev supplies typed intent choices and probabilities; the library supplies search and lineage.
- [scikit-learn accuracy scoring](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.accuracy_score.html) supplies a conventional exact-label score and the existing local baseline stack. It makes the reference cheap to rerun and keeps correctness separate from model confidence.
- [SciPy bootstrap](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html) supports paired resampling. Use it after grouping dependent observations, with explicit handling of identical predictions and degenerate intervals. It does not make request-packed rows independent.

## Next steps

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Remove validation-as-test fallback, derive denominators, and show the original instruction as GEPA's winner. |
| P1 | M | Add incomplete fitness states, immutable successful predictions, protocol hashes and repeat IDs. Cover these contracts with offline fixtures. |
| P1 | M | Export all optimizer events and build the recorded search replay. |
| P1 | M | Run noise and packing diagnostics on training-derived data, then freeze the evaluation protocol. |
| P2 | L | Run one full 77-intent seed, review request costs, then complete the five-seed comparison if the budget permits. |

The same event format can support future experiments in optimizing route descriptions or decision thresholds while keeping selection feedback separate from independently measured task success.

## Investigation log

- Read the catalog, React dispatch/component, publication mapping, optimizer, client normalization, dataset splitting, metrics, recovery scripts and relevant contract tests. No optimize-specific contract test was found.
- Decoded the entire published JSONL; checked all final rows, candidate histories, source pins, split sizes and paired disagreements with `probes/optimize.ts`. Its output is `probes/optimize.results.json`.
- Traced all three local optimization runs and the corrected GEPA log, including reflection failures in the superseded run, successful proposals in the current run, HTTP exhaustion, and unchanged prompts across held-out reruns.
- Ran `probes/optimize.py` offline on the already cached, checksum-verified CSVs for full-split baseline scoring and duplicate checks. No datasets or model weights were downloaded.
- Verified primary GEPA, Banking77, scikit-learn and SciPy sources online. No browser interaction or paid model request was performed. Minor discovery misses came from guessed `client.py` and test-directory paths; the papercut tool reported that this repo has not opted in, so no papercut file was created.
