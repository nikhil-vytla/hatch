mutants: 229 (224 with an observable difference, 5 likely equivalent); legit proposals rejected: 0; 111804 ms

| class | mutants | static | invariants | ratchet | properties | fuzz | traces | goals | all safety layers | + goals | missed, but surfaced to the user | missed, silent |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arith | 8 | 0% | 25% | 25% | 25% | 13% | 0% | 100% | 63% | 100% | 0 | 0 |
| logical | 16 | 0% | 13% | 38% | 6% | 13% | 0% | 94% | 50% | 100% | 0 | 0 |
| constant | 12 | 0% | 0% | 8% | 8% | 0% | 0% | 67% | 17% | 67% | 0 | 4 |
| line-delete | 31 | 0% | 6% | 35% | 13% | 6% | 0% | 90% | 52% | 97% | 0 | 1 |
| stray-write | 10 | 0% | 100% | 40% | 0% | 30% | 0% | 100% | 100% | 100% | 0 | 0 |
| hang | 10 | 10% | 100% | 40% | 30% | 100% | 40% | 100% | 100% | 100% | 0 | 0 |
| relational | 5 | 0% | 0% | 20% | 0% | 0% | 0% | 20% | 20% | 40% | 1 | 2 |
| drive-by | 128 | 0% | 20% | 88% | 11% | 79% | 80% | 2% | 93% | 93% | 0 | 9 |
| callee-rename | 4 | 100% | 0% | 75% | 25% | 0% | 0% | 100% | 100% | 100% | 0 | 0 |
| ALL | 224 | 2% | 23% | 64% | 12% | 53% | 47% | 39% | 78% | 92% | 1 | 16 |

Caught by exactly one layer (that layer's unique contribution):
  static: 0
  invariants: 0
  ratchet: 2
  properties: 0
  fuzz: 3
  traces: 3
  goals: 32

Cumulative, cheapest first:
  + static     2%
  + invariants 25%
  + ratchet    71%
  + properties 75%
  + fuzz       77%
  + traces     78%
  + goals      92%

Without any example the user confirmed (no ratchet, no goals):
  71%
Without properties either (only machinery that needs nothing from the user: static, invariants, fuzz, traces):
  67%

Contract coverage of the unmutated proposals:
  turn 1 (add stock): uncovered []; 15 fuzz advisories, e.g. ["addItem([], \"x\") leaves stock-shape is false","addItem(true, 0.1) leaves stock-shape is false"]
  turn 2 (sales): uncovered []; 15 fuzz advisories, e.g. []
  turn 3 (low stock): uncovered []; 15 fuzz advisories, e.g. []
  turn 4 (stock value): uncovered []; 32 fuzz advisories, e.g. ["setPrice(null, NaN) leaves prices-shape is false","setPrice(NaN, null) leaves prices-shape is false"]
  turn 5 (restock): uncovered []; 32 fuzz advisories, e.g. []
  turn 6 (normalise names): uncovered []; 32 fuzz advisories, e.g. []

Missed by every layer (real differences):
  turn 2 relational: sell: > -> >= @187
  turn 2 constant: sell: 0 -> 1 @71
  turn 2 constant: sell: 0 -> 1 @113
  turn 3 relational: lowStock: < -> <= @88
  turn 3 constant: lowStock: 5 -> 6 @91
  turn 3 drive-by: sell: constant 0 -> 1 @113
  turn 4 line-delete: setPrice: drop "return price;"
  turn 4 drive-by: sell: constant 0 -> 1 @113
  turn 4 drive-by: lowStock: relational < -> <= @88
  turn 4 drive-by: lowStock: constant 5 -> 6 @91
  turn 5 drive-by: sell: constant 0 -> 1 @113
  turn 5 drive-by: lowStock: relational < -> <= @88
  turn 5 drive-by: lowStock: constant 5 -> 6 @91
  turn 6 relational: sell: > -> >= @207 (surfaced 1 trace diff(s))
  turn 6 constant: sell: 0 -> 1 @91
  turn 6 drive-by: lowStock: relational < -> <= @88
  turn 6 drive-by: lowStock: constant 5 -> 6 @91
