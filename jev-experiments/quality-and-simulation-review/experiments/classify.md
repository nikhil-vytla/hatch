# Intent recognition

Verdict: repair. The underlying task suits Jev, the test inputs are real, and the full official test sets are feasible. The page currently hides the comparison that would explain its results.

## Current experiment

The catalog asks when Jev beats a simple classifier at `experience-prototypes/src/catalog.ts:189`. Jev receives one complete utterance and chooses one intent from all 77 BANKING77 labels or all 151 CLINC labels, including out of scope. It does not receive a shortlist containing the correct answer. Code turns underscored label names into descriptions, computes exact label agreement, trains a TF-IDF logistic regression baseline, samples test IDs, and retains the distributions. See `src/jev_lab/data.py:59`, `src/jev_lab/benchmarks.py:14`, and `src/jev_lab/benchmarks.py:40`. Paths in this report are relative to `jev-experiments/`.

The visitor sees the complete request, expected intent, predicted intent, six highest probabilities, search, a mistakes filter, and an expandable raw case. `experience-prototypes/src/benchmarks.tsx:118` renders the request and `:225` renders the label comparison. The primary page is a recorded case explorer, with no custom-intent interaction. Its public input is `experience-prototypes/results/classify.jsonl`, selected by `experience-prototypes/publication.json:5`.

## What works

- All 785 benchmark cases now have a result and complete request text. BANKING77 has 385 cases with 77 probabilities each. CLINC has 400 cases with 151 probabilities each. The probe at `quality-and-simulation-review/probes/classify.py` recomputes these counts.
- The candidate set includes every supported intent. There is no target-aware candidate construction in this experiment. The baseline uses the training split, while sampled labels come from test. The sampling seed and IDs are stored at `src/jev_lab/benchmarks.py:76`.
- Recovery retries only temporary transport failures and preserves completed mistakes. See `experience-prototypes/scripts/recover.ts:31` and `:62`. There were 43 recovered BANKING77 cases and 26 recovered CLINC cases. The UI distinguishes availability from judgment quality at `src/shared.tsx:233`.
- Commit revisions and checksums exist for source inputs. Publication adds prominent dataset links and content notices at `experience-prototypes/scripts/provenance.ts:5`. The current UI includes deliberate reveal controls for flagged content through `src/provenance.tsx:34`.
- Metrics already include paired bootstrap differences, Brier score, reliability bins, and risk versus coverage. The next UI need not invent these calculations. See `src/jev_lab/metrics.py:7` and `:78`.

## Findings

### P1: The benchmark comparison is absent from the page

`experience-prototypes/src/benchmarks.tsx:265` shows only Jev accuracy and completed-case count. It never reads `tfidf_logistic`, `baseline_rows`, or `paired_difference`, despite the catalog's comparison question. The published result is more informative than the UI:

| Current recovered sample | Jev | TF-IDF logistic |
| --- | ---: | ---: |
| BANKING77, 385 cases | 314/385, 81.56% | 343/385, 89.09% |
| CLINC in scope, 300 cases | 271/300, 90.33% | 269/300, 89.67% |
| CLINC out of scope, 100 cases | 83/100, 83.00% | 13/100, 13.00% |
| CLINC combined sample | 354/400, 88.50% | 282/400, 70.50% |

The paired 95% intervals are -11.95 to -3.12 percentage points for BANKING77 and +12.75 to +23.25 points for the chosen CLINC mixture. These describe these sampled cases, not deployment populations.

Why it matters: the visible Jev score has no useful reference, and CLINC's aggregate obscures where the improvement occurs. Correction: render both systems, paired differences, the in-scope and OOS breakdown, and each baseline prediction next to Jev's. Add a disagreement filter. Keep supervised baseline and zero-shot Jev conditions explicit. `README.md:31` also still says the baseline remains stronger within CLINC intents; the recovered data now shows a two-case Jev lead, which is too small to characterize as a reliable advantage. Generate report tables from the current published data.

### P1: Small samples stand in for feasible full official test sets

`src/jev_lab/benchmarks.py:42` takes five test examples per BANKING77 intent and two per CLINC intent, plus 100 OOS. The sampling mechanism is reproducible, but this covers only 12.50% of BANKING77 and 7.27% of CLINC's full test population. CLINC uses 25% OOS in the sample versus 18.18% in its full test split.

The [BANKING77 source repository](https://github.com/PolyAI-LDN/task-specific-datasets#banking) specifies 10,003 train examples, 3,080 test examples, and 77 intents. The [CLINC source repository](https://github.com/clinc/oos-eval#1-what-are-the-relevant-files) specifies 150 intents with 100 train, 20 validation, and 30 test examples each, plus 100 OOS train, 100 OOS validation, and 1,000 OOS test examples. I also counted the pinned local source files and confirmed these counts.

Why it matters: two cases per known CLINC intent cannot explain class-level failures. Correction: run the complete official splits with a frozen prompt and the same candidate set for every example. Keep the old run as a dated sample. There is no dataset-size blocker. Full-run transport handling and results navigation are routine implementation work, not grounds for retaining the sample.

### P1: Out-of-scope performance needs a stronger baseline and a declared operating point

The current baseline trains a 151-way logistic classifier, with only 100 OOS training examples versus 15,000 in-scope examples. It uses plain argmax and no validation-selected OOS threshold at `src/jev_lab/benchmarks.py:48`. That is a legitimate baseline, but a weak OOS operating point. The [original CLINC paper, sections 3.2 and 3.3](https://aclanthology.org/D19-1131.pdf) evaluates both an explicit OOS class and probability-threshold rejection, and reports in-scope accuracy separately from OOS recall.

Current Jev rejects 8/300 supported requests as OOS and routes 17/100 unsupported requests into a supported intent. The probability warning at `experience-prototypes/src/benchmarks.tsx:322` is accurate but does not let the visitor explore this tradeoff. Of the predictions assigned probability exactly 1, three of 162 BANKING77 predictions and seven of 171 CLINC predictions are wrong. These values are recorded probabilities, not calibrated certainty.

Correction: add a validation-calibrated logistic threshold baseline and a Jev rejection curve. Fit thresholds only on CLINC's 3,100 validation examples. Report OOS recall, OOS precision, false rejection of supported requests, and accepted-intent accuracy at the frozen threshold. Keep raw distributions intact, including rounding, and show any normalization used for derived scores. A threshold selected by a visitor on test data is an exploratory visualization and must not become the benchmark result.

### P1: Bare label names make fine-grained intent mistakes difficult to interpret

`src/jev_lab/data.py:68` and `:82` use label names with underscores removed as the full descriptions. That preserves the ontology but leaves distinctions such as `transactions` versus `spending_history`, or `pending_transfer` versus `balance_not_updated_after_bank_transfer`, largely implicit. A concrete case at `experience-prototypes/results/classify.jsonl:1215` asks how much was spent on a debit card this month. The dataset says `transactions`; Jev assigns `spending_history` probability 1. The distinction cannot be learned from the page's six abbreviated bars. BANKING77 case `banking77/test/2710` at line 22 similarly confuses pending transfer with a balance update.

This is not evidence that the dataset label should be changed. It is evidence that zero-shot label-name matching is a narrower condition than intent recognition with an explicit product ontology. Correction: retain that condition and compare a second, frozen description set authored from training examples only. Show the actual instructions and every option description in a searchable drawer, along with training-only examples that distinguish commonly confused intents. Measure the description change on untouched test cases; do not write descriptions to fix observed test mistakes and then present the result as untouched evaluation.

### P2: Dataset provenance and recovery details lose context when switching datasets

`experience-prototypes/scripts/enrich.py:45` assigns the BANKING77 repository as the single `source_url`. `src/benchmarks.tsx:252` renders that link even on CLINC cases. The top provenance panel does have both correct repositories, so the issue is the misleading per-case link. It also omits precise split size and selection counts in the visible description. `src/benchmarks.tsx:327` passes a dataset's rows with the combined result object into `Availability`; its fold therefore says 69 cases recovered whether the visible dataset recovered 43 or 26.

Correction: make provenance, source link, split size, sampling rule, baseline condition, recovery count, and run date dataset-specific. Store metadata once and reference it from each row. Do not bury the instructions and candidate text in an undifferentiated raw record. When the full run adds more sensitive cases, bind content notices to stable case IDs rather than the row index currently used at `scripts/provenance.ts:63`.

## Richer interaction: A support desk that knows when to ask

The visitor opens a small animated support inbox. A request enters, the complete text stays visible, and two lanes show what the TF-IDF baseline and Jev would do. Choosing a lane opens a route card with its definition, three training examples, probability, and the simulated downstream help screen. A request about an unsupported topic can go to a fallback desk; an ambiguous request can go to a clarification desk.

State includes the request, the available intent catalog, previous user clarification, pending decision version, and a validation-frozen acceptance policy. Jev chooses the intent and, in the separate simulation condition, one of a fixed set of clarification questions when several intents remain plausible. Code validates candidate IDs, applies the acceptance threshold, advances the animation, and renders a predefined route screen. No screen should pretend a banking transaction actually occurred. Editing a request creates a new version, and a late model response cannot route the newer text.

Failure behavior is visible. Transport errors leave the request waiting, with a retry that preserves its ID; semantic mistakes remain in the replay. An impossible or unsupported intent response becomes a contract error, not a successful fallback. Refusing to decide is measured separately from finding the correct intent.

Acceptance criteria:

- The visitor can inspect the full prompt and all 77 or 151 options without leaving the experiment.
- Both lanes consume exactly the same request, and each route opens the corresponding simulated help screen.
- A threshold slider previews coverage, error rate, and unsupported requests incorrectly routed. The frozen benchmark threshold remains clearly marked.
- Confused intent pairs link back to all matching official test cases. The definitions drawer uses no test examples as training demonstrations.
- Keyboard controls, reduced-motion mode, cancellation, and request-version checks work. Offline playback needs no API key; live classification uses the existing visitor-key flow.

## Evaluation protocol and feasibility

| Scope | Current completed cases | Complete official test | Additional decisions if the frozen old prompt is retained |
| --- | ---: | ---: | ---: |
| BANKING77 | 385 | 3,080 | 2,695 |
| CLINC in scope | 300 | 4,500 | 4,200 |
| CLINC out of scope | 100 | 1,000 | 900 |
| Total | 785 | 8,580 | 7,795 |

A fresh canonical run is 8,580 logical requests and 8,580 intent decisions with the current one-state, one-question runner. Across those requests it scores 1,067,660 label options. Do not call those options independent examples. Running only missing IDs is 7,795 requests, but a new prompt or changed model version requires a separately identified run. Additional retries are transport attempts, not new decisions.

The historical run contains 790 logical requests: 785 external benchmark decisions plus five separate authored semantic-type requests with three questions each. Its original transport record has 1,564 attempts, including 721 HTTP 200 responses. Recovery adds 118 job entries containing 123 physical attempts. Thus 1,687 attempts ultimately complete the 790 logical requests, and the semantic fixtures do not belong in the intent benchmark denominator. These counts come from the stored logs and recovered manifest, not an estimate.

Use label accuracy as the canonical BANKING77 score and retain macro-F1 and a confusion matrix as diagnostics. Report CLINC in-scope accuracy and OOS recall as the paper does. Add OOS precision, supported-request false rejection, and 151-way accuracy as explicitly additional measures. Score against the original dataset labels; no LLM judge is needed.

Freeze prompt, candidate order, label descriptions, source revision, baseline hyperparameters, and rejection rule before the new full test. For baseline comparison, retain the current full-training TF-IDF logistic model, add a validation-selected threshold variant for CLINC, and add nearest-training-example TF-IDF retrieval as a transparent reference. The raw model comparisons have no abstention; accepted-only claims always include coverage.

CLINC calibration adds 3,100 Jev decisions on its existing validation split. For BANKING77, which has no official validation split, reserve a deterministic 1,001-case stratified subset of its training split for Jev calibration and report that subset explicitly. A calibrated supervised baseline in that condition trains on the remaining 9,002 cases; the full-10,003-training baseline remains a separate raw condition. That adds 4,101 calibration decisions, making one fresh calibrated protocol 12,681 Jev decisions. A second frozen description condition adds another 12,681 if calibrated independently. This is a request count, not a spending recommendation.

Use paired bootstrap intervals over utterances, stratified by intent and OOS status, and show Wilson intervals for OOS recall and false rejection. Full-test point scores are exact for these splits; intervals describe sampling uncertainty for similar populations, not a correction for pretraining contamination. Disclose that Jev's pretraining overlap is unknown. For an order audit, pre-register 385 BANKING77 and 400 CLINC IDs and use three additional seeded option permutations, adding 2,355 decisions. Do not count permutations as independent cases.

Evaluate the support-desk simulation separately on 120 independently authored requests: 40 clear supported, 40 ambiguous with scripted clarification answers, and 40 unsupported. Run three fixed presentation-order seeds. Compare direct argmax, fixed-threshold routing, and the clarification policy. Measure correct final route, unsupported false route, clarification count, unresolved rate, and elapsed interaction time. A useful clarification policy should improve correct final route at matched coverage without increasing unsupported false routes; publish the paired difference and its interval rather than declaring success from a preferred example. These are authored workflow cases, not extra CLINC test cases.

Contract checks should cover source-ID uniqueness, test completeness, label coverage, train/test separation, row-to-baseline alignment, OOS partitions, probability validation, and aggregate parity. The existing test at `tests/test_contracts.py:157` checks the availability denominator; it does not verify this experiment's split completeness or displayed baseline.

## Libraries worth using

- [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html) supplies probability calibration and reliability tooling, alongside the baseline already in the repository. Jev contributes semantic interpretation; this library makes the fallback tradeoff measurable. Fit calibration on held-out data.
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) keeps a complete 8,580-row explorer and long option drawer responsive. Combine it with the already installed TanStack Table for filters and sorting. It supplies rendering behavior, while Jev supplies predictions and disagreement cases.
- [XState](https://stately.ai/docs/xstate) can represent waiting, classifying, clarifying, routed, and unavailable states in the support-desk simulation. Its benefit is explicit request lifecycle and cancellation behavior; Jev selects semantic branches within that state machine.

## Next steps

1. P1, S: expose baseline, OOS breakdown, paired differences, candidate descriptions, and dataset-specific provenance from existing records. Correct stale report values.
2. P1, M: add a full-split runner with resumable case IDs, frozen request metadata, aggregate parity checks, and completion accounting. Then execute the 8,580-case canonical run.
3. P1, M: evaluate validation-only OOS thresholds and a training-derived description condition. Keep each condition and its calibration records separate.
4. P2, M: build the support desk with both model lanes and visible downstream routes, then run the authored clarification evaluation.
5. P2, M: reuse the ontology and rejection policy in an intent-aware command palette. The new experiment would test whether typed application capabilities plus Jev can resolve a user's phrasing to a valid command, ask when ambiguous, and decline unsupported commands. It needs its own action-success labels rather than repurposing intent accuracy.

## Investigation log

Read the current catalog, React component, publication manifest, original runner, loaders, metric code, recovery and enrichment scripts, provenance component, and relevant metric test. Decoded the actual selected JSONL, read complete correct and incorrect cases, and independently counted all rows, label options, recovered cases, partitions, exact-probability mistakes, and request attempts. Counted the pinned cached official test files and verified official split sizes and CLINC scoring against primary sources online. Read primary scikit-learn, TanStack Virtual, and XState documentation. No model calls, new dataset downloads, app edits, or browser session were used for this audit.
