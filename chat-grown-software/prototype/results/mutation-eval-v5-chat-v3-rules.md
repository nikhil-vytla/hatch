mutants: 245 (238 with an observable difference, 7 likely equivalent); legit proposals rejected: 0; 144811 ms

| class | mutants | static | invariants | ratchet | properties | fuzz | traces | goals | all safety layers | + goals | missed, but surfaced to the user | missed, silent |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| logical | 15 | 0% | 13% | 40% | 33% | 7% | 0% | 93% | 60% | 100% | 0 | 0 |
| line-delete | 31 | 0% | 13% | 42% | 42% | 6% | 0% | 94% | 74% | 100% | 0 | 0 |
| stray-write | 11 | 0% | 100% | 45% | 0% | 27% | 0% | 100% | 100% | 100% | 0 | 0 |
| hang | 11 | 0% | 100% | 45% | 55% | 100% | 45% | 100% | 100% | 100% | 0 | 0 |
| arith | 6 | 0% | 0% | 67% | 83% | 0% | 0% | 100% | 83% | 100% | 0 | 0 |
| constant | 7 | 0% | 0% | 57% | 86% | 0% | 0% | 86% | 86% | 100% | 0 | 0 |
| drive-by | 146 | 0% | 21% | 99% | 53% | 95% | 92% | 15% | 100% | 100% | 0 | 0 |
| callee-rename | 4 | 100% | 0% | 50% | 100% | 0% | 0% | 100% | 100% | 100% | 0 | 0 |
| relational | 7 | 0% | 29% | 43% | 0% | 29% | 0% | 86% | 57% | 100% | 0 | 0 |
| ALL | 238 | 2% | 26% | 78% | 49% | 66% | 59% | 46% | 92% | 100% | 0 | 0 |

Caught by exactly one layer (that layer's unique contribution):
  static: 0
  invariants: 0
  ratchet: 1
  properties: 3
  fuzz: 0
  traces: 0
  goals: 19

Cumulative, cheapest first:
  + static     2%
  + invariants 27%
  + ratchet    86%
  + properties 92%
  + fuzz       92%
  + traces     92%
  + goals      100%

Without any example the user confirmed (no ratchet, no goals):
  88%
Without properties either (only machinery that needs nothing from the user: static, invariants, fuzz, traces):
  75%

Contract coverage of the unmutated proposals:
  turn 1 (add expenses): uncovered []; 24 fuzz advisories, e.g. ["addExpense(-1, null) leaves expenses-shape is false","addExpense(0.1, undefined) leaves expenses-shape is false"]
  turn 2 (total): uncovered []; 24 fuzz advisories, e.g. []
  turn 3 (by category): uncovered []; 24 fuzz advisories, e.g. []
  turn 4 (round to cents): uncovered []; 24 fuzz advisories, e.g. []
  turn 5 (validate expenses): uncovered []; 8 fuzz advisories, e.g. []
  turn 6 (budgets): uncovered []; 25 fuzz advisories, e.g. ["setBudget(NaN, true) leaves budgets-shape is false","setBudget(\"food\", NaN) leaves budgets-shape is false"]
  turn 7 (top category): uncovered []; 25 fuzz advisories, e.g. []
  turn 8 (notes): uncovered []; 15 fuzz advisories, e.g. []

Missed by every layer (real differences):
