# Model router — dedicated audit

**Verdict: repair. Highest priority: P1.** The 20 authored requests all receive their expected handler after one transport failure is recovered. This establishes agreement with simple intent labels, not cheapest capable execution. The live protocol differs from the recorded one, and an old response can replace a newly selected recorded example.

Paths are relative to `jev-experiments/`. Reproduce with `bun jev-experiments/quality-and-simulation-review/probes/routing.ts`. The original probe decodes both result versions and local recorded request bodies, then runs actual UI callbacks with mocked hooks. It makes no provider calls and is not a browser test.

## What currently happens

The seven options are calculator, document search, local writer, Jev judgment, reasoning model, navigation and beverage configuration (`src/jev_lab/compositions.py:30`; `experience-prototypes/src/agent-experiments.tsx:29`). The Python runner passes only the task text and route descriptions, withholding the authored target (`compositions.py:45`). The UI shows a three-node diagram, route label and probability bars; selecting a route does not execute a handler. Its notice correctly limits the claim to handler selection (`agent-experiments.tsx:416`).

The published file is `experience-prototypes/results/routing.jsonl` (`publication.json:26`), with 20 unique texts: two calculator and three for each other class. Original coverage was 19/20, with 19 correct; recovery adds one correct navigation result while retaining the original failure and request hash. The 31 original attempts include 19 successes, 11 rate limits and one timeout response. Recovery has one further rate limit and one success. Do not interpret the recovered 20/20 as the original request availability, or the roughly 88-second row p95 as model inference time. The result distinguishes transport timing from logical duration, and its cumulative budget snapshot covers other experiments too.

The stable closed option set, withheld labels, probability preservation, recovery provenance, selection-only notice and recorded-example controls are useful foundations. Fourteen predictions have selected-class probability exactly 1; six rows' separate confidence field differs from that probability. The classification metrics use the selected probability, not the separate confidence (`src/jev_lab/metrics.py:23`). Neither field is established as calibrated by these twenty easy cases.

## Findings

### 1. P1: Live routing does not run the recorded protocol

The recorded request asks for the cheapest capable handler and explicitly rejects embedded routing instructions (`compositions.py:49`). The UI asks only for the appropriate handler, and all seven descriptions are shortened (`agent-experiments.tsx:254`). The probe compares the actual recorded wire body with the actual live callback payload and confirms both differences.

The saved examples therefore do not measure the protocol a visitor runs. Share a versioned request builder/catalog across recording and live use, store its hash, and show the exact prompt/criteria with each result. If injection resistance is intended, preserve the policy and evaluate attacks rather than inferring it from the instruction alone.

### 2. P1: A late result replaces the selected case

The input and example selector remain editable, while completion unconditionally replaces `row` (`agent-experiments.tsx:261`, `:430`, `:441`). The probe starts calculator example 0, selects classification example 3, then completes the old request. The dropdown/input stay on example 3 while the selected result becomes calculator. The result card correctly retains the older request's text, so this is a selection/result inconsistency, not falsification of its stored input.

Use a request generation tied to the submitted task, catalog version and active example. Clear or explicitly label prior results while a draft is edited; discard late commits after changing examples. Preserve old results in a separate history. No routing-specific UI test was found in the current test search.

### 3. P2: Every input is forced into seven handlers

Neither the recorded nor live schema has clarify, unsupported or unavailable options. The actual callback submits an empty string with the same seven choices; no model outcome for that blank request was measured. The schema also lacks capabilities such as whether documents, a visible page, a local model or an allowed action are available (`agent-experiments.tsx:29`, `:210`).

Validate blank input in code. Represent missing context and unavailable handlers explicitly; add a clarification/unsupported state where the task has no capable option. For multi-intent requests, define whether routing chooses a first step, a plan, or an admissible set. Do not score a single author label as the only correct route without that policy.

### 4. P2: The fixture does not test capability or routing value

Twenty short tasks contain strong terms such as convert, click, latte, classify and draft (`compositions.py:8`). A seven-route keyword rule written after inspecting them reproduces 20/20. This diagnostic is intentionally not a held-out baseline result. The prompt's cheapest-capable goal has no prices, measured handler success or availability state; the runner only measures label agreement.

Keep these as smoke examples. Freeze separate lexical and always-default baselines before a harder held-out set. Distinguish intent accuracy from acceptable-handler coverage and actual outcome/cost regret. Ambiguous cases such as locating a warranty can permit search or navigation depending on available context; supply that context and an explicit policy. A twenty-case reliability curve is descriptive, not a basis for choosing a deployment threshold.

## Richer workflow: a dispatch desk with visible receipts

A request arrives as a card. The visitor enables a small handler catalog, supplies required context and chooses whether to prioritize cost or completion. Jev ranks only the currently eligible handlers, with a visible clarification option. A simulated execution panel then shows an actual deterministic result for arithmetic/search/navigation fixtures or a clearly labeled recorded handler result. The visitor can change availability or one instruction and compare the same request's route, outcome and cost.

Code owns capability filtering, schemas, permissions, execution adapters, deterministic validators, request identity and accounting. Jev interprets the task and selects among supplied candidates; its route is not proof the handler will succeed. Keep `draft → routing → selected → executing → validated/failed/needs-context` separate. A failed handler can offer a declared fallback, without silently replacing the original route. No external actions are required for this sandbox.

Acceptance: an unavailable handler is never executed; blank input triggers no call; stale answers cannot switch the active request; the selected route, attempted handler and validated outcome remain distinct; every output includes its exact request/catalog versions; and ambiguity either permits an annotated set or asks a specified clarification. This is proposed work, not current behavior.

## Evaluation

Author 360 independent task families: 280 clear cases (40 per handler), 40 ambiguous/multi-intent cases and 40 missing-context/unsupported cases. Use 90 for development and 270 held out: 30 clear per handler plus 30 ambiguous and 30 unsupported. Two annotators label required capabilities and admissible routes from explicit handler contracts; resolve disagreement without forcing a unique label where several qualify. Split paraphrase families together.

For each held-out task create three declared handler/context states (all available, cheapest candidate disabled, required context absent). Run three unchanged repetitions per state: **2,430 routing judgments**. Add 270 paired embedded-instruction variants under the full-availability state: **2,700 judgments**, each one logical request before optional native batching. Do not use an injected target to label the attack. Freeze descriptions, ordering, protocol, baselines and split before collection; preserve transport failures and wrong answers separately.

Compare frozen keyword rules, always-default/always-reasoning where eligible, and an oracle based on measured eligible-handler outcomes. For a runnable subset, execute all eligible candidates once per task/state and use exact validators or blind outcome review; report that additional execution budget separately before running. Do not invent cost regret where downstream outcomes were never measured.

Report admissible-route accuracy, macro recall, unsupported detection, clarification burden, repeat/order flips, attack-induced route changes, and completed/attempted coverage. Where execution exists, add task success, invalid dispatches, end-to-end time/cost and regret against the cheapest successful eligible candidate. Use paired bootstrap intervals over the 270 source families, not repetitions. Tune thresholds only on development data. Run 1,000 offline schedules across 100 seeds for edits, example switches, catalog changes and delayed responses, requiring zero stale dispatches. This is authored evaluation; no external split or official benchmark score is claimed, and none of the proposed runs were performed.

## Libraries, priorities and investigation

[XState](https://stately.ai/docs/machines) can make dispatch, clarification, failure and fallback states explicit; pin an adopted stable release because current documentation includes newer material. [Zod](https://zod.dev/basics), already installed, validates handler-specific arguments and result receipts. Neither supplies semantic routing policy or validates task success automatically.

P1/S: share the exact protocol and add response identity guards. P2/S: declare abstention/capabilities and preserve score-field meaning. P2/M: create the held-out set and frozen baselines. P2/M: add bounded handler execution and outcome receipts. A future adaptive router could learn from these receipts only after their outcomes and cost accounting are independently reliable.

Read the complete 20-row original/published evidence, exact local request log, runner, component, recovery code and metric implementation. Counted class coverage/recovery and score-field differences; ran the post-inspection rule diagnostic and actual callback/blank-input probes. Fixed a probe-only missing React.Fragment mock before rerunning successfully. Verified primary library docs. No app edits, browser run, model calls or commits.
