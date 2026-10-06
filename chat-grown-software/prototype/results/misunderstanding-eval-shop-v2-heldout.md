misreadings: 17 (16 behave differently from the intended program on the probes)

| turn | misreading | self-graded | as-written examples | kernel's questions (user corrected) |
|---|---|---|---|---|
| 1 | add-sets-count: how many = the count on the shelf, not how many arrived | MISSED | goals | goals (3) |
| 1 | add-returns-kinds: returns how many different items there are | MISSED | goals | goals (4) |
| 2 | sell-clamps: "never below zero" as "stop at zero" | MISSED | goals | goals (2) |
| 2 | sell-keeps-one: refuses a sale that would empty the shelf | MISSED | MISSED | MISSED (0) |
| 2 | sell-returns-sold: returns how many were sold | MISSED | goals | goals (2) |
| 3 | low-inclusive: "fewer than 5" as "5 or fewer" | MISSED | MISSED | MISSED (0) |
| 3 | low-not-out: out of stock is not 'low' | MISSED | goals | goals (1) |
| 3 | low-with-counts: the low items with how many are left | MISSED | goals | goals (2) |
| 4 | value-formatted: the worth as display text | properties | properties+goals | properties+goals (5) |
| 4 | value-unrounded: no rounding to cents | MISSED | MISSED | MISSED (0) |
| 4 | value-prices-only: worth = the sum of the prices on the shelf labels | MISSED | goals | goals (3) |
| 5 | restock-to-5: order back up to the low line (5) | properties | properties+goals | properties+goals (1) |
| 5 | restock-under-10: everything under 10, not just the low items | MISSED | MISSED | MISSED (0) |
| 5 | restock-names: just the names to reorder | properties | properties+goals | properties+goals (1) |
| 6 | key-no-trim: capitals only; spaces still matter | MISSED | goals | goals (2) |
| 6 | key-title-case: names are stored as 'Apple' | ratchet+goals | ratchet+goals | ratchet+goals (5) |
| 6 | key-no-migration: new entries only; old names are left as they are (no observable difference) | MISSED | MISSED | MISSED (0) |

| contract | caught (any layer) | by safety layers alone | by goals (this turn's examples) | missed, but a behaviour diff was shown | missed silently |
|---|---|---|---|---|---|
| self | 4/16 (25%) | 4/16 (25%) | 1/16 (6%) | 0 | 12 |
| written | 12/16 (75%) | 4/16 (25%) | 12/16 (75%) | 0 | 4 |
| chat | 12/16 (75%) | 4/16 (25%) | 12/16 (75%) | 0 | 4 |
