mutants: 245 (238 with an observable difference, 7 likely equivalent); legit proposals rejected: 0; 111451 ms

| class | mutants | static | invariants | ratchet | properties | fuzz | traces | goals | all safety layers | + goals | missed, but surfaced to the user | missed, silent |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| logical | 15 | 0% | 13% | 40% | 33% | 7% | 0% | 87% | 60% | 93% | 0 | 1 |
| line-delete | 31 | 0% | 13% | 42% | 42% | 6% | 0% | 74% | 74% | 90% | 0 | 3 |
| stray-write | 11 | 0% | 91% | 0% | 0% | 27% | 0% | 0% | 91% | 91% | 1 | 0 |
| hang | 11 | 0% | 91% | 45% | 55% | 100% | 45% | 91% | 100% | 100% | 0 | 0 |
| arith | 6 | 0% | 0% | 67% | 83% | 0% | 0% | 100% | 83% | 100% | 0 | 0 |
| constant | 7 | 0% | 0% | 57% | 86% | 0% | 0% | 71% | 86% | 100% | 0 | 0 |
| drive-by | 146 | 0% | 20% | 76% | 53% | 95% | 92% | 12% | 99% | 99% | 0 | 2 |
| callee-rename | 4 | 100% | 0% | 50% | 100% | 0% | 0% | 100% | 100% | 100% | 0 | 0 |
| relational | 7 | 0% | 0% | 29% | 0% | 29% | 0% | 71% | 43% | 86% | 0 | 1 |
| ALL | 238 | 2% | 23% | 62% | 49% | 66% | 59% | 35% | 90% | 97% | 1 | 7 |

Caught by exactly one layer (that layer's unique contribution):
  static: 0
  invariants: 7
  ratchet: 4
  properties: 3
  fuzz: 2
  traces: 0
  goals: 15

Cumulative, cheapest first:
  + static     2%
  + invariants 25%
  + ratchet    80%
  + properties 86%
  + fuzz       90%
  + traces     90%
  + goals      97%

Without any example the user confirmed (no ratchet, no goals):
  86%
Without properties either (only machinery that needs nothing from the user: static, invariants, fuzz, traces):
  73%

Contract coverage of the unmutated proposals:
  turn 1 (add expenses): uncovered []; 24 fuzz advisories, e.g. ["addExpense(-1, null) leaves expenses-shape is false","addExpense(0.1, undefined) leaves expenses-shape is false"]
  turn 2 (total): uncovered []; 24 fuzz advisories, e.g. []
  turn 3 (by category): uncovered []; 24 fuzz advisories, e.g. []
  turn 4 (round to cents): uncovered []; 24 fuzz advisories, e.g. []
  turn 5 (validate expenses): uncovered []; 8 fuzz advisories, e.g. []
  turn 6 (budgets): uncovered ["setBudget"]; 25 fuzz advisories, e.g. ["setBudget(NaN, true) leaves budgets-shape is false","setBudget(\"food\", NaN) leaves budgets-shape is false"]
  turn 7 (top category): uncovered []; 25 fuzz advisories, e.g. []
  turn 8 (notes): uncovered []; 15 fuzz advisories, e.g. []

Missed by every layer (real differences):
  turn 5 relational: addExpense: > -> >= @84
  turn 6 logical: setBudget: || -> && @70
  turn 6 line-delete: setBudget: drop "state.budgets = state.budgets || {};"
  turn 6 line-delete: setBudget: drop "state.budgets[category] = amount;"
  turn 6 line-delete: setBudget: drop "return amount;"
  turn 6 stray-write: setBudget: state.cache = {} (+7 fuzz advisories)
  turn 6 drive-by: addExpense: relational > -> >= @84
  turn 7 drive-by: addExpense: relational > -> >= @84
