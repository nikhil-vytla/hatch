misreadings: 21 (21 behave differently from the intended program on the probes)

| turn | misreading | self-graded | as-written examples | kernel's questions (user corrected) |
|---|---|---|---|---|
| 1 | add-returns-expense: returns the recorded expense, not the count | MISSED | goals | goals (4) |
| 1 | add-lowercases: normalizes categories to lower case | MISSED | MISSED | MISSED (0) |
| 1 | add-newest-first: keeps the newest expense first | MISSED | MISSED | goals (2) |
| 2 | total-formatted: the total as display text | MISSED | goals | goals (2) |
| 2 | total-count: how many expenses so far | MISSED | goals | goals (1) |
| 3 | by-category-pairs: a ranked list of [category, amount] | properties | properties+goals | properties+goals (2) |
| 3 | by-category-share: each category's share of the total, in percent | properties | properties+goals | properties+goals (1) |
| 4 | cents-truncate: cut to cents (floor) rather than round | MISSED | MISSED | MISSED (0) |
| 4 | cents-integer: report money as integer cents | ratchet+properties | ratchet+properties+goals | ratchet+properties+goals (1) |
| 5 | validate-negative-only: "zero or less" as "less than zero" | MISSED | MISSED | invariants+goals (1) |
| 5 | validate-skip: ignore bad input instead of throwing | MISSED | goals | goals (7) |
| 5 | validate-undefined-category: "without a category" as "category not given" | invariants | invariants+goals | invariants+goals (2) |
| 6 | budget-at-limit: "over" includes exactly at the budget | MISSED | MISSED | MISSED (0) |
| 6 | budget-accumulates: setting a budget adds to the existing one | MISSED | MISSED | goals (1) |
| 6 | budget-overage: how much over, per category | properties | properties+goals | properties+goals (2) |
| 7 | top-tie-last: ties go to the alphabetically last | MISSED | goals | goals (1) |
| 7 | top-by-count: "spend the most on" as "most often" | properties | properties+goals | properties+goals (1) |
| 7 | top-tie-insertion: ties go to the category seen first | MISSED | goals | goals (1) |
| 8 | note-empty-default: every expense gets a note, empty by default | missed; 5 behavior diff(s) shown | goals | ratchet+goals (2) |
| 8 | note-in-category: the note is folded into the category | MISSED | goals | goals (2) |
| 8 | note-required-text: a note must be text, so a non-string note is dropped silently | MISSED | MISSED | MISSED (0) |

| contract | caught (any layer) | by safety layers alone | by goals (this turn's examples) | missed, but a behavior diff was shown | missed silently |
|---|---|---|---|---|---|
| self | 6/21 (29%) | 6/21 (29%) | 0/21 (0%) | 1 | 14 |
| written | 14/21 (67%) | 6/21 (29%) | 14/21 (67%) | 0 | 7 |
| chat | 17/21 (81%) | 8/21 (38%) | 17/21 (81%) | 0 | 4 |
