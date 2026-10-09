## Writing forms for the Clojure kernel

Each form is exactly ONE `(defn name [params] body...)` as text: no `def`, `ns`, `declare`, comments-only forms, or
top-level calls. Several forms per change are fine (helpers too). Names are snake_case (`add_expense`) or kebab-case
(`add-expense`); both spellings refer to the same function, and `add_expense` is the name users call. A form can use
multiple arities: `(defn f ([a] ...) ([a b] ...))`. Redefining a function replaces it everywhere (late-bound).
Do not give a function a name that clojure.core already has (`count`, `max`, `update`, ...).

### State
State is an immutable Clojure map with STRING keys exactly like the JSON (keywords will not work):
`{"expenses" [{"amount" 12.5 "category" "food" "note" "x"}] "budgets" {"food" 15}}`. Either top key may be missing.
- `(state)` returns the current state map. Read with `(get (state) "expenses")`, `(get-in (state) ["budgets" c])`.
- `(swap-state! f & args)` sets the state to `(apply f (state) args)` and returns it, like `swap!`:
  `(swap-state! update "expenses" (fnil conj []) {"amount" a "category" c})`, `(swap-state! assoc-in ["budgets" c] n)`.
- Only change state with `swap-state!`; the data is persistent, so a call that throws leaves no trace.
- Never put keys other than "expenses"/"budgets" in the state; never store NaN/keywords/sets (use strings, vectors, maps).

### Values
JSON maps to Clojure natively: object -> map with string keys, array -> vector, string, number, true/false,
null -> nil. A function returns a JSON-shaped value: maps with string keys (`{"food" 19.75}`), vectors/lists,
numbers, strings, booleans, nil (= null). Return `(vec (sort ...))` for sorted lists. Call other app functions
directly: `(by_category)`.

### Errors
`(throw (ex-info "amount must be positive" {}))`. `(try ... (catch Exception e ...))` is allowed (Exception only).

### What is allowed
Only a vetted slice of clojure.core: arithmetic and comparison (`+ - * / quot rem mod inc dec max min abs = == < >`),
`let if when cond case and or not loop recur fn for doseq dotimes ->  ->> as-> some-> cond->`, collections
(`get get-in assoc assoc-in dissoc update update-in conj into merge select-keys keys vals count first last nth
map filter remove reduce reduce-kv sort sort-by group-by frequencies distinct take drop vec set mapv ...`), `str format
subs`, plus `round floor ceil` (return doubles; `(round x)` is Math.round), bounded `range`/`(repeat n x)`, `join
lower-case upper-case trim blank?`. NOT allowed: `def`, `eval`, `atom`, `println`, `slurp`, Java interop (`.`, `new`,
`Math/abs`, `Foo/bar`), qualified symbols, `#=`, `println`. Unknown symbols are rejected before anything runs.
Loops get a 1 s budget; infinite sequences (`(range)`, `iterate`, `cycle`) are unavailable.

### Gotchas
- Round money with `(/ (round (* x 100)) 100)` (the `/` of doubles gives a double; never a ratio).
- Use `==` to compare numbers (`(= 0 0.0)` is false); `(sort [])` is `()`, fine as an empty array.
- `(:amount e)` does NOT work on string keys: write `(get e "amount")`.
- Do not add a `"note"` key unless a note was given (invariant: only amount, category, note).

### Example
```clojure
(defn add_expense [amount category]
  (when-not (and (number? amount) (pos? amount)) (throw (ex-info "amount must be positive" {})))
  (swap-state! update "expenses" (fnil conj []) {"amount" amount "category" category})
  (count (get (state) "expenses")))
```
