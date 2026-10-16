# be-ambitious eval results

Model (generator and judge): `opencode/deepseek-v4.1-flash-free`. Generations: 120; rubric grades: 120; pairwise judgements: 136; trigger calls: 60. Total reported cost: 0.0.

## Response length (words)

| Condition | mean | min | max |
|---|---|---|---|
| baseline | 341 | 250 | 482 |
| skill_body | 792 | 87 | 1133 |
| skill_full | 858 | 639 | 1044 |
| baseline_long | 772 | 704 | 856 |

## Rubric (fraction of responses meeting each criterion)

| Criterion | baseline | skill_body | skill_full | baseline_long |
|---|---|---|---|---|
| R1_outcome | 0.93 | 1.00 | 1.00 | 1.00 |
| R2_durable | 0.07 | 0.90 | 0.90 | 0.30 |
| R3_instruments | 0.47 | 0.97 | 1.00 | 0.90 |
| R4_raw | 0.27 | 0.90 | 1.00 | 0.47 |
| R5_premise | 0.30 | 0.80 | 1.00 | 0.43 |
| R6_judge | 0.60 | 0.97 | 1.00 | 0.67 |
| R7_target | 0.17 | 0.73 | 0.90 | 0.20 |
| R8_fields | 0.00 | 0.97 | 1.00 | 0.20 |
| R9_adversary | 0.40 | 0.97 | 1.00 | 0.60 |
| R10_access | 0.40 | 0.97 | 1.00 | 0.57 |
| R11_prompt | 1.00 | 0.97 | 1.00 | 0.97 |
| R12_grounded | 1.00 | 1.00 | 1.00 | 1.00 |
| **overall (95% bootstrap CI)** | 0.47 [0.42, 0.51] | 0.93 [0.86, 0.97] | 0.98 [0.97, 0.99] | 0.61 [0.56, 0.66] |

### Overall rubric score per task

| Task | baseline | skill_body | skill_full | baseline_long |
|---|---|---|---|---|
| crash-fix | 0.31 | 0.94 | 1.00 | 0.58 |
| qbr-deck | 0.53 | 0.97 | 1.00 | 0.53 |
| survey-summary | 0.53 | 0.64 | 0.97 | 0.64 |
| unit-tests | 0.58 | 1.00 | 1.00 | 0.64 |
| launch-email | 0.44 | 0.97 | 0.97 | 0.64 |
| slow-page | 0.67 | 1.00 | 1.00 | 0.83 |
| interview-prep | 0.39 | 0.86 | 0.94 | 0.64 |
| legacy-refactor | 0.47 | 0.97 | 1.00 | 0.56 |
| lit-review | 0.33 | 0.92 | 0.94 | 0.42 |
| hiring-jd | 0.42 | 1.00 | 1.00 | 0.61 |

## Pairwise preference (blind, both presentation orders)

| Comparison | judgements | skill wins | base wins | ties | skill win rate (ties=½) | position-consistent pairs |
|---|---|---|---|---|---|---|
| skill_body vs baseline | 43 | 33 | 10 | 0 | 0.77 | 15/21 |
| skill_full vs baseline | 60 | 52 | 8 | 0 | 0.87 | 24/30 |
| skill_full vs baseline_long | 33 | 26 | 7 | 0 | 0.79 | 9/16 |

## Trigger accuracy

Calls: 60. TP 29, FN 1, FP 0, TN 30. Precision 1.00, recall 0.97, accuracy 0.98.

| Query | expected | fired / samples | chosen instead |
|---|---|---|---|
| I'm going to ask Claude to summarize our churn data. How could I be way more ambitious with that? | yes | 3/3 |  |
| Think bigger: what else could an AI do for our quarterly planning beyond drafting the doc? | yes | 3/3 |  |
| Here's my prompt for refactoring our auth module. Can you upgrade it so I get much more out of the model? | yes | 3/3 |  |
| I feel like I'm only using AI for tiny tasks. What should I be asking it to do for my marketing work? | yes | 3/3 |  |
| Push this plan further. I want the model doing work an expert would actually learn from. | yes | 3/3 |  |
| We're asking an agent to fix crashes one at a time. Is there a higher-level way to frame this? | yes | 3/3 |  |
| What's the most ambitious version of 'write unit tests for billing.py' I could hand an agent? | yes | 3/3 |  |
| Upgrade this request so an AI attacks it like a top data scientist would: 'make a chart of signups by month'. | yes | 3/3 |  |
| I want to stop micro-prompting. How do I give the model the outcome instead of the task? ⚠ | yes | 2/3 | none×1 |
| My team uses Copilot for autocomplete only. What bolder things could we delegate? | yes | 3/3 |  |
| Fix the null pointer exception in OrderService.java line 88. | no | 0/3 | none×2, tdd×1 |
| Summarize this PDF report into five bullet points. | no | 0/3 | pdf×3 |
| Review my branch against main for style issues. | no | 0/3 | code-review×3 |
| Fix the typos and grammar in this prompt but keep the meaning exactly the same. | no | 0/3 | prompt-polish×3 |
| Write a failing test first for the new discount rule, then implement it. | no | 0/3 | tdd×3 |
| What does the Python walrus operator do? | no | 0/3 | none×3 |
| Research the history of the four-minute mile and write it up with sources. | no | 0/3 | research×3 |
| Make this paragraph sound less like ChatGPT wrote it. | no | 0/3 | unslop×3 |
| Convert this CSV of signups into a bar chart by month. | no | 0/3 | none×3 |
| I'm feeling unmotivated about my running goals; any tips? | no | 0/3 | none×3 |
