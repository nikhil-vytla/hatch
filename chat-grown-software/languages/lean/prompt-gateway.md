## Language: Lean 4 (core only, no Mathlib) — forms are typed functions over a `State`, laws are proved theorems
(Scenario: LLM API gateway. Start the kernel with SCENARIO=gateway.)

Each form is EXACTLY ONE `def` or `theorem` (a helper or a lemma is its own form). Pure and total: no `partial`, `unsafe`,
`IO`, `#eval`, `open`, `set_option`, `instance`, `macro`, `axiom`, `sorry`, `native_decide`, attributes (except `@[simp]`/`@[inline]`).
Recursion must terminate (the termination checker is a gate). Names are snake_case, one component; do not reuse a core name
(`max`, `id`, `lookup`, ...). Helpers are ordinary forms; redefining a name replaces it.

The prelude (already imported) defines:
    structure Call where key : String; model : String; tokens : Nat
    structure State where calls : List Call := []; prices : List (String × Nat) := []; quotas : List (String × Nat) := []
        -- prices: cents per 1000 tokens by model; quotas: tokens by key; association lists (lookup with `List.lookup k l : Option Nat`)
    State.used s key : Nat          -- the key's total tokens
    State.WithinQuota s : Prop      -- ∀ k q, s.quotas.lookup k = some q → s.used k ≤ q
    State.WellFormed s : Prop       -- every call has non-empty key and model and 0 < tokens
Tokens, prices and quotas are `Nat` (JSON whole numbers; a fractional or negative argument is rejected by the boundary).
**Money is `Int` cents**: a function returning `Int` is shown to the user in dollars (1250 -> 12.5). Do all money arithmetic in
integers; to round tokens×price/1000 to whole cents exactly use `(2 * n + 1000) / 2000` on `Nat` n (round half up).

A callable function takes the state first: `def f (s : State) (a : String) (n : Nat) ... : R`.
- Query (does not change state): return `R` directly: `Nat`, `Int`, `String`, `Bool`, `Option R` (`none` = null), `List R`, `List (String × R)` (JSON object).
- Change or throw: return `Except String (R × State)`: `.ok (value, newState)` or `.error "message"` (the call is then a no-op).
- An optional JSON argument is a trailing `(x : Option String := none)`. Extra arguments are an error.
Built-ins: `List.map/filter/foldl/lookup/sum/eraseDups/mergeSort`, `Option.getD`, `String` `=`/`≤`, `decide`, `if ... then ... else`, `match`.

Example (a complete change; both forms load together):
    def usage (s : State) (key : String) : Nat := s.used key
    def set_price (s : State) (model : String) (cents : Nat) : Except String (Nat × State) :=
      .ok (cents, { s with prices := (model, cents) :: s.prices.filter (·.1 != model) })

`laws` entries are `{"name": "...", "check": "<one or more theorems>"}`; the last theorem is the law, earlier ones are lemmas.
The kernel checks the proof against the candidate code and re-checks every law proved so far on every change; a law with
the same name replaces the old one (restate it when you change a function it talks about). A law must mention an app function.
    theorem set_price_returns_the_price (s : State) (m : String) (c r : Nat) (s' : State)
        (h : set_price s m c = .ok (r, s')) : r = c := by
      simp [set_price] at h
      omega
Proof tips: `unfold f at h`, `by_cases`, `simp [f, h, State.used]`, `omega`, `induction l with | nil => .. | cons x xs ih => ..`,
`split at h`, `obtain ⟨a, b⟩ := h`, `List.mem_mergeSort`. Laws worth proving: record_usage keeps `s.WithinQuota` (for every
state that satisfies it) and `s.WellFormed`; set_quota keeps `WithinQuota`; `top_spender` is a key with maximal `cost`.
