# Changes that improve more than one experiment

This is an implementation proposal supported by the dedicated reviews. It does not claim that these changes have shipped.

## Keep the artifact, the decision, and the input in agreement

A visible result should identify the exact submitted input that produced it. Draft edits should not silently inherit an older score. Manual changes need a manual label. Recorded replays need their recorded prompt and schema. A newer session must ignore a late response from an older session.

The current Drink finder makes the problem easy to reproduce. Open its default example and select lemonade manually. The cup changes to lemonade, the request still asks for something warm, and the inspector still shows Jev choosing herbal tea for an older recorded sentence. The browser reproduced this after the source audit found the separate state updates. Music has the same underlying problem in another form: its picture, playback, and exported motif do not describe the same score.

Use a small immutable result envelope with the request revision, input and schema hashes, model/provider identity, full answer, availability status, and source of the action. Rendering and export consume that envelope. Live user data stays in memory by default, exports are deliberate, and credentials never enter the record. Treat a new draft, a manual override, and a new model result as distinct states. This can be ordinary React reducers; a state library is useful when an experiment has several concurrent actors, not mandatory everywhere.

## Build experiences around a real state transition

A useful simulation has an observable starting state, legal actions, an outcome, and a way to try another decision from the same point. Record those pieces once and derive animation, replay, inspection, and metrics from them.

For Café Jev, semantic interpretation chooses preferences and useful questions. Code owns menu facts, inventory, legal recipes, prices, and the receipt. For music, Jev chooses phrase direction, harmonies and instrumentation. Code owns note timing, voicing constraints, scheduling, and export. For an agent checkpoint, Jev assesses whether supplied evidence supports a claim. Code checks which artifacts actually exist and determines whether the proposed next action is executable.

Do not put a solution in the state and then credit the model for choosing it. A preview can reasonably include consequences that the application can compute, but evaluate that preview generator alone as a baseline. Games especially need a comparison of the complete model-plus-code system against the same code without Jev.

## Show whether a visitor can change the outcome

The experiment should make one consequential intervention easy. Swap answer order in JudgeBench. Change a customer's requirement while an order is in progress. Lock the bass line and regenerate only the melody. Remove the evidence that supposedly verifies an agent's claim. Lower a context budget while checking whether the downstream answer remains supported.

Offer replay without credentials, manual intervention, and live use with the visitor's in-memory key. Keep their controls and records distinct. Animate transitions that explain a decision, and provide a reduced-motion equivalent. Remove the permanent layout-study switcher from finished experiences once a layout is chosen; the app currently retains it on 29 routes, and global arrow keys can change layouts outside form controls.

## Use complete benchmarks and meaningful units

Use the official complete held-out split when it is available and fits the decision API. JudgeBench, BANKING77 and CLINC150 have manageable test sets. RewardBench 2 and the Apple Typed Decisions comparison already cover their full selected test sets. Coverage is not a reason to reuse benchmark labels for prompt tuning or to label a modified task as the original benchmark.

Report the official score first, then useful diagnostics. For paired interventions, the original problem is the statistical unit. Do not count swapped answers, repeated calls, or five questions about one case as independent problems. Show paired outcome changes and cluster uncertainty at the appropriate source/case level. For generated fixtures, enumerate finite combinations where practical, then add independently written language and held-out scenario families.

A low inference price is a reason to measure more. Repeat schedules, option orders, seeds and ablations where they expose variance. Avoid spending calls on duplicate easy templates that do not add coverage. Record actual provider usage before quoting cost; a request count is not a billing estimate.

## Recover provider failures without hiding model failures

Maintain a frozen case list and checkpoint each completed response. Retry only transient provider failures under a declared policy. Authentication, malformed requests and context-limit errors require diagnosis, not an endless retry loop. Keep successful wrong answers. Re-running them until they improve changes the experiment.

The default gallery can show completed artifacts, while a compact completeness line reports planned cases, completed cases, and remaining unavailable cases. The evidence record should keep attempt history, final status, and retry-inclusive latency. An incomplete benchmark must remain visibly incomplete even when the currently displayed case succeeded. Quality on completed cases and service availability are separate measures.

## Demonstrate value beyond a schema-valid response

Every review proposes a baseline and an independent outcome. A schema validates shape; it does not establish intent understanding. A deterministic validator that blocks invalid actions improves the application, but it can hide model errors unless raw and guarded outcomes are both reported. A model confidence score is not automatically a calibrated probability of task success.

The smallest useful outcome differs by experiment: source-faithful accepted fields for paste, saved user state for generated UI, user preference for music, completed goals for games, supported claims for verification, and independent held-out task success for training. Put that outcome next to the model's own score so disagreement is visible.
