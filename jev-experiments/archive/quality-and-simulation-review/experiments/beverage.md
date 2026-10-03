# Drink finder audit

Verdict: redesign the interaction, while keeping the small menu example as an integration test. The current run demonstrates attribute lookup on eight fictional drinks. It does not yet test the interesting problem: helping someone discover and revise a drink they would enjoy.

## Current experiment

The catalog asks whether Jev can match preferences without inventing menu facts at `experience-prototypes/src/catalog.ts:118`. Published input comes from `results/beverage.jsonl` through `experience-prototypes/publication.json:3`.

The Python runner creates 24 requests by repeating each of eight complete attribute profiles three times, shuffling four phrases and changing an introductory phrase. Each request states temperature, caffeine, dairy and sweetness. Jev selects one drink, scores whether clarification is necessary, extracts temperature and dairy, and selects a workflow action. Code creates the menu and expected item, but does not independently validate the prediction against extracted constraints. See `src/jev_lab/compositions.py:246`, `:258`, `:290` and `:329`.

The current React view is different. It shows a cup, eight menu buttons, a text area and a live button. A live request asks only for a drink or `none`, plus one clarification field. Code sets the displayed drink directly from the returned answer. The customer can also choose any menu button manually. See `experience-prototypes/src/agent-experiments.tsx:472`.

## What works

- Menu facts are visible and passed to Jev. Live options include `none`, which gives the model a way to decline an unsupported match. The footer says this is a fictional menu and does not place an order. See `agent-experiments.tsx:507`, `:539`, `:550` and `:574`.
- The recorded set contains 23 correct completed classifications, one HTTP 429 case, and two additional ambiguity examples. The missing case is operational availability, not a wrong drink. The result stores both answered accuracy and all-attempted completion-sensitive accuracy. See `results/beverage.jsonl:1` and `:14`.
- The existing Adaptive forms experiment already contains reusable deterministic menu filtering and all 81 partial preference states. It can supply the menu engine for Cafe Jev without rebuilding those parts. See `experience-prototypes/src/journeys.tsx:31`, `:41` and `:48`. Its question policy is a separate experiment and is not counted as Drink finder evidence here.
- Visitor keys remain in memory, and live calls accept an abort signal at the shared API boundary. See `experience-prototypes/src/api.ts:1` and `:20`.

## Findings

### P1: the evaluation excludes the situations that require judgment

All 24 scored requests describe an existing menu item exactly. The 23 completed requests contain only 22 unique strings. A four-substring parser plus a menu lookup gets all 23 correct. This does not show that Jev is unnecessary for drink discovery; it shows that this test cannot measure that use case. The probe is `quality-and-simulation-review/probes/beverage.py`.

The menu has eight of the 16 fully specified Boolean attribute combinations. None of the eight impossible combinations appears in the scored set. Across all 81 partial states, 16 have no matching drink, 29 have one, and 36 have several. The current benchmark scores only fully specified supported profiles. The two ambiguous records have no expected workflow labels and never enter accuracy. See `compositions.py:267`, `:277`, `:330` and `:337`.

Correction: keep the 24 requests as smoke tests. Add complete state coverage, independently written requests, soft preferences, revisions and impossible constraints. Score set-valued acceptable answers, abstention, useful questions and final satisfaction separately. Do not describe three phrase variations of the same profile as three independent customer scenarios.

### P1: recorded results and the live experience use different contracts

The runner has eight drink options and five questions. The UI has nine drink options and two questions; `clarify` changes from a numeric score to a categorical answer. The UI initializes its answer from a recorded herbal-tea row while displaying a different default request. A recorded numeric clarification value cannot trigger the UI's string-only clarification notice. See `compositions.py:294`, `:299`, `:309`; `agent-experiments.tsx:483`, `:486`, `:541`, `:553` and `:564`.

Correction: define a versioned request/response schema and use it in the recorder and UI. Store menu revision, prompt revision, exact submitted text and request ID with each result. Re-record the new workflow rather than presenting the old classification set as its validation. Include a visible recorded/live/manual badge.

### P1: menu consistency is requested in a prompt but never enforced in this view

The component sends raw text and directly calls `setSelected(r.answers.drink.value)`. There is no extracted hard-constraint state and no independent feasible-set calculation. The model can select a drink and ask for an essential missing preference in the same response; both are displayed. `none` gets rendered as a cup titled "None" because the renderer has no unsupported or clarification state. See `agent-experiments.tsx:539` through `:571`.

Correction: Jev should interpret language into typed preferences with evidence spans and classify whether each preference is required, preferred, unknown or contradictory. Code should validate the structure, compute feasible recipes, and reject impossible combinations. Jev can rank feasible candidates and select the next useful question. Explicit user choices remain authoritative. Keep raw model output visible when a guard rejects it; do not silently score the corrected result as a model success. Evidence spans can expose mistakes but do not prove extraction correctness, so evaluate them against independently annotated requests.

### P1: the displayed suggestion can lose its connection to the request

Clicking a menu button changes only `selected`; editing the request changes only `input`. Both leave the old answer intact. During a live call the textarea and menu remain interactive, and the eventual result unconditionally overwrites the current selection. The shared runner only tracks a busy flag and error. See `agent-experiments.tsx:512`, `:530`, `:559`, `:573`; `shared.tsx:214`.

Correction: retain `submittedRequest` separately from the draft, mark edited drafts as unevaluated, and attach every answer to a monotonic request revision. Abort on reset or customer change and ignore obsolete completions. Manual selections should be labeled as customer choices, with their own constraint checks. Test an in-flight answer arriving after a request edit, customer switch and manual selection.

### P2: the cafe has no customer journey or customizable recipe

The model's clarification is a notice without answer controls or conversation history. The same steaming cup is rendered for espresso, iced coffee and milkshake. Menu cards omit sweetness even though sweetness determines several predictions. Menu facts are copied in `compositions.py:246`, `journeys.tsx:6` and `agent-experiments.tsx:473`. Fixed hot chocolate is explicitly fictional and caffeine-free in this fixture; those facts should not silently become claims about real cafe products.

Correction: make one versioned fictional recipe catalog drive the UI, prompts and evaluator. Include supported modifiers, incompatibilities, price deltas, availability and explicit ingredient facts. Separate creaminess from dairy content, caffeine quantity from coffee flavor, sweetness level from flavoring, and desired serving temperature from whether an item is customizable. Render the actual cup, layers, ice and ingredients. Show unavailable choices and their reasons rather than hiding them.

## Cafe Jev simulation

An illustrated customer enters a small cafe. Their first thought appears in a speech bubble: "I want something like dessert, but I have a long walk and don't want much caffeine." The visitor can play the customer or replay a recorded scenario. An optional inspector reveals the simulator's hidden preferences only after the episode; Jev never receives the private goal.

The customer browses illustrated menu cards. Jev extracts stated preferences, marks uncertainty, and chooses one useful question from supported topics. The visitor answers through chips or a short sentence. Each answer animates the feasible menu set and explains exclusions in plain text. If milk is preferred, a recipe editor offers only allowed dairy/oat/soy choices for the selected base. Sweetness, size, ice and shot count visibly change the cup and receipt. A mid-order revision such as "Actually, make it iced, and under six dollars" updates those constraints without erasing unrelated choices. On confirmation, the barista prepares the selected recipe and the simulated customer checks it against the private goal.

State consists of `sessionId`, request revision, public transcript, preference values plus requirement strength and source turn, menu revision, inventory, candidate recipes, draft recipe, pending question and confirmation state. The simulator separately owns a hidden customer profile, held-out utility function and seeded answer script. Actions include arrive, browse, say, answer, modify, explain, undo, reset and confirm. Code owns ingredients, prices, availability, feasible combinations, animation and terminal scoring. Jev owns semantic interpretation, soft-preference ranking and clarification choice among legal actions. Supply the legal action list explicitly.

Use five base families for an initial build: espresso drink, brewed coffee, herbal infusion, cocoa and lemonade. Offer modifiers only where the catalog supports them. Count legal combinations after validating the catalog instead of advertising the unconstrained Cartesian product. Preference ranking can batch several questions in one Jev request, but do not send hidden satisfaction weights or expected answers.

On a provider overload, preserve the scene and draft; retry the same request with bounded backoff and show a quiet waiting state. On exhaustion, offer retry or a labeled manual ordering path. An unsupported constraint leads to a no-match scene with the smallest explicit changes that would restore a feasible drink. Conflicting language leads to a targeted question. A model error stays in the trace, even if code prevents its execution. No simulated confirmation places a real order.

Acceptance criteria:

- A visitor can complete an arrival-to-receipt journey, revise a prior choice, undo it and replay every decision.
- The same seed and decisions reproduce the same inventory, customer answers and terminal outcome.
- Invalid ingredients, unavailable inventory and exceeded explicit budgets never reach simulated confirmation. Report semantic extraction errors independently.
- Cold drinks show ice or condensation rather than steam; changing milk, syrup, size or shots changes the visual and receipt. All transitions have reduced-motion alternatives.
- Recorded replay works without a key. Live mode requires the visitor key. Recorded, model-selected and manually selected actions remain visibly distinct.
- Late responses cannot alter a newer customer session or overwrite a newer draft.
- The view shows full customer text, menu facts, extracted constraints, chosen question and model probabilities when inspecting a turn.

## Evaluation protocol

This is an authored simulation, not an external benchmark. There is no official split to expand. Full finite coverage is inexpensive and should replace sampling where the state is enumerable.

First enumerate all 81 partial states of the current four-attribute menu and verify exact feasible sets in code, including all 16 fully specified states. Write four independent language realizations for each state, 324 requests, spanning direct wording, negation, everyday paraphrase and multi-sentence context. Run three seeded candidate-order permutations, 972 Jev calls per tested policy. Keep all original text and expected constraint sets. These are authored language tests over a finite catalog, not 972 independent semantic tasks.

Then create 24 development situations and a locked test of 120 multi-turn customer scenarios. Balance the test across complete orders, soft preferences, contradictions, revisions, budget/inventory conflicts and unfamiliar paraphrases. Have a separate annotator review the hidden goal and accepted terminal recipes. Run three menu-order seeds and at most six model turns per episode, at most 2,160 more calls. Total main test volume is at most 3,132 logical model requests per policy, plus development and transient retries. One request may contain several typed questions. The deterministic simulator, not another model, generates responses from hidden goals; include a later human study because scripted customers still simplify language.

Baselines are a literal phrase parser plus exact filter, a fixed questionnaire plus exact filter, an information-gain questionnaire with oracle structured preferences, and manual menu browsing. The oracle version separates question-policy quality from language extraction quality. The fixed questionnaire is the practical baseline Jev must improve on. For recommendation, compare uniform and simple weighted ranking over the same feasible candidates. Give every policy identical public menu facts, maximum turns and inventory.

Report preference extraction exact match and per-field accuracy; conflict/no-match precision and recall; hard-constraint violations; valid confirmed recipe rate; successful customer goals within six turns; utility regret against the hidden acceptable set; clarifications per successful order; redundant questions; refusal on solvable cases; edits preserved after revision; completed call latency and end-to-end latency; retries and provider availability. Separate raw policy correctness from correctness after deterministic guards. Record reasons for abstention.

Use scenario-cluster bootstrap intervals for paired policy differences, treating the three option orders as repeated measurements. Show per-condition counts and intervals rather than one aggregate percentage. All 23 current completed predictions have probability 1; that is not evidence of broad calibration. Evaluate probability reliability on the harder held-out cases before using confidence to skip questions.

Proposed release targets are zero confirmed hard-constraint violations in the 120 test scenarios, at least 95% feasible-goal completion within six turns, and fewer questions than the fixed questionnaire without worse task success. These are targets, not observed results. A zero-violation result on a small authored set is not a general safety guarantee. Add a 24-person counterbalanced usability study with three orders per person to measure completion time, corrections and stated satisfaction once the simulation passes its code checks.

## Libraries to reuse

- [XState actors](https://stately.ai/docs/actors) can represent each customer session, invoke the asynchronous Jev request and produce replayable state snapshots. Jev selects legal semantic actions; XState manages transitions and request lifetimes. Add it if customer concurrency or replay complexity justifies it; a reducer is sufficient for the first single-customer version.
- [Motion layout animations](https://motion.dev/docs/react-layout-animations) already fit this React app. Use layout transitions for candidate cards, shared cup-to-counter transitions and ingredient changes. Animation explains the consequences of Jev's decision, without implying that Jev controls pixels or physics.
- [Zod schemas](https://zod.dev/api) already exist in the dependency set. Use discriminated recipe variants and refinements for modifier compatibility, numerical ranges and typed results. Zod validates structural/domain constraints; it does not validate the meaning of extracted customer language.

## Prioritized implementation

1. P1, S: create the common menu and result contract; attach request provenance; add revision guards and separate manual selection from model output.
2. P1, M: add typed hard/soft preferences, exact feasible-recipe filtering, conflict/no-match states and the complete 81-state evaluation. Keep the current authored smoke tests labeled as such.
3. P1, L: build Cafe Jev with a seeded customer, editable recipe, clarifying conversation and receipt replay. Reuse the Adaptive forms matching logic after moving the catalog to one source.
4. P2, M: run the 120-scenario evaluation and order-permutation checks; publish full turns, raw decisions, guarded decisions and separate availability statistics.
5. P2, M: use the same engine for a future "counterfactual cafe" experiment. Compare what changes when a customer changes one preference, an ingredient sells out or the menu introduces an unfamiliar recipe. This tests whether Jev adapts to facts rather than memorizing drink names.

## Investigation log

Reviewed catalog, publication mapping, complete beverage JSONL, runner prompts, actual Beverage component, shared live API and request helper, adjacent menu/filter implementation, and package dependencies at checkout `4c0c40d5a551c498e4e701a17d990e1e78462dc0`. Searched test files and found no beverage-specific tests. A first count script assumed failed rows retained request text; case 12 does not, so the final probe explicitly separates failed and completed records. Measured template baseline accuracy, duplicate text, confidence saturation and exhaustive finite-state coverage. Checked official XState, Motion and Zod documentation. No browser session, paid model call, app edit or deployment was performed for this audit.
