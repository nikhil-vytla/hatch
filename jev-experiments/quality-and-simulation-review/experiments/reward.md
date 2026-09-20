# Learning from rewards

Verdict: redesign the evaluation and interaction, retaining the real local optimizer. Highest priority: P1. The published run proves that Jev scores can change a small policy's parameters. It does not establish that its reward-versus-task divergence comes from a bad reward signal. A missing temperature representation explains much of the result.

## What runs today

The catalog asks whether optimizing Jev's feedback improves the task itself, `experience-prototypes/src/catalog.ts:238`. Jev rates whether each of eight fictional drinks satisfies every stated requirement. Four requests share a call containing 32 scalar questions, `src/jev_lab/teach.py:140`. Jev does not train a language model or act in an environment. It supplies a full reward vector before learning begins.

Deterministic Python generates the requests and independent target drinks, fits word unigram/bigram TF-IDF, and takes 240 exact gradient steps on expected reward with L2 regularization. The gradient updates a 72-by-8 matrix in the current run. This is full-information one-step policy learning, with no sampled-action feedback, exploration, or delayed outcomes, `teach.py:116`.

The current publication mapping selects `results/reward.jsonl`, `experience-prototypes/publication.json:24`. It contains one run, 44 usable training requests, 80 generated test requests, and 13 curve points. The page shows an animated training-reward curve, test-accuracy curve, counts, final accuracy, explanatory copy, and a raw result inspector. Its reward branch has no order entry, policy replay, checkpoint selection, or case-level explanation, `experience-prototypes/src/benchmarks.tsx:425` and `:572`. This review inspected source and records, not a browser.

## What already works

- The parameter updates are real. The offline probe reproduces every published weight and curve value exactly, with 576 nonzero weights and L2 norm 20.2973. The existing optimizer test passes, `tests/test_contracts.py:163`. That test uses the same identity matrix for training and testing, so it checks the update machinery, not generalization.
- The target menu is independent of Jev's scores. All 44 observed reward vectors rank the independently correct drink first; target scores are 0.97 to 0.99, and all other scores are at most 0.03. See `results/reward.jsonl:15` through `:58` and the probe.
- The 240-step recipe never picks a checkpoint from the test curve, `teach.py:193`. The exported weights allow this audit without new model requests.
- The page correctly says it trains a linear policy, and labels the reward as coming from training examples. Failures remain in the record rather than disappearing from the evidence.

## Findings

### P1: the test split removes the information needed to identify temperature

Training uses `hot` and `cold`. Every held-out request uses `warm` or `chilled`, `src/jev_lab/compositions.py:269`. The vectorizer learns its vocabulary only from training text, `teach.py:13`. Neither held-out temperature word appears in the current vocabulary.

The probe swaps temperature while holding each request's other words fixed. All 60 cases whose opposite temperature has another valid menu item produce identical features after the swap. Eight drink classes collapse into five semantic groups when temperature is removed. This is an information-loss confound, not evidence that Jev rewarded the wrong drink. Different clause orders can still produce accidental distinctions in this small sample.

Normalizing only `warm` to `hot` and `chilled` to `cold` at inference, without changing weights, raises accuracy from 51/80 to 74/80. That post hoc result diagnoses the confound; it is not a new held-out score to promote. Preserve a declared lexical-shift stress slice, but add an in-distribution test and a separate, predeclared normalization control. Include minimal pairs that force the representation to retain every decisive attribute.

### P1: the two curves do not isolate reward quality

The orange curve is the stochastic policy's expected reward on its training examples. The green curve is greedy argmax accuracy on a different, shifted test distribution, `teach.py:121`. Their gap mixes dataset shift, train/test generalization, and stochastic/greedy decision rules. The copy makes their divergence the central result, `benchmarks.tsx:455`, but it cannot assign that divergence to reward optimization.

Measured offline controls show the distinction:

| Method or quantity | Result |
| --- | --- |
| Published reward-trained policy, original test | 51/80, 63.75% |
| Supervised logistic regression on Jev's reward argmax, same features and rows | 51/80, 63.75% |
| Same optimizer with exact one-hot oracle rewards | 50/80, 62.5% |
| Published policy, temperature words normalized | 74/80, 92.5% |
| Supervised baseline, temperature words normalized | 76/80, 95% |
| Declared grammar parser plus menu lookup | 80/80, 100% |
| Uniform random expected accuracy or fixed drink | 12.5% |

The parser reads text and menu facts, not stored target labels, but it is tailored to this authored grammar. It establishes that a cheap solution exists for these fixtures. It is not a general language baseline.

At the final checkpoint, training greedy accuracy is 100%, expected training oracle success is 81.11%, expected training Jev reward is 79.74%, and expected test oracle success is 47.83%. Publish both evaluators on the same examples under the same decision rule, with separate train, validation, and test panels. Add the supervised and oracle-reward controls. There is currently no evidence of reward exploitation.

### P1: one templated test cannot support a stable learning claim

The generator cycles through the same eight menu targets and permutes four requirement phrases, `compositions.py:266`. Every request is fully specified and satisfiable. Sweetness and caffeine are correlated by the fixed menu, and no menu changes, contradictory orders, missing preferences, or unavailable drinks appear. Oracle labels are independent of Jev, but the underlying cases remain authored templates.

The published test has 51 successes out of 80. An ordinary Wilson interval is roughly 52.8% to 73.4%, before accounting for repeated template families. The same frozen policy ranges from 50% to 70% over 20 test wording seeds, averaging 57.13%. Those are sensitivity checks, not independent training replicates. The nominal manifest seed is 42, whereas the runner hardcodes training seed 17 and test seed 82, `teach.py:141`.

Store explicit generator, train, validation, test, and learner seeds plus case-level predictions. Separate language-family and menu-family splits; add unseen combinations and impossible cases. Treat current 20-seed probe results as exploratory. Report variation across independently generated training sets before claiming that learning reliably improves a task.

### P1: incomplete annotation is published as a complete experiment

The runner plans 48 training examples, but one exhausted HTTP 429 batch drops IDs 40 to 43, `results/reward.jsonl:59`. The remaining 44 examples include five examples of each caffeinated drink and six of each other drink. The manifest says `complete`, `results/reward.jsonl:1`, because only the all-failed case sets `status: partial`, `teach.py:164`, and the run writer otherwise defaults to complete, `src/jev_lab/core.py:204`.

The page correctly displays 44 training examples, but it does not show the planned 48 or the failed batch beside that count. Distinguish annotation coverage from policy accuracy. Save planned, successful, and failed IDs; mark incomplete coverage; resume only the missing batch; and use the same available examples for all controls. Do not score a provider failure as an incorrect drink choice.

### P2: the visitor cannot inspect what changed

The reward branch displays curves and aggregate statistics. Its exported final policy and all reward vectors remain behind a raw JSON inspector, while the only example browser is conditional on `id === "teach"`, `benchmarks.tsx:585`. No saved test predictions or intermediate weight snapshots explain why a drink changed.

Add a recorded replay that shows one request, candidate probabilities, Jev rewards, independent validity, and the selected drink across checkpoints. Include a known temperature minimal pair. Empty or failed runs should show unavailable measurements, rather than a default 0% from `benchmarks.tsx:449`. Preserve the claim that the current page is a recorded local-policy experiment.

## Proposed interaction: run a cafe with an imperfect reward

The visitor chooses a menu and a request style, then watches a short queue of customers. A request may be incomplete, impossible, or affected by a menu change. Before replaying training, the visitor predicts whether the learner will serve a drink, ask about a missing preference, or report that no item fits. They compare the frozen starting policy, Jev-reward policy, supervised baseline, and oracle-reward control on the same queue. Clicking a failed order reveals the requirement, menu fact, reward, and probability that produced it.

The visible state contains the request, current menu facts, inventory, stated preferences, and prior clarification replies. Actions are the eight available drink IDs, four attribute-clarification actions, and `no_match`. A versioned deterministic environment owns the true customer constraints, valid-action set, inventory transitions, clarification replies, maximum three decisions per order, and terminal outcome. Hidden constraints and oracle outcomes never enter Jev's reward prompt or learner features. Candidate identities and menu facts travel together when actions are reordered.

Jev rates visible state-action compatibility. The student learns from those scores. Code checks whether serving actually satisfies the customer's generated constraints, whether clarification was useful, and whether an order completed before the decision limit. A clarification action can be acceptable without immediately serving a drink. Menu facts control caffeine and dairy in this fictional world, irrespective of common drink-name associations.

The first implementation should train next-action decisions, retaining the current full-information objective. A second mode can reveal only the chosen action's cached reward and train a genuine contextual bandit. That mode must record action probabilities and compare methods under the same revealed-feedback budget. A later sequential learner is a separate experiment; a one-step bandit should not inherit credit for delayed outcomes automatically.

On a missing score, the replay displays unavailable feedback and retains the event in coverage counts. An illegal action becomes an explicit failed transition. The environment never silently substitutes a correct drink. A paused, versioned replay works without live Jev access.

Acceptance criteria:

- Every displayed action can be traced to a model checkpoint, state, candidate set, and independent outcome. Replaying the same seed produces the same episode.
- Train/test temperature minimal pairs differ in the student representation. Swapping menu facts changes the oracle validity set even when drink names stay fixed.
- The visitor can inspect at least one serve, clarify, no-match, and failed-order trajectory. All series expose their evaluator, dataset, denominator, and action-selection rule.
- Missing annotations, invalid actions, and timeouts stay visible. Their rates do not become task-accuracy labels.
- The UI can show a policy gaining reward while losing independent utility using a labeled synthetic biased-reward control. It must not imply that this happened with current Jev scores.

## Next training experiment and evaluation

Use an authored environment benchmark, not an external benchmark label. Keep the present 44/80 pilot as historical coverage. The proposed full experiment has five independently generated training sets of 320 decision states, a shared 160-state development set, and a locked 640-state test. Test slices contain 128 states each for ordinary requests, held-out language families, changed menus, underspecified requests, and impossible requests. Balance menu properties across generated menus so that sweetness no longer predicts caffeine. Split whole language and menu families before generating paraphrases, and remove exact duplicates and shared source-family derivatives across splits.

Train three learner/order seeds per training set, for 15 runs per method. In the current full-information optimizer, identical inputs and zero initialization are deterministic, so repeating only an irrelevant learner seed earns no additional evidence. Vary training data in every replicate; use learner seeds only for genuinely stochastic learners. Choose hyperparameters and checkpoints using development data, then freeze the protocol before opening the test. Add 200 locked short customer sessions to evaluate independent completion and clarification cost without further Jev reward queries.

Compare uniform random, most-frequent action, a declared rule parser, supervised learning from Jev reward argmax, full-information Jev-reward learning, exact oracle-reward learning, and direct greedy Jev scoring. Reuse the same stored score tables where possible. A shuffled-reward control tests whether the learner exploits label or ordering leakage. The main comparison uses identical representations, examples, budgets, and checkpoint rules. Normalized lexical input and raw input are separate registered conditions.

At each recorded checkpoint, compute expected Jev reward and expected oracle validity on the same fixed states. Also show greedy valid-action accuracy, per-constraint violation rate, no-match precision/recall, useful-clarification rate, episode completion, and mean decisions per completed order. Validate the reward itself with per-action Brier error against binary independent validity, false-high-score rate, and whether its top-ranked action belongs to the acceptable set. These measures distinguish a poor teacher from a poor student or representation.

Report paired differences with 95% intervals, resampling training datasets and held-out menu/language families rather than treating all paraphrases as independent. The first release succeeds as an evaluation if coverage is fully accounted for, score/weight/case replays agree, and all controls finish. A useful-policy target is at least 90% acceptable-action accuracy on the locked test, at most 1% hard-constraint violations, and a gain of at least 15 percentage points over the untrained policy. Claim an advantage over supervised learning only if the paired lower confidence bound exceeds zero. Publish a null result if it does not.

For a fixed eight-drink menu and 13 possible actions, score all actions in one logical request per state. The five training sets plus development and test require 2,400 requests and 31,200 scalar judgments before retries. Repeat a stratified 10% of these states to measure annotation stability, bringing the planned ceiling to 2,640 logical requests and 34,320 judgments. The 15 local training runs reuse that cache. Direct Jev greedy evaluation uses the existing test scores. These are future calls, not calls made during this audit. Blockers are authoring validated ambiguity/no-match cases, keeping family splits clean, and securing a future annotation budget; no large model training is needed.

## Libraries worth using

- [Gymnasium's custom environment interface](https://gymnasium.farama.org/introduction/create_custom_env/) supplies seeded reset, explicit action and observation spaces, step outcomes, and an environment checker. Use it for cafe transitions and replay. Jev adds semantic feedback on customer wording; the environment retains independent outcomes.
- [Vowpal Wabbit contextual bandits](https://vowpalwabbit.org/docs/vowpal_wabbit/python/latest/tutorials/python_Contextual_bandits_and_Vowpal_Wabbit.html) already supports action-dependent features and logged action-cost-probability feedback. Use `cb_explore_adf` only for the proposed selected-action-feedback mode, where menus and available actions can vary. Jev supplies the cached reward; VW supplies a tested learner and exploration implementation.
- [scikit-learn GroupKFold](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.GroupKFold.html) keeps groups out of both train and test within a fold. Use explicit language/menu-family grouping during development and retain the current scikit-learn supervised baseline. The final held-out test stays fixed outside that selection process.

## Prioritized work

1. P1, S: publish the temperature-confound diagnosis, matched baseline table, explicit coverage, and independent/stochastic metric labels. Keep the current record intact.
2. P1, M: persist complete test cases, per-case predictions, actual seeds, planned annotation IDs, and paired reward/oracle measurements. Add minimal-pair and incomplete-annotation regression checks.
3. P1, M: create the split-by-family cafe cases and cached evaluator tables; run the 15-run comparison after the annotation budget is approved in a future task.
4. P2, M: build recorded checkpoint and failed-order replay with Gymnasium outcomes.
5. P2, L: reuse the state/action cache in a VW selected-feedback study, then a separate clarification-policy experiment with delayed episode outcomes.

## Investigation log

- Read the catalog, publication mapping, Learning React branch, full reward runner, beverage generator, record decoder, manifest completion logic, and existing optimizer test.
- Decoded the complete current JSONL. Examined all 44 reward vectors, all 13 curve points, model parameters, and the failed batch.
- Wrote `probes/reward.py` and its `probes/reward.json` results. Reproduced weights and curves exactly, compared three cheap learning controls and a grammar parser, checked every valid temperature swap, and measured 20 test wording seeds without any model calls.
- Ran `tests/test_contracts.py::test_reward_training_changes_policy_and_improves_independent_behavior`; it passed. No app edits or browser run were performed.
- Verified the three primary documentation URLs above. No external benchmark was used or claimed. A guessed `scripts` directory did not exist; the runner lives under `src/jev_lab`. Papercut logging was unavailable because this repository has not opted in.
