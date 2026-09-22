# When should a browser anticipate the next step?

Status: next-wave research direction accepted; protocol proposed, collection and implementation open. Owner: routing/integration with training/runtime and design engineering. This addition does not expand the first release.

## Question

Can Jev infer a useful next browser action from the current page and recent activity, then prepare the next step quickly enough to help? When should it abstain, and does learning that choice improve usefulness over a calibrated confidence threshold?

## Dependencies and evidence

- [Typed decision contract](../roadmap/runtime/contract.ts) for finite choices, distributions, runtime identity, timing and unsupported states.
- [Private extension](../roadmap/decisions/private-extension.md) for browser observation and local execution. It remains a separate runtime decision.
- [Adaptive interfaces](../roadmap-additions-2026-09-21/decisions/adaptive-interfaces.md) for preserving drafts, focus and user control.
- [Useful uncertainty](../roadmap/decisions/useful-uncertainty.md), [Jimothy study](../jev-tools-and-rl-2026-09-22/decisions/jimothy-experiment.md) and [GRPO grader study](../jev-tools-and-rl-2026-09-22/decisions/rl-rubric-grader.md) for related evaluation methods. A browser policy and a rollout grader are different models and experiments.
- [Composite source check](composite-analysis.md) for the motivating research. [Source index](source-index.json) credits the original builders. No Composite implementation or weights have been copied.

## Proposed experience

Start with an inspectable recording and isolated email, flight-search and calendar fixtures. The user can see the current observation, the proposed action and what happened after it. Editing the page or taking over cancels the pending action. A small persistent control pauses anticipation; an inspector holds history and decision details. No modal should interrupt every successful step.

The first useful sequence is email to flight search. In an explicitly enabled preparation mode, the agent can open a search tab, enter grounded travel details, run the search and recommend results with source links. Preserve the email draft and focus by default. Same-tab preparation is a separate option whose draft-preservation behavior must pass tests. Booking, payment, sending messages and other commitments require an explicit user action outside this pilot's executor.

An email saying only "I'll book a flight on Tuesday at 6 pm" is ambiguous. The route, date, time zone and meaning of 6 pm may all be missing. Test that example as an abstention case. A positive synthetic fixture can state "one adult, one way, SFO to SEA, departing October 6, 2026 at or after 6 pm San Francisco time." Recommendations must preserve those constraints and expose missing preferences. Never infer that a booking deadline is a departure time.

## Observation and action contract

The prediction input contains one current observed page and an explicitly permitted prefix of recent session history. Initially that page is the user's active tab. After opening an explicitly owned preparation tab, the executor observes that tab while the email retains foreground focus. The source page remains only in the permitted history; the model does not scan other tabs. It gets no separate task prompt. A task description used to label or grade a fixture is hidden from the predictor and candidate builder.

Version the DOM representation. Retain visible text, accessible roles and names, field relationships, visibility, enabled state and permitted form values. Give targets snapshot-local identifiers. Record tab identity, origin, capture time and a revision. Strip secrets, password/payment fields and sensitive URL parameters before any model input. Treat page text as untrusted content, including instructions that ask the agent to ignore its execution policy.

History records only events before the prediction, with time, tab, actor and a compact observed page summary. Human and agent actions stay distinct. Do not read unrelated tabs, browser-wide history, clipboard or stored credentials. Do not include the future DOM, next-action labels, cursor position or a hidden task goal. Freeze history lengths and sampling rules before comparison. Report absent or inaccessible DOM regions, including uncaptured frames and shadow roots.

Use the existing choice question with action candidates and an explicit `abstain` option. Each candidate is a complete typed operation: method, target or navigation destination, grounded value if needed, tab behavior and preconditions. Values come from visible text or permitted history with source spans and deterministic date normalization. Finite selection does not generate arbitrary text. An optional generative value proposer is a separate condition with its own identity, latency and cost.

Candidate generation uses the same frozen policy across model conditions. Keep an oracle candidate-recall measure using labels only in evaluation. Missing candidates, context overflow and unsupported operations are reported; do not silently trim until the correct action disappears. Declare adapter-specific limits and count abstention against the option limit. The shared default allows 255 options; local adapters may support fewer.

A model abstention is a successful decision selecting `abstain`. Malformed output, inference failure, unsupported input, policy rejection and stale-response cancellation are separate outcomes. Store the full distribution, selected candidate, model and candidate-builder revisions, and end-to-end timing. Keep execution policy outside the classifier.

## Sequential execution

Predict one step, validate it, execute it, observe the resulting page, then predict again. Bind each response to its observation revision and request identity. Recheck target identity, field state, URL and execution permission immediately before acting. User edits, navigation or closure in either the source tab or the owned preparation tab invalidate the episode and pending work. Reset and pause also cancel it. Stop on mismatch rather than trying a nearby element.

Enable automatic preparation only for user-selected origins and operation classes. Restrict navigation destinations, field writes and searches in code. A high score cannot grant permission. Stop repeated actions and set an episode step budget. Abstention waits for a meaningful new observation instead of continuously polling the model. Recovery must avoid duplicate submissions and restore user control without losing a draft.

A real Google Flights adapter follows the fixture study. Its test must identify the actual site revision and supported interaction limits. A recorded fixture is never presented as live Google Flights automation. Local mode stays local; any hosted comparison uses synthetic records or separately opted-in context and records that execution identity.

## Evaluation proposal

Freeze a corpus manifest, transformation versions, splits, labels, sampling opportunities, metrics, search budget and execution limits before fitting. Corpus size and compute budget remain open until the fixture pilot establishes collection cost. The freeze review must state them and a stopping rule; this document is not the frozen protocol.

Use full sessions with meaningful opportunities to act and meaningful opportunities to wait. Human labels include acceptable next actions, acceptable abstentions, ambiguity and action cost. Multiple actions can be reasonable; disagreement goes to adjudication or an explicit indeterminate category. Logged inactivity alone is not proof that abstention was correct. Report indeterminate and unsupported counts in the overall coverage denominator.

Keep users, sessions and related workflow variants together when splitting. Evaluate held-out sites and workflow families separately. Deduplicate adjacent prefixes and generated template variants across splits. Use training data for fitting, validation for model/checkpoint selection, a distinct calibration set for thresholds, and a sealed final test. Fit neither thresholds nor candidate policies on the final test. Repeat selected trainable recipes across three seeds and group uncertainty estimates by independent session or workflow, not individual clicks.

| Condition | Question it answers |
| --- | --- |
| Always abstain; most-common action; deterministic DOM/history rules | Does the model improve useful action coverage beyond simple policies? |
| Hosted Jev, always-select and calibrated-threshold variants | How much do typed classification and a threshold contribute? |
| Local typed readout, frozen versus supervised with abstention examples | Does task adaptation learn a useful rejection policy? |
| Selected local readout plus learned selection or abstention reward | Does learned abstention beat thresholding at matched coverage? |
| General browser model under the same context, candidates and policy | What quality and total cost does this substitution trade? |

Name exact model revisions at freeze. Hosted Jev is an inference condition, not a model whose weights this project can train. If the local model cannot support the candidate/value space, report that result before increasing scope. Start with supervised rejection and calibration. A later RL variant requires a fixed reward table, held-out judging and its own compute budget. Reward complete action correctness, including typed value and tab choice; use cost-sensitive errors and a minimum useful-coverage criterion to detect collapse into always abstaining.

Run paired ablations for current page alone, ordered history, shuffled history and frozen history lengths. Include identical pages preceded by different histories. For classifier-only ablations, derive candidates from the current DOM and fixed action library, without history-derived values, and report that subset's candidate coverage. This prevents candidates from leaking withheld history. A separate end-to-end ablation removes history from both candidate generation and prediction and reports the change in candidate recall. Randomize option order and test batch independence.

| Measurement | Required interpretation |
| --- | --- |
| Action coverage and full-action error among predictions that act | Publish the whole risk/coverage curve, including endpoints. Compare at matched coverage and show the fraction of all opportunities that receive a correct action. |
| Element, method, value, tab and timing correctness | A correct element with a wrong date or value is an incorrect full action. Define acceptable timing windows before testing. |
| Candidate recall, indeterminate labels, unsupported inputs, policy rejections and failures | Keep these denominators visible; also report overall executable coverage after guards. |
| Calibration and cost-weighted error | Freeze the event whose probability is calibrated. Separate raw action probability, learned abstention and post-hoc threshold decisions. |
| Closed-loop task completion, interventions, unwanted actions and draft loss | Run fresh fixture sessions after each agent action. Logged next-page replay is only an offline prediction test. |
| Latency, memory, inference cost and user time saved | Include observation, candidate construction, classification, guards, execution and verification. Report cold/warm and p50/p95 with hardware and concurrency. Measure time saved against a user baseline. |

Start with deterministic fixture checks for dates, fields, draft preservation and prohibited operations. Include background open, fill, search and sourced recommendation while foreground focus stays in the email, plus source-edit cancellation at each step. Adjudicate intent usefulness independently of the predicting model. Report risk on adjudicated labels and bounds that treat acted-on indeterminate labels as all correct or all incorrect. Publish failures and episode traces as well as successes. A later opted-in browser pilot needs its own risk/coverage criterion and confidence interval; favorable fixture accuracy alone cannot authorize it.

[SelectiveNet](https://proceedings.mlr.press/v97/geifman19a.html), by Yonatan Geifman and Ran El-Yaniv, is a reference for learned rejection. [Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web), by the OSU NLP Group and paper authors, can inform a separate instruction-removed derivative. That derivative needs its own labels for ambiguity and waiting. It is not an original Mind2Web benchmark score, and its task prompts must never reach the predictor or candidate builder. Record dataset terms before use; do not republish its held-out data.

## Resolution and open decisions

Add this experiment to the next wave. The proposed direction is current-page/history prediction, a finite action contract, learned abstention comparisons and bounded automatic preparation. Source research is complete for this addition; no browser model has been trained or evaluated here.

Before implementation, resolve the fixture corpus and split manifest, exact model set, candidate/value extraction limits, reward and coverage criteria, local browser adapter, history retention controls and live-pilot scope. Record the frozen protocol review with Fable 5.1 Global through OpenCode/AWS Bedrock. Delivery work belongs in the separate [implementation checklist](IMPLEMENTATION.md).
