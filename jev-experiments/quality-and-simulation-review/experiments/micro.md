# Micro-agent team — dedicated audit

**Verdict: repair. Highest priority: P1.** The record contains one valid beverage recommendation, one unsupported request and one route-stage provider failure. It demonstrates bounded typed composition, not reliable end-to-end task completion. Live search exposes an internal document ID as the answer, and the recorded checker lacks the menu facts needed to independently validate its successful drink example.

Paths are relative to `jev-experiments/`. Reproduce with `bun jev-experiments/quality-and-simulation-review/probes/micro.ts`. The probe reads complete records/wire attempts and executes actual callbacks with controlled stage responses; it makes no browser or model calls.

## Current composition and evidence

The Python flow routes to find_policy, choose_drink or unsupported. A supported route calls one bounded helper; search joins retained passage text, while beverage returns a selected menu ID. Both supported and unsupported paths then request support/completeness judgments (`src/jev_lab/compositions.py:457`). These helpers ask Jev about supplied static data; they do not change an account, search the live web or place an order.

`experience-prototypes/publication.json:19` uses `../results/micro.jsonl`. Three goals were planned: invoice location, a warm caffeine-free dairy-free unsweetened drink, and an actual password change. The invoice route received only rate limits. The other two complete, with herbal_tea and unsupported respectively. Eleven transport attempts contain five successful calls and six rate limits, producing eleven successful primitive decisions. **Two completed episodes are not two completed user tasks**: declining the password action is an appropriate capability outcome, and its recorded completeness score is 0.42.

The probe independently checks the original menu against the drink's four explicit requirements; herbal_tea is its sole match. Bounded catalogs, unsupported routing, preserved failure rows and a clear UI note that the checker is another judgment are good foundations (`agent-experiments.tsx:397`). The availability widget retains the 3 planned/2 completed denominator, although failed rows are omitted from the example selector (`:71`, `:465`). No micro-specific orchestration tests were found in the current test search.

## Findings

### 1. P1: Live composition is a different pipeline, and search ends at an ID

Recorded routes are find_policy/choose_drink/unsupported; live routes are search/choose_drink/ask (`compositions.py:465`; `agent-experiments.tsx:155`). Recorded search asks thirteen questions and joins retained text; live selection asks one answer choice and stores its ID. The actual callback probe selects `billing`, then confirms both the verifier input and final displayed answer are `billing`, rather than “Invoices are available in Billing > Documents.” (`agent-experiments.tsx:191`, `:377`). The passage is available in the code catalog but never resolved into the answer card.

The live beverage menu uses boolean `hot`; the recorded menu uses categorical `temperature`, and its five-question helper becomes a one-question live selector (`journeys.tsx:6`; `compositions.py:290`). Live ask also skips verification entirely, whereas recorded unsupported is checked. These are protocol changes, not equivalent replays.

Share stage contracts and explicit versions. Store a canonical answer with selected ID, resolved text/properties and evidence references; send the same answer to the checker and renderer. Keep an unsupported capability separate from a request that more context could resolve. Preserve old recordings under their original protocol.

### 2. P1: The recorded checker sees earlier model opinions without the original facts

The saved beverage checker receives `tool_result`, including the selected drink, its probability 1 and earlier model judgments, but no original menu (`compositions.py:482`; exact local request captured in `probes/micro.json`). It returns support 0.98 and completeness 0.97. The selected drink is correct under the independent code check, but these scores cannot establish that the checker could catch a wrong recommendation or a changed menu.

Pass exact source facts, constraints, answer text and versioned tool receipts. Keep prior model probabilities out of the primary independent-check condition; add a separate ablation if their influence matters. Code can enforce explicit menu properties and valid source IDs; Jev can judge semantic relevance and unstated nuance. Preserve the UI's existing warning that a second model judgment is not an independent guarantee.

### 3. P1: Successful stages are lost if a later stage fails, and stale pipelines can replace a new goal

Live mode keeps the complete pipeline in local variables and calls `setRow` only after verification (`agent-experiments.tsx:151`, `:199`). A controlled verifier failure after route and answer succeeds leaves the previous row as the only stored result. The shared wrapper can show the error but cannot expose or resume those completed stages. The recorder similarly reduces a failed episode to goal/error (`compositions.py:507`).

A second probe starts the invoice pipeline, selects the unsupported password example while it runs, then completes it. The selector/editor remain on the password task while the selected result becomes invoice/billing. Each stage consistently captured the old goal, which is good internally, but there is no generation guard preventing it replacing the active episode.

Checkpoint append-only stage events with episode/goal/catalog hashes. Record route, tool input/result and checker independently; on transient failure resume only unfinished compatible work. Changing the goal invalidates commit authority for all in-flight stages. Show pending, completed, failed and skipped stages without implying three steps ran when ask returned immediately.

### 4. P2: “Ask” provides no question or continued conversation

The live ask branch returns More context needed and stops after one routing call (`agent-experiments.tsx:162`). There is no selected missing-field question, answer control or accumulated dialogue. The generic goal editor merely starts a new run. For a genuinely unsupported request such as changing an account password, asking for more context is also the wrong capability explanation.

Use separate needs-context and unsupported outcomes. Let Jev choose a missing field from an allowed question catalog, render that question and preserve the answer in a bounded two-turn state. Code determines which tools exist and whether further context could make the task feasible. A tool outage should have a separate unavailable state rather than being mistaken for ambiguity.

### 5. P2: Three goals do not evaluate composition or failure attribution

Only one supported tool episode completes, and the search path has no completed recorded example. No independent success labels, stage-level accuracy, oracle-route intervention, bad-result fault injection or end-to-end baseline exists (`compositions.py:500`). Route probability details are present in local wire logs but omitted from final published rows; failed-stage identity is not part of the result schema.

Keep this as a three-goal smoke test with explicit coverage. Evaluate route choice, source/menu selection, answer rendering and final outcome separately. Compare a route oracle with normal routing and a deterministic tool-result validator with model checking. Do not treat a large support score, an unsupported refusal or provider completion as task success.

## Richer workflow: a small help desk with a visible case file

Choose a goal, then watch three stateful lanes: dispatch, one bounded tool and evidence check. Each lane opens its exact input/output receipt. An invoice answer displays the cited passage; a drink answer displays its actual properties. Missing preferences produce one specific follow-up question, while unsupported account actions stop with a capability explanation. The visitor can disable a tool, edit a source/menu fact or force an alternative route, then branch the same goal and compare outcomes.

Code owns capabilities, schemas, static tool execution, answer resolution, deterministic validators, stage identity, timing and a maximum of one tool action per turn. Jev interprets the goal, chooses among eligible routes/candidates and judges relevance of actual source evidence. Keep a maximum of two conversational turns; further ambiguity remains unresolved rather than spawning an unbounded loop. Stage failures leave completed receipts inspectable and resumable.

Acceptance: no successful source selection is shown only as an internal ID; every conclusion references its source snapshot; unavailable/unsupported/needs-context are distinct; the checker receives the same resolved answer the user sees; exact menu constraints are checked independently; a stage failure preserves earlier receipts; retries do not duplicate completed stages; and old episodes cannot replace the selected case. Declared tool-step limits must be enforced by code and reported separately from model-call counts.

## Evaluation protocol

Author 200 independent goals across policy lookup, constrained menu choice, clarification and unsupported action: 50 per family. Reserve 40 goals for development and 160 for testing, split by semantic/template family. Two reviewers label admissible routes, required follow-up and expected final outcome; source IDs and explicit menu predicates provide independent answer checks. Include missing/contradictory sources and counterfactual menu facts so labels cannot be inferred from drink names alone.

Run each held-out goal under normal and unavailable-tool conditions with three unchanged passes: **960 first-turn episodes**. At most three calls and four primitive decisions per turn gives an upper bound of **2,880 requests/3,840 decisions**. The forty clarification goals may each receive a predeclared second-turn reply in both conditions and all passes, adding at most **720 requests/960 decisions**. Total planned upper bound: **3,600 requests and 4,800 decisions**, with early stops reported rather than replaced by fake judgments. Stage-local batching can reduce HTTP count only under a separately frozen equivalent evidence encoding. None of these proposed runs were performed.

Compare fixed lexical dispatch plus deterministic validators, oracle routing with the same downstream selector, and full Jev routing/selection with code versus model checks. Label prior-model-score exposure as an ablation instead of silently feeding it to every checker. Paired wrong-answer/source-revision mutations should be included in the checker diagnostic set before claiming error-detection value. Count actual extra diagnostic requests in its own manifest.

Report admissible routing, answer/source correctness, final constraint satisfaction, unsupported handling, useful clarification rate, stage-wise failure attribution, stale commits and resume duplication. Give both all-planned and completed-only outcomes, and publish latency/cost per stage and episode. Use paired bootstrap intervals clustered by 160 independent goals; repeats and two availability states are dependent. The most important gates are zero stale commits, zero duplicate completed tool actions and zero unsupported capability execution in 1,000 offline event schedules across 100 seeds. Accuracy gates should be set on development data and evaluated with uncertainty on the held-out set. No external benchmark or general agent-autonomy claim is made.

## Libraries and next steps

[XState](https://stately.ai/docs/machines) can represent bounded stage transitions, clarification and resumable failure; pin a stable version when adopting it. [Zod](https://zod.dev/basics), already installed, supplies discriminated receipt/answer schemas and argument validation. Jev supplies semantic decisions inside those declared states; the libraries and deterministic validators own the execution contract.

P1/S: unify stage schemas, resolve answer IDs, pass source facts to checking and preserve protocol identity. P1/M: add per-stage checkpoints, cancellation/commit guards and resume tests. P2/M: implement bounded clarification and the case-file UI. P2/M: collect the independent stage/outcome evaluation and source/menu counterfactuals. This receipt model could support broader bounded agent workflows after the two-tool composition is measured reliably.

Investigation: read all three published rows, all eleven wire attempts, Python helpers and the complete live pipeline. Verified the sole beverage answer against the original menu, counted successful stages/primitive judgments, and probed ID rendering, ask termination, final-stage failure and selection during a pipeline. The shared harness was extended to load the real static menu. Verified primary library sources previously in this audit queue. No app edits, browser, paid calls, downloads or commits.
