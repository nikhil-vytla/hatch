# Adaptive forms

Verdict: redesign. Highest priority: P1. The recorded policy is an effective three-question identifier for an existing menu item. It is not yet a complete preference-elicitation form: uniqueness among partially filtered items does not prove that the final item satisfies an unasked hard preference.

## What Jev and code actually do

The catalog at `experience-prototypes/src/catalog.ts:125` asks whether clarification reduces uncertainty with less effort. `src/journeys.tsx:6` defines eight drinks with four Boolean properties. Code enumerates all 3^4 = 81 partial states, computes each state's matching drinks and sends the menu plus those precomputed sets to Jev. One choice question per state asks for an unanswered property that splits the remaining drinks evenly, or `done`/`conflict`, at line 65. The recorder makes one 81-question request, at `scripts/record-journeys.ts:8`.

The visitor follows a saved lookup table. No inference occurs during clicks, and the UI says so at `journeys.tsx:198`. Code independently computes matching drinks on each click. It decides completion and conflict from their count at lines 110 and 121; the model's terminal labels do not control those branches. This is a good execution guard, but it matters when attributing successful termination.

The component and recorder remain unchanged from frozen commit `4c0c40d`. Shared `readRecord` reconstructs 81 answers and 81 matching state records from the published `results/journeys.jsonl`. The audited menu exactly reproduces every saved state. The one recorded request took 638 ms, with one 637 ms successful attempt and no retry. This is policy-preparation time, not per-click latency or an end-to-end user measurement.

The offline probe finds 16 no-match states, 29 singleton states and 36 multi-candidate states. All 81 choices have a valid action type for the prompt's rules. Thirty-five of the 36 question choices achieve the best available split; terminal labels are all correct. Across the whole table, 80/81 choices meet the full best-split/terminal oracle. This is exhaustive coverage of one authored menu, not an external benchmark.

Strengths include a fully inspectable menu, independent filtering, honest recorded-versus-live copy, reversible answer history, and an explicit model-error state rather than a fabricated fallback. The actual callback probe verifies returning from the first answer to the empty state. The normal root policy reaches all eight drinks in three questions, with 15 reachable states including seven question states and eight terminal states.

## Findings

### P1: A singleton candidate is treated as fully established preference fit

At `journeys.tsx:110`, one remaining drink immediately produces “No more questions needed.” The probe exhausts all 16 complete Boolean preference profiles using actual callbacks. Eight profiles correspond to menu items and all eight are identified correctly in three answers. The other eight have no compatible drink, but every one still receives a recommendation after three answers. None reaches the conflict view. For example, cold, caffeine-free and dairy-free leads to lemonade without asking whether sweetness is acceptable.

This is correct for the narrower task “identify an item known to be on the menu.” It fails if the four stated dimensions are latent hard preferences, which is a natural reading of the form. Make the task explicit and distinguish unknown from indifferent. A single candidate should trigger a concise final confirmation of unasked constraints, or continued questioning of required properties. Do not silently relax a hard preference. Let visitors edit any answer and compare the remaining item's full properties before accepting it.

### P1: The current arithmetic task has no demonstrated need for a model

`journeyStates` already supplies the correct candidate set at line 58. Under the prompt's equal-split objective, deterministic code can count yes/no branches for each unanswered field and choose the best split. With eight equally likely existing drinks, three binary questions are the information lower bound. The recorded reachable policy meets that bound, but so does a deterministic tree. There is no measured reduction in effort relative to that baseline.

Forty-five terminal decisions are redundant with the UI's count checks, and 66 of the 81 table states are never reached from the default start under this policy. A synthetic wrong terminal answer in the probe still shows herbal tea because the code controls completion. That is an intentional guard, not proof the model chose a correct terminal action.

Keep deterministic filtering, required-field checks and cost-aware information gain in code. Put Jev where meaning is uncertain: interpret a free-text preference, distinguish a hard constraint from a preference, or select a useful clarification when an expression has multiple meanings. If retaining the existing policy experiment, display its score against the exact deterministic oracle and label the task as menu-item identification.

### P2: One recorded question gives no information, and ordinary interaction hides it

For `s11xx`, hot and caffeinated, espresso and latte remain. The recorded choice is `sweet`, although both are unsweetened; `dairy` separates them exactly. The guard at `journeys.tsx:90` checks only that the property is unanswered and more than one item remains. It accepts the non-splitting question. This state is unreachable from the default tree, so clicking through the normal demo never reveals the defect.

Expose all 81 states or provide a state explorer with candidate counts, legal questions, split sizes, raw decision and best-split alternatives. Preserve the bad choice as evidence. In the identifying task, reject non-splitting questions and record when a deterministic fallback is used. In a full hard-preference task, a non-splitting question may still be necessary to confirm an unmet constraint; do not use one criterion for both tasks. Version the menu, state generator and prompt with the cached table. The current record retains states but no menu snapshot/hash, and the UI always recomputes against imported current menu facts.

## A richer complete form

Start with a visitor saying “Something cold; I avoid caffeine, and dairy is fine but not necessary.” Jev proposes source-backed constraints with explicit hard/soft/unknown status. The visitor can correct them. Code filters the menu and proposes the highest-value unanswered requirement. Jev chooses among bounded clarification intents only when the wording is ambiguous. When one drink remains, a compact review reveals unconfirmed sweetness rather than declaring unconditional success. “No sweet drinks” then produces a genuine no-match state with minimal conflicting constraints and optional explicit relaxation. The visitor can revise any prior answer, compare alternatives and finish with a confirmed result or a recorded no-match outcome.

State includes menu revision, preferences with source spans and strength, unconfirmed requirements, question costs, a versioned inference request, accepted answers, history and terminal outcome. Code owns facts, filtering, conflict sets, stop conditions, legal question choices and state invalidation. Jev owns language interpretation or ambiguity selection, not menu facts or the final match predicate. Failure preserves answers and offers deterministic manual controls. A pending result cannot override a later manual answer or a menu update.

Acceptance criteria are zero confirmed recommendations violating a hard constraint, explicit handling of indifferent and unknown values, recovery from every no-match case, stable back/edit behavior, no repeated answered question, and traceable code-versus-model decisions. Completion means user confirmation of the full relevant result; it does not mean only one row remains. Offer a separate existing-item mode when that is the intended task.

## Evaluation and complete coverage

The present probe covers all 81 partial states and all 16 complete profiles without new calls. Report separately the 8/8 existing-item identification result and 8/16 full-hard-preference compatibility result. Averages over current menu items alone would hide every unsupported preference profile. Also report 35/36 best-split questions and 45/45 terminal labels rather than obscuring question quality in an 80/81 aggregate.

For a fuller finite study, author 12 menu variants with six Boolean attributes and 16 unique items each. Use fixed construction seeds 42 through 53 and independently verify all item facts. Each menu has 729 partial states and 64 complete profiles. Exhaust all **8,748 states and 768 complete profiles**. There are 192 feasible complete profiles and 576 no-match profiles under the all-six-hard interpretation. Score that mode separately from the 192 known-item searches.

Compare prompts supplied with prefiltered candidate sets versus raw menu facts, under two option-order variants. This is 12 × 729 × 2 × 2 = **34,992 choices**. Packing at most 96 state questions per request needs eight requests per menu/condition, or **384 logical requests** before retries. Include only the batch's state descriptions, retain IDs, and verify 100 KB/128-question limits. If byte limits require smaller batches, publish the increased request count. This is future authored evaluation, not a completed run.

For the semantic role, independently annotate 24 development and 240 held-out natural-language preference statements. Two paraphrases per held-out case produce 480 requests with six finite attribute judgments each, or 2,880 choices. Annotators label hard/soft/indifferent/unknown status and evidence spans before viewing predictions; split by phrasing family. The combined plan is **864 logical requests and 37,872 choices** before retries or byte-driven splits. Use the resulting frozen parse outputs in offline journey rollouts rather than paying again for every user-profile simulation.

Baselines are a fixed question order, greedy count/entropy splitting, exact dynamic programming for expected weighted question cost on this small state space, and a deterministic phrase parser with editable extracted constraints. Give every policy the same facts, requirement semantics and question costs. Measure full-constraint satisfaction, no-match recall, unnecessary questions, clarification/parse accuracy, total question cost, repair actions, invalid transitions, and availability with retry-inclusive latency. Information gain assumes a prior over users/items; report uniform and predeclared skewed priors rather than claiming one tree is universally optimal.

Counts are exact for the finite menus. For comparisons across constructed menus, report paired differences per menu and a 10,000-resample menu-clustered interval, clearly limited by twelve authored menus. Cluster paraphrases by original utterance for semantic accuracy intervals. Require zero hard-constraint violations from deterministic acceptance and no silent stale writes in 1,000 offline edit/response schedules. A 12-person counterbalanced study of manual fixed forms versus adaptive forms can measure completion time and correction burden using frozen outputs, without additional inference. Do not equate fewer questions with less effort before measuring it.

No external dataset or official external scoring is claimed. Full enumeration is feasible and cheap once tables are recorded. The blockers are a declared task/stop policy, independently checked facts and language labels, and a future provider-call budget.

## Libraries and next steps

[JSON Forms rules](https://jsonforms.io/docs/uischema/rules/) can show, hide or enable questions from schema-backed data while code keeps the acceptance rules explicit. Handle undefined values deliberately; its rule conditions can match undefined unless configured otherwise. Jev may populate reviewed semantic fields, while schema rules handle visibility.

[XState](https://stately.ai/docs/xstate) can represent asking, reviewing, conflict, completed and pending-interpretation states with explicit events and guards. Pin a stable version before adoption because the current docs also expose a v6 alpha. It becomes useful when arbitrary answer edits and asynchronous interpretation are added; it is unnecessary for the current two-state-hook replay alone.

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Declare known-item versus full-preference semantics and report both complete-profile outcomes. |
| P1 | M | Require confirmation of unasked hard properties and add explicit no-match/relaxation and arbitrary answer editing. |
| P1 | S | Compare the 81-state policy with exact best-split code and expose all state decisions. |
| P1 | M | Move semantic inference to source-backed language/ambiguity handling with revision guards. |
| P2 | S | Version menu/state/prompt evidence together and distinguish raw policy from code guards. |
| P1 | M | Enumerate the full menu suite and independently label the semantic suite before effort claims. |

A follow-up can use the same form state machine for product configuration with compatibility rules. That requires independently declared constraints rather than borrowing the drink menu's simple Booleans.

## Investigation log

Read the catalog, complete unchanged component, recorder and publication mapping. Decoded the original JSONL using shared `readRecord`; compared generated and saved state facts. `probes/journeys.ts` uses Bun to evaluate all decisions and execute actual callbacks for all 16 complete profiles, back navigation and a deliberately altered terminal answer. Verified exact counts and the single non-splitting question. No dedicated journey tests were found. Consulted the official library docs linked above. No app edits, browser runs, model calls or commits.
