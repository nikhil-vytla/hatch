mutants: 245 (238 with an observable difference, 7 likely equivalent); legit proposals rejected: 0; 60681 ms

| class | mutants | static | invariants | ratchet | properties | traces | goals | all safety layers | + goals | missed, surfaced as diff | missed, silent |
|---|---|---|---|---|---|---|---|---|---|---|---|
| logical | 15 | 0% | 13% | 40% | 33% | 0% | 87% | 60% | 93% | 0 | 1 |
| line-delete | 31 | 0% | 13% | 42% | 42% | 0% | 74% | 74% | 90% | 0 | 3 |
| stray-write | 11 | 0% | 91% | 0% | 0% | 0% | 0% | 91% | 91% | 0 | 1 |
| hang | 11 | 0% | 91% | 45% | 55% | 45% | 91% | 91% | 91% | 0 | 1 |
| arith | 6 | 0% | 0% | 67% | 83% | 0% | 100% | 83% | 100% | 0 | 0 |
| constant | 7 | 0% | 0% | 57% | 86% | 0% | 71% | 86% | 100% | 0 | 0 |
| drive-by | 146 | 0% | 20% | 76% | 53% | 92% | 12% | 99% | 99% | 0 | 2 |
| callee-rename | 4 | 100% | 0% | 50% | 100% | 0% | 100% | 100% | 100% | 0 | 0 |
| relational | 7 | 0% | 0% | 29% | 0% | 0% | 71% | 29% | 71% | 0 | 2 |
| ALL | 238 | 2% | 23% | 62% | 49% | 59% | 35% | 89% | 96% | 0 | 10 |

Caught by exactly one layer (that layer's unique contribution):
  static: 0
  invariants: 10
  ratchet: 4
  properties: 3
  traces: 8
  goals: 15

Cumulative, cheapest first:
  + static     2%
  + invariants 25%
  + ratchet    80%
  + properties 86%
  + traces     89%
  + goals      96%

Without the user's examples (no ratchet, no goals): what invariants, properties and traces catch alone:
  85%

Missed by every layer (real differences):
  turn 5 relational: addExpense: > -> >= @84
  turn 6 logical: setBudget: || -> && @70
  turn 6 line-delete: setBudget: drop "state.budgets = state.budgets || {};"
  turn 6 line-delete: setBudget: drop "state.budgets[category] = amount;"
  turn 6 line-delete: setBudget: drop "return amount;"
  turn 6 stray-write: setBudget: state.cache = {}
  turn 6 hang: setBudget: while (true) {}
  turn 6 drive-by: addExpense: relational > -> >= @84
  turn 7 drive-by: addExpense: relational > -> >= @84
  turn 8 relational: addExpense: > -> >= @90
