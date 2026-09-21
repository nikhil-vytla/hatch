# Preference explorer

Verdict: repair. Highest priority: P1. The sliders correctly recompute a weighted index over fixed Jev assessments. The experiment needs honest ties, visible score evidence and a controlled assessment study before its highlighted winner can support a recommendation claim.

## Current behavior and evidence

The catalog at `experience-prototypes/src/catalog.ts:133` asks how a recommendation depends on the visitor's priorities. `src/misc.tsx:211` uses the first row containing assessments, initially weighted usefulness 3, novelty 2, ease 2 and shareability 1. Code calculates the weighted average of scores divided by two, sorts it and highlights the first item. Sliders perform no model calls; the UI explains that scores stay fixed.

The recorded task evaluates Pocket tutor, Living atlas and Citation checker. Jev supplies four ordinal rubric scores plus one missing-evidence judgment per option. Each rubric has three levels, at `src/jev_lab/pilots.py:317`. Code performs weighted ranking, Pareto-dominance checks and a weight-times-uncertainty question heuristic, at line 283. The saved note explicitly disclaims an objectively correct preference ranking.

The component is unchanged from frozen `4c0c40d`. Shared `readRecord` decodes the published `../results/decisions.jsonl` into 20 attempted cases, 18 completed cases, 216 criterion scores and 54 missing-evidence judgments. Cases 5 and 17 fail with HTTP 429. There are only six distinct ordered input sets and four distinct evidence-content sets. Every completed equal-weight ranking selects Pocket tutor. Transport records 40 attempts, comprising 18 HTTP 200 and 22 HTTP 429. Successful-attempt p50 is 334 ms; logical-request p50 including retries but excluding queue wait is 10.48 seconds. Global budget totals are not this experiment's marginal cost.

The component shows only case 0. Its default weights give Pocket tutor 69.875, Citation checker 56 and Living atlas 54.4375 on the displayed 0 to 100 index. That differs from the recorded equal-weight ranking because the chosen UI weights differ, not because of an arithmetic bug. The probe exercises all 6^4 = 1,296 integer slider configurations. For the 1,295 nonzero settings, there are 832 unique wins for Pocket tutor, 450 for Living atlas, 12 for Citation checker and one true tie. These counts describe the uniform integer grid, not a distribution of real user preferences.

Strengths are explicit separation of model assessment from weighted computation, visible source evidence, editable priorities, and an inspectable/exportable ranking. Source rubrics are concrete enough to audit. Recorded confidence, missingness, dominance and repeated conditions provide useful material for a stronger review interaction.

## Findings

### P1: Zero weights and ties still produce an unsupported winner

`misc.tsx:228` substitutes a denominator of one when all weights are zero. Every option then scores zero, but line 244 still highlights the first item as winner. The actual slider probe reproduces this for Pocket tutor. The Python runner uses equal weights when the total is zero, at `pilots.py:285`, so the two interfaces implement different zero-weight meanings. Across the full slider grid, two settings have a mathematical tie including all-zero, and 24 settings give the top two options the same displayed rounded number while only one is highlighted.

Choose one explicit zero-weight policy, preferably “set a priority to rank.” Share a ranking function, represent ties, and show enough precision or margin information to explain near ties. Stable sorting is a layout rule, not a preference judgment. A zero-score winner should not appear authoritative merely because its input row comes first.

### P1: The user cannot inspect or repair the assumptions that determine the ranking

`misc.tsx:213` takes only the first successful row. It does not expose other evidence conditions, failures or case selection. The bars divide scores by two at line 255 but display neither the rubric levels nor the raw probability distributions. Confidence and `missing_probability` remain inside the JSON inspector's `ranked` objects, but do not trigger a review interaction. The recorded `next_question` and dominance results are unused.

The visitor can express values but cannot correct an assessment, add evidence or answer the question that might change the result. Show criterion definitions, supporting text and an explicitly labeled assessment alongside editable facts and human overrides. Make assessment changes versioned, preserving the original Jev result. Expose the remaining cases and provider failures. If a question is suggested by weight times uncertainty, retain the runner's honest heuristic label; do not rename it expected information gain without an outcome model.

### P1: The recording confounds changed evidence with input position

At `pilots.py:377`, the working-prototype sentence is added to item `i % 3`. Line 381 rotates that same item into first position. Thus every augmented option is also first, in every recorded evidence-update condition. Repeats cannot separate responsiveness to new evidence from position effects. The three baseline cases vary order once each; for identical Citation checker evidence, ease ranges from 1.13 to 1.57. That is an observed 0.44 spread, not a causal estimate of order bias because sampling variation was not held apart.

Cross evidence changes, all six permutations of three options, and repeats independently. Keep IDs stable but also include name/ID masking as a separate condition if measuring identity bias. Record failed cases with their exact input snapshots. Compare matched before/after scores and decision boundaries, not only whether the top item happens to remain Pocket tutor.

### P1: An ordinal assessment index is treated as precise utility without validation

The three rubric categories are ordered descriptions, such as moderate versus straightforward prototype effort. The code averages their numeric positions and permits compensation across all four criteria. That is a declared additive modeling assumption, not measured utility. A 70 index does not mean a 70% chance of project success, and the raw model confidence is not independently calibrated outcome uncertainty. The current claims are cautious, but the rounded large number and winner styling hide this distinction.

Label the result “weighted rubric index,” expose criterion scaling and sensitivity, and let users impose noncompensable constraints such as a deadline before ranking. Independently check evidence-to-rubric assessment. Use user-specified utility or observed task outcomes only when evaluating decision quality; do not declare a universal correct ranking for subjective priorities. Report uncertain score ranges as assumptions or observed repeat variation, with their source, rather than manufacturing precise confidence intervals from provider confidence.

## A richer decision session

The visitor chooses a prototype for a one-week workshop. They review source-backed assessments, set a strict time constraint and then move soft priorities. The system separates ineligible options, displays a breakdown of weighted contributions and shows where two candidates exchange rank. A visitor asks what evidence would distinguish the top two. They add a validated prototype-status note, inspect Jev's proposed assessment changes, override an unsupported novelty judgment, and save the final choice with their reasons. Switching priorities preserves assessments; changing evidence invalidates only affected assessments.

State contains stable options, evidence versions/spans, rubric versions, raw model assessments, manual overrides, hard constraints, preference weights, a calculation version and saved scenarios. Jev maps supplied evidence to bounded rubric outcomes and flags absent support. Code handles constraints, weighted contributions, tie sets, dominance, break-even points and sensitivity sweeps. It proposes a question only when plausible answers could change the ranking or resolve a mandatory constraint. Pending answers are tied to evidence/rubric revisions. A failure keeps the last reviewed assessment visible with its status and never substitutes zero silently.

Accept when zero preferences have no winner, ties remain ties, scores/rubrics/evidence are traceable, manual overrides survive later unrelated work, irrelevant evidence changes cannot mutate unrelated assessment cells, and saved scenarios replay the exact same ranking. Every highlighted winner should name the assumptions under which it wins. The visitor still owns the final choice.

## Evaluation

First exhaust the current 1,296 weight settings with no model calls, checking zero handling, ties, weight-scaling invariance, Pareto consistency and exact displayed contribution sums. Compare the UI and runner with the same utility specification. Current results establish only arithmetic sensitivity on one selected assessment row.

Author 24 development and 120 held-out decision dossiers, each with three options and four criteria. Use six strata of 20 covering clear tradeoffs, near ties, Pareto dominance, missing/contradictory evidence, hard constraints and evidence updates. Two independent annotators label evidence-supported rubric categories and acceptable unknown outcomes, with adjudication before predictions. For subjective criteria permit disagreement/intervals rather than forcing a unique gold score. Keep dossier templates separate across splits.

For the held-out study, cross all six option orders, two matched evidence versions and two repeats. This requires **120 × 6 × 2 × 2 = 2,880 logical requests**, each containing 15 judgments, or **43,200 judgments** before retries. Repeat/order scheduling seeds 42 and 43 affect presentation, not an undocumented provider seed. Use the same preserved evidence and rubric definitions for Jev, a frozen keyword/rule assessor and a human-reviewed rubric table. An oracle table passed through the same ranking engine isolates assessment mistakes from arithmetic or preference assumptions. A 12-dossier pilot is a 288-request subset.

Measure evidence-to-rubric agreement, unsupported high assessments, missing-evidence detection, irrelevant-change invariance, matched evidence responsiveness, rank/breakpoint variation across order/repeats, and all-attempt availability. For generated dossiers with independently specified cardinal payoffs and hard constraints, report chosen-option regret; keep this synthetic result separate from subjective dossiers. For subjective choices, use each participant's own declared acceptable outcomes and confidence after reviewing evidence, not the model's preferred ranking.

Use 10,000 paired bootstrap resamples clustered by dossier, retaining all orders/versions/repeats. Report human disagreement and per-stratum coverage. Require exact deterministic replay and zero hard-constraint violations; claim assessment improvement only when the paired interval over the strongest fixed baseline supports it. Twelve participants can complete six counterbalanced cases each, 36 with a manual rubric table and 36 with semantic assistance using frozen outputs, measuring unsupported accepted assessments, correction effort and decision time. This is a small interaction study, not universal preference validation.

No external dataset or official benchmark is claimed. Full authored coverage is feasible without training or weights; annotation effort and future call budget are the blockers. None of these proposed calls or participant tasks were performed by this audit.

## Tools and next steps

[Observable Plot](https://observablehq.com/plot/marks/line) can draw each option's exact weighted-index curve as one priority changes, with ties and break-even points visible. Its charts would present deterministic sensitivity, while Jev remains responsible only for evidence assessment.

[fast-check command testing](https://fast-check.dev/docs/advanced/model-based-testing/) can test scenario edits, stale assessment completions and manual overrides against simple invariants. Use a distinct arithmetic reference and evidence-version model rather than testing the reducer against a copy.

| Priority | Size | Action |
| --- | --- | --- |
| P1 | S | Share zero/tie semantics and expose near-tie margins. |
| P1 | M | Add case/rubric/evidence review and explicit manual assessment overrides. |
| P1 | S | Label the weighted rubric index and distinguish hard constraints from soft weights. |
| P1 | M | Cross evidence updates, order and repeats in the full evaluation. |
| P2 | M | Add contribution and break-even plots plus saved scenarios. |
| P2 | M | Implement evidence questions and update flows after independent assessment checks. |

A follow-up can use the same scenario machinery for a simulated project portfolio with an explicit budget and independently generated payoffs. It should evaluate that simulator's utility function rather than claiming an objective ranking of real creative projects.

## Investigation log

Read catalog, original component, rubric/assessment runner, ranking helper, publication mapping and transport evidence. Decoded records using shared `readRecord`; inspected all 18 successful inputs and their six unique order/content combinations. Ran the Bun probe across every slider combination and checked original-source equality with `4c0c40d`. No dedicated Preference explorer tests were found. Verified official Plot and fast-check docs. No browser, app changes, provider calls or commits.
