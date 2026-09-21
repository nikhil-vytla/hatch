# Active labeling

Verdict: repair. Keep the real teacher-to-student training loop, fix the representation and acquisition comparison, and turn the page into a labeling session. Current evidence is one authored beverage run with one acquisition seed. It does not establish savings from active labeling.

Paths below are relative to `jev-experiments/`. This review inspected code and published records and ran local inference. It did not run a browser, retrain a model, or call a paid provider.

## What the experiment does

The catalog asks which examples are worth labeling next, in `experience-prototypes/src/catalog.ts:230`. The published input is `results/teach.jsonl`, selected by `experience-prototypes/publication.json:29`.

Jev chooses one of eight fictional drinks for each requested label. It receives the menu and request text, but no target labels, in `src/jev_lab/teach.py:44`. Jev does not choose the acquisition policy or update the student. Deterministic code generates a 160-row pool and 80-row test set, fits a TF-IDF vocabulary on the pool, gives both methods the same eight initial examples, and requests eight labels per round up to 32. Random sampling draws remaining IDs; uncertainty sampling ranks `1 - max(student probability)`. Scikit-learn fits a fresh logistic regression after each batch. The menu generator supplies the test targets independently of Jev, in `src/jev_lab/teach.py:31` and `src/jev_lab/compositions.py:258`.

The current React page shows two accuracy curves and eight teacher-labeled examples at a time. Its only experiment-specific action is "More examples." It neither trains a student nor lets the visitor choose, correct, or test a label, in `experience-prototypes/src/benchmarks.tsx:456` and `:585`. The old browser classifier remains available in `web/src/local-classifier.ts:2`, but the current `Learning` component does not call it.

## What already works

- Training is real. The runner fits logistic regression on acquired Jev labels and exports vocabulary, IDF, classes, coefficients, and intercepts, in `src/jev_lab/teach.py:19` and `:79`.
- The acquisition comparison has a shared initial batch and equal attempted budgets. The student never sees test targets during fitting. Fitting vocabulary on the whole unlabeled pool is a valid transductive choice here; it is not test leakage, in `src/jev_lab/teach.py:13`, `:32`, and `:59`.
- Teacher labels and task success are separate quantities. All 51 saved teacher answers match the menu oracle, while student accuracy is much lower. The actual training prompt omits `target` and `requirements`, in `src/jev_lab/teach.py:45` and `results/teach.jsonl:263`.
- The UI already states that these are small authored fixtures and that uncertainty sampling did not show an advantage. That is more honest than presenting the curve as an active-learning win, in `experience-prototypes/src/benchmarks.tsx:472`.
- A cross-runtime test compares the exported predictor with scikit-learn on six inputs, including Unicode, repetition, unknown tokens, and empty text, in `tests/test_browser_classifier.py:17`. I inspected that test but did not run it because this checkout's Python lacks scikit-learn and pytest. The audit probe did run the existing Bun predictor and exactly reproduced both published final scores.

## Measured evidence

The run `20260920T051911-teach-24a85f` is complete. It has no final label failures, 51 labeled pool IDs, and seven successful transport requests after seven HTTP 429 attempts. The 51 IDs represent 47 distinct texts. The pool has 140 distinct texts among 160 rows; the test has 77 distinct texts among 80 rows, with ten examples per drink. There is no exact train/test text overlap. There are only eight semantic requirement combinations.

| Labels attempted | Random test accuracy | Uncertainty test accuracy |
| --- | ---: | ---: |
| 8 | 25.00% | 25.00% |
| 16 | 48.75% | 37.50% |
| 24 | 52.50% | 55.00% |
| 32 | 53.75%, 43/80 | 52.50%, 42/80 |

I also enumerated all 768 distinct held-out templates in the current generator: eight drinks, four introductions, and 24 attribute orders. The existing final models score 391/768, or 50.91%, for random and 344/768, or 44.79%, for uncertainty. This is exhaustive coverage of that authored grammar, not an external benchmark. Reproduce the counts and predictions with `python3 jev-experiments/quality-and-simulation-review/probes/teach.py`. Results are in `quality-and-simulation-review/probes/teach.results.json`.

## Findings

### P1: the held-out temperature words erase information the student needs

`src/jev_lab/compositions.py:269` replaces `hot` and `cold` with `warm` and `chilled` in every test row. Both test words are absent from the 72-term training vocabulary. Swapping them changes zero of 80 probability vectors for either exported model. Across the complete 768-template set, identical feature vectors join opposing temperature classes and limit any deterministic classifier using these features to at most 62.5% accuracy.

This comparison mixes acquisition quality with a representation failure that acquiring more labels from the current pool cannot fix. As a diagnostic only, restoring `hot` and `cold` in the 80 test texts raises the existing models to 71.25% and 72.50%. This does not prove either policy better. It identifies a large confound.

Separate an in-distribution acquisition study from a held-out wording challenge. Freeze a representation that can express the relevant distinctions before comparing acquisition policies. A documented synonym normalizer is an adequate toy control; a frozen text encoder is the realistic alternative. Test new wording separately and report both scores. Do not silently fit vocabulary on the test set.

### P1: duplicate texts consume the label budget

The cache keys by pool index, in `src/jev_lab/teach.py:40`, and least-confidence acquisition takes the top eight remaining IDs without a diversity constraint, in `:68`. Uncertainty sampling acquires only 28 distinct texts in 32 selections, versus 32 distinct texts for random. At budgets 8, 16, 24, and 32 it has 8, 15, 23, and 28 distinct texts. Calling all 51 cached IDs "unique teacher labels" hides that only 47 texts were labeled.

Repeated requests are a valid workload when they reflect real prevalence, but they should not require repeated annotation of identical content. Cache labels by text hash plus menu, prompt, and model version. Separate acquisition units from frequency weights. Compare deduplicated random and least-confidence sampling with a diversity-aware batch strategy. Report attempted calls, successful annotations, distinct texts, human correction time, and training weight separately.

### P1: one small seed cannot establish label efficiency

The runner fixes pool seed 7, test seed 991, and acquisition/model seed 42, in `src/jev_lab/teach.py:32`. The last-point gap is one test example. Both methods start with five of eight classes; random never acquires a hot-chocolate example by 32 labels. Final class accuracy includes zeros for several drinks. The result saves aggregate accuracy but no repeated runs, confidence interval, per-test predictions, or label-cost frontier.

The full authored test is cheap enough to run now, as the probe demonstrates. Use it for regression coverage, then repeat acquisition under at least 20 paired seeds. Add a majority-prior baseline, a deterministic menu parser, a full-pool oracle-labeled student, and oracle labels at equal acquisition budgets. These separate representation limits, class discovery, teacher error, and acquisition policy. Report the area under the accuracy-versus-label curve and the labels needed to reach a predefined score. Keep the external benchmark separate.

### P1: the visitor cannot act on the experiment's central question

`experience-prototypes/src/benchmarks.tsx:456` renders saved curves; `:585` pages through teacher examples. The user cannot inspect why an example was acquired, select a competing example, fix an answer, or see a local model respond. There is no teacher-error or human-correction experience, and this record's perfect teacher agreement would not exercise one anyway.

Add the annotation session described below. Give visitors a fixed label budget, a choice of next example, and a visible student prediction before and after each accepted label. Keep a small sealed evaluation set out of the interaction; use a separate visible practice stream for immediate feedback.

### P2: missing measurements would look like measured zero accuracy

When fewer than two classes are available, the runner emits `accuracy: null`, in `src/jev_lab/teach.py:74`. The current chart changes null to zero, in `experience-prototypes/src/benchmarks.tsx:467`. This did not affect the published successful run, but a failed batch or a one-class cold start would appear to be a trained model scoring 0%. The artifact also lacks acquisition scores and student snapshots for individual rounds, in `src/jev_lab/teach.py:91`.

Show "not trained" or "incomplete" as a gap. Publish requested, answered, and unique-text label counts beside each point. Store candidate utilities, selected text hashes, model version, per-case predictions, and failure reasons per round. Let visitors replay a real acquisition decision and distinguish a transport problem from poor model quality.

## A richer simulation: spend 24 labels to train the drink desk

The visitor opens a queue of requests with an eight-label starter model and 24 labels left. A visible practice stream shows its current mistakes. Each round offers random, least-confidence, and diverse-uncertainty suggestions, with predicted class, uncertainty, and duplicate count. The visitor selects up to four examples, chooses "Ask Jev" or supplies a label, and can accept, correct, or mark an answer ambiguous. After committing the batch, the student retrains, the queue reorders, and changed practice predictions animate. A final one-time evaluation reveals independent success and compares the same budget with a paired random run.

State includes stable example IDs and hashes, unlabeled/labeled/ignored partitions, a versioned annotation ledger, annotation source, model weights, budget counters, pending requests, and a sealed evaluation manifest. Actions are select, label, correct, abstain, commit batch, undo the last batch, and finish. An undo rebuilds the student from the ledger; it does not refund an already incurred provider call.

Jev supplies a typed label and probability distribution for selected examples. A new ambiguity option can flag requests with no unique menu solution. Jev never sees sealed targets, selects the winner, or scores its own accuracy. Code handles deduplication, acquisition scores, batch diversity, budget accounting, retraining, inference, and executable menu-constraint checks. Human corrections remain distinct from Jev predictions. The independent outcome is whether the predicted drink satisfies every explicit requirement; impossible or underspecified requests require abstention or clarification.

Recorded mode must be clearly labeled and replay cached labels only. An optional teacher simulator can inject specified error and abstention patterns for testing corrections, but those rates must be labeled as assumptions. They are not estimates of real Jev or human behavior. A separate measured human study can later estimate annotation time and correction errors.

Acceptance criteria:

- A visitor can select, label, correct, retrain, and inspect a changed prediction without leaving the page.
- Identical text under the same menu and teacher configuration uses one annotation; intentional repeat judgments are explicitly priced and recorded.
- Budget, acquisition seed, representation, and initial labels are identical for paired methods. No method reads gold labels to balance its queue.
- Retrying a failed request never creates a label or model update. A one-class starter set displays "not trained" until a valid model exists.
- Correction and undo reproduce the same model from the same ledger. Published per-case predictions reproduce every displayed score.
- Practice feedback and sealed evaluation are separate. No test targets reach Jev, acquisition, hyperparameter choice, or the visitor before finish.
- A scripted incorrect-teacher scenario shows a human correction change the ledger and student; the UI identifies it as a simulation.

## Evaluation protocol

First, evaluate the exported models on all 768 current authored test templates, as done in this audit. Retain this fixed regression set and the temperature counterfactual check. Do not claim 768 independent semantic problems or attach a naive binomial interval to them.

For a repaired beverage study, predeclare 20 paired acquisition seeds and budgets 8, 16, 24, 32, 48, and 64. Use a deduplicated pool, one frozen representation, and identical initial samples for each pair. Compare random, least confidence, and uncertainty with diversity, under both menu-oracle labels and teacher labels. Add the majority prior, deterministic menu parser, and full-pool oracle student as controls. Separate in-distribution language from a wording-shift suite. Group authored cases by their semantic source and template family when splitting; no paraphrase family may cross development and sealed evaluation. Report the eight-drink result as a toy result even after replication.

Primary metrics are normalized trapezoidal area under the accuracy-versus-unique-label curve and labels required to reach 90% of the full-pool oracle student's validation accuracy. Fix that threshold before test evaluation; mark runs that never reach it as censored. Secondary metrics are macro-F1, per-class recall, Brier score, coverage and error at an abstention threshold chosen on validation data, label agreement, correction time, provider requests, and retry-inclusive latency. Give paired seed differences and a 95% bootstrap interval over seeds. Do not treat repeated templates or reused teacher outputs as independent teacher replications.

An active-labeling benefit requires a positive lower 95% bound on the paired area-under-curve improvement over random and at least 10% fewer median unique labels to the fixed target, with no more than one percentage point loss in final macro-F1. This is a proposed decision rule, not a result. Retain negative and incomplete runs.

### Full external evaluation

BANKING77 is a suitable next task because it preserves the intent-labeling workflow while replacing authored templates with a released dataset. The official repository lists 10,003 training examples, 3,080 test examples, and 77 intents. Current coverage here is zero external cases. The original paper scores single-label classification accuracy on the standard test set; it also reports 10- and 30-example-per-intent settings. Those few-shot settings are not themselves an active-learning protocol. Sources: [official dataset](https://github.com/PolyAI-LDN/task-specific-datasets#banking) and [original evaluation](https://arxiv.org/html/2003.04807v1).

Use all 3,080 official test examples at every reported checkpoint, with exact-match top-1 accuracy as the primary benchmark score. Add the efficiency metrics above. Reserve a fixed 20 examples per intent from the official training set for development, giving 1,540 development cases and an 8,463-case acquisition pool. The resulting training restriction must be disclosed. Use ten paired seeds, an initial uniform random sample of 77 pool examples, and total budgets 77, 154, 308, 616, and 1,232. Do not use hidden gold classes to create balanced initial labels. Compare random, least confidence, and diversity-aware acquisition. A full-supervision control can train on the same 8,463 pool examples; published full-training comparisons require a separately labeled 10,003-row run with frozen settings.

Start with released training labels as a perfect annotation simulator. This costs zero Jev requests and isolates acquisition quality. It cannot demonstrate Jev label quality. For the teacher arm, cache Jev labels by exact request content, option definitions, model version, and batch context. At eight independent labeling decisions per request, labeling the entire fixed 8,463-row pool would take 1,058 successful requests; direct Jev inference on the full test would add 385. These counts exclude retries and a pilot to verify that batching does not change answers. Reuse one frozen teacher-label realization across acquisition seeds, disclose that dependence, and repeat a stratified subset separately to measure teacher variability.

The ten-seed, three-policy, five-checkpoint student study needs 462,000 local test predictions, which is feasible for a sparse linear model. External download, environment setup, teacher annotation cost, a usable definition for all 77 options, and source-label ambiguity are the remaining work. This audit downloaded no dataset or weights and made no provider calls. Public benchmark exposure is a possible model-pretraining confound; do not describe it as unseen production traffic. Add a later independently collected set before claiming production annotation savings.

## Reuse existing tools

- [small-text](https://small-text.readthedocs.io/en/latest/api/active_learner.html) provides a pool learner with query/update, retraining, ignored labels, and label correction. Its [query strategies](https://small-text.readthedocs.io/en/stable/components/query_strategies.html) include least confidence, random, and coreset methods. Use it to replace custom acquisition bookkeeping while keeping the existing sklearn student and export adapter. Jev contributes proposed labels and uncertainty for review; the library supplies the training loop.
- [Label Studio pre-annotations](https://labelstud.io/guide/predictions) support versioned model predictions and prediction scores. Use that format for exporting a real annotation queue and collecting human review outside the public demo. Jev can prefill a suggested intent; the application must retain accepted human labels separately from predictions. The public experience still needs the immediate training feedback described above.

## Next steps

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Publish the 768-template inference probe, temperature blind spot, distinct-text counts, and per-class scores beside the current pilot. |
| P1 | M | Repair the representation controls, deduplicate acquisition units, and run 20 paired seeds with oracle-label and teacher-label arms. |
| P1 | M | Build the budgeted annotation and correction session, including a recorded teacher-error scenario and reproducible student updates. |
| P2 | S | Preserve missing points as missing and save round utilities, model versions, per-case predictions, and request accounting. |
| P2 | L | Add the full 3,080-case BANKING77 evaluation, first with a perfect annotation simulator and then with a measured teacher-label cache. |

The annotation ledger and correction replay can support a later ticket-routing experiment that measures human review time and downstream routing success, using independent outcomes rather than teacher agreement.

## Investigation log

- Read the current catalog, `Learning` React component, publication map, complete `teach` runner, beverage generator, record decoder, browser predictor, and parity test.
- Reconstructed all published JSONL arrays, inspected complete teacher answers, and counted every label, selected ID, distinct text, class, and curve point.
- Ran the existing Bun predictor through `probes/teach.py`; reproduced 43/80 and 42/80, enumerated and scored all 768 held-out templates, restored temperature vocabulary as a diagnostic, and swapped temperature synonyms to verify invariance.
- Calculated the 62.5% representation upper bound by grouping exhaustive cases with identical retained term-count features.
- Verified official BANKING77 split counts and scoring, and small-text and Label Studio capabilities, through primary documentation.
- Python in this checkout lacks scikit-learn and pytest. No packages were installed; no training, browser session, provider call, or full external dataset evaluation was performed.
