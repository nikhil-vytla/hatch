## Language: Lean 4 (core only, no Mathlib) — forms are typed functions over a `State`, laws are proved theorems

Each form is EXACTLY ONE `def` or `theorem` (a helper or a lemma is its own form). Pure and total: no `partial`, `unsafe`,
`IO`, `#eval`, `open`, `set_option`, `instance`, `macro`, `axiom`, `sorry`, `native_decide`, attributes (except `@[simp]`/`@[inline]`).
Recursion must terminate (the termination checker is a gate). Names are snake_case, one component; do not reuse a core name
(`max`, `id`, `lookup`, ...). Helpers are ordinary forms; the kernel orders them by use, and redefining a name replaces it.

The prelude (already imported) defines:
    structure Expense where cents : Int; category : String; note : Option String := none
    structure State where expenses : List Expense := []; budgets : List (String × Int) := []   -- association list, insertion order
    State.WellFormed s : Prop   -- every expense has 0 < cents and category ≠ "", every budget ≥ 0 (decidable)
**Money is `Int` cents everywhere.** The JSON boundary converts: 12.5 <-> 1250 (exact decimals, no floats, halves round up).
There is no `Float` in the app. Compare, add and sort cents as Ints (`omega` and `simp` work on them).

A callable function takes the state first: `def f (s : State) (a : Int) (b : String) ... : R`.
- Query (does not change state): return `R` directly. `R` may be `Int` (money), `Nat` (a plain count, JSON integer), `String`,
  `Bool`, `Option R` (`none` = null), `List R` (array), `List (String × R)` (JSON object, e.g. `by_category`).
- Change or throw: return `Except String (R × State)`: `.ok (value, newState)` or `.error "message"` (the call is then a no-op).
- An optional JSON argument is a trailing `(note : Option String := none)`; callers may omit it. Extra arguments are an error.
Built-ins you can rely on: `List.map/filter/foldl/lookup/sum/mergeSort`, `Option.getD`, `String` `=`/`≤`, `decide`, `if ... then ... else`.

Example (a complete change; the first form is a helper, both are loaded together):
    def sum_cents (es : List Expense) : Int := (es.map (·.cents)).sum
    def total (s : State) : Int := sum_cents s.expenses

`laws` entries are `{"name": "...", "check": "<one or more theorems>"}`; the last theorem is the law, earlier ones are lemmas.
The kernel checks the proof against the candidate code and re-checks every law proved so far on every change; a law with
the same name replaces the old one (restate it when you change a function it talks about). A law must mention an app function.
    theorem add_expense_count (s : State) (a : Int) (c : String) (r : Nat) (s' : State)
        (h : add_expense s a c = .ok (r, s')) : r = s.expenses.length + 1 := by
      unfold add_expense at h
      by_cases h1 : a ≤ 0
      · simp [h1] at h
      by_cases h2 : c = ""
      · simp [h1, h2] at h
      simp [h1, h2] at h
      omega
Proof tips: `unfold f at h`, `by_cases`, `simp [f, h]`, `omega`, `induction l with | nil => .. | cons x xs ih => ..`,
`split at h`, `obtain ⟨a, b⟩ := h`, `List.mem_mergeSort`. A function with an optional `note` takes it as an explicit `(n : Option String)` in theorems.
Laws worth proving: by_category values sum to `total s`; add_expense raises `total` by exactly the amount and keeps
`s.WellFormed`; every name in `over_budget s` has spent more than its budget; `top_category` is a maximum.
