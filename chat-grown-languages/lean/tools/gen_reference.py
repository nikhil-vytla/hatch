#!/usr/bin/env python3
"""Writes ../reference.json: the forms (and proved laws) a correct model would write for each scenario turn."""
import json, os

def turn(intent, scope, forms, laws=(), removes=()):
    return {"intent": intent, "scope": scope, "forms": forms, "removes": list(removes),
            "laws": [{"name": n, "check": c} for n, c in laws]}

ADD1 = """def add_expense (s : State) (amount : Int) (category : String) : Except String (Nat × State) :=
  let s' := { s with expenses := s.expenses ++ [{ cents := amount, category }] }
  .ok (s'.expenses.length, s')"""

COUNT1 = ("add_expense_count", """theorem add_expense_count (s : State) (a : Int) (c : String) (r : Nat) (s' : State)
    (h : add_expense s a c = .ok (r, s')) : r = s.expenses.length + 1 ∧ s'.expenses.length = r := by
  simp [add_expense] at h
  obtain ⟨rfl, rfl⟩ := h
  simp""")

TOTAL2 = """def total (s : State) : Int := (s.expenses.map (·.cents)).sum"""

ADD_TO = """def add_to : List (String × Int) → String → Int → List (String × Int)
  | [], k, v => [(k, v)]
  | (k', v') :: rest, k, v => if k' = k then (k', v' + v) :: rest else (k', v') :: add_to rest k v"""

BYCAT = """def by_category (s : State) : List (String × Int) :=
  s.expenses.foldl (fun m e => add_to m e.category e.cents) []"""

SUM_ADD_TO = """theorem sum_add_to (m : List (String × Int)) (k : String) (v : Int) :
    ((add_to m k v).map (·.2)).sum = (m.map (·.2)).sum + v := by
  induction m with
  | nil => simp [add_to]
  | cons p rest ih =>
    obtain ⟨k', v'⟩ := p
    by_cases h : k' = k
    · simp [add_to, h]; omega
    · simp [add_to, h, ih]; omega"""

def bycat_law(simp_extra):
    return ("by_category_sums_to_total", SUM_ADD_TO + """

theorem by_category_sums_to_total (s : State) :
    ((by_category s).map (·.2)).sum = total s := by
  have key : ∀ (es : List Expense) (m : List (String × Int)),
      ((es.foldl (fun m e => add_to m e.category e.cents) m).map (·.2)).sum
        = (m.map (·.2)).sum + (es.map (·.cents)).sum := by
    intro es
    induction es with
    | nil => intro m; simp
    | cons e rest ih =>
      intro m
      simp [List.foldl, ih, sum_add_to]
      omega
  have := key s.expenses []
  simpa [by_category, total%s] using this""" % simp_extra)

SUM_CENTS = """def sum_cents (es : List Expense) : Int := (es.map (·.cents)).sum"""
TOTAL4 = """def total (s : State) : Int := sum_cents s.expenses"""
TOTAL_EXACT = ("total_is_exact_sum", """theorem total_is_exact_sum (s : State) : total s = (s.expenses.map (·.cents)).sum := by
  simp [total, sum_cents]""")

ADD5 = """def add_expense (s : State) (amount : Int) (category : String) : Except String (Nat × State) :=
  if amount ≤ 0 then .error "amount must be positive"
  else if category = "" then .error "category required"
  else
    let s' := { s with expenses := s.expenses ++ [{ cents := amount, category }] }
    .ok (s'.expenses.length, s')"""

def add_laws(n_arg, n_pat, mk):
    """The three add_expense laws, for a signature with (or without) the note argument."""
    sig = "(s : State) (a : Int) (c : String)" + (" (n : Option String)" if n_arg else "")
    call = "add_expense s a c" + (" n" if n_arg else "")
    return [
        ("add_expense_count", f"""theorem add_expense_count {sig} (r : Nat) (s' : State)
    (h : {call} = .ok (r, s')) : r = s.expenses.length + 1 ∧ s'.expenses.length = r := by
  unfold add_expense at h
  by_cases h1 : a ≤ 0
  · simp [h1] at h
  by_cases h2 : c = ""
  · simp [h1, h2] at h
  simp [h1, h2] at h
  obtain ⟨rfl, rfl⟩ := h
  simp"""),
        ("add_expense_adds_exactly_the_amount", f"""theorem add_expense_adds_exactly_the_amount {sig} (r : Nat) (s' : State)
    (h : {call} = .ok (r, s')) : total s' = total s + a := by
  unfold add_expense at h
  by_cases h1 : a ≤ 0
  · simp [h1] at h
  by_cases h2 : c = ""
  · simp [h1, h2] at h
  simp [h1, h2] at h
  obtain ⟨_, rfl⟩ := h
  simp [total, sum_cents]"""),
        ("add_expense_keeps_state_well_formed", f"""theorem add_expense_keeps_state_well_formed {sig} (r : Nat) (s' : State)
    (h : {call} = .ok (r, s')) (hs : s.WellFormed) : s'.WellFormed := by
  unfold add_expense at h
  by_cases h1 : a ≤ 0
  · simp [h1] at h
  by_cases h2 : c = ""
  · simp [h1, h2] at h
  simp [h1, h2] at h
  obtain ⟨_, rfl⟩ := h
  refine ⟨?_, hs.2⟩
  intro e he
  simp at he
  rcases he with he | rfl
  · exact hs.1 e he
  · exact ⟨by simp; omega, h2⟩"""),
    ]

PUT = """def put : List (String × Int) → String → Int → List (String × Int)
  | [], k, v => [(k, v)]
  | (k', v') :: rest, k, v => if k' = k then (k, v) :: rest else (k', v') :: put rest k v"""
SET_BUDGET = """def set_budget (s : State) (category : String) (amount : Int) : Except String (Int × State) :=
  if amount < 0 then .error "a budget cannot be negative"
  else .ok (amount, { s with budgets := put s.budgets category amount })"""
OVER = """def over_budget (s : State) : List String :=
  let spent := by_category s
  ((s.budgets.filter fun p => ((spent.lookup p.1).getD 0) > p.2).map (·.1)).mergeSort (fun a b => decide (a ≤ b))"""
OVER_LAW = ("over_budget_means_over", """theorem over_budget_means_over (s : State) (c : String) (h : c ∈ over_budget s) :
    ∃ b, (c, b) ∈ s.budgets ∧ b < ((by_category s).lookup c).getD 0 := by
  unfold over_budget at h
  simp [List.mem_mergeSort] at h
  obtain ⟨b, hb, hlt⟩ := h
  exact ⟨b, hb, hlt⟩""")
PUT_LAW = ("set_budget_keeps_state_well_formed", """theorem put_nonneg (m : List (String × Int)) (k : String) (v : Int) (hv : 0 ≤ v)
    (hm : ∀ b ∈ m, 0 ≤ b.2) : ∀ b ∈ put m k v, 0 ≤ b.2 := by
  induction m with
  | nil => intro b hb; simp [put] at hb; subst hb; simpa using hv
  | cons p rest ih =>
    obtain ⟨k', v'⟩ := p
    intro b hb
    by_cases h : k' = k
    · simp [put, h] at hb
      rcases hb with rfl | hb
      · simpa using hv
      · exact hm b (by simp [hb])
    · simp [put, h] at hb
      rcases hb with rfl | hb
      · exact hm _ (by simp)
      · exact ih (fun b hb => hm b (by simp [hb])) b (by simpa using hb)

theorem set_budget_keeps_state_well_formed (s : State) (c : String) (a : Int) (r : Int) (s' : State)
    (h : set_budget s c a = .ok (r, s')) (hs : s.WellFormed) : s'.WellFormed := by
  unfold set_budget at h
  by_cases h1 : a < 0
  · simp [h1] at h
  simp [h1] at h
  obtain ⟨_, rfl⟩ := h
  exact ⟨hs.1, put_nonneg _ _ _ (by omega) hs.2⟩""")

BEST_OF = """def best_of : List (String × Int) → Option (String × Int)
  | [] => none
  | p :: rest =>
    match best_of rest with
    | none => some p
    | some q => if q.2 > p.2 then some q else some p"""
TOP = """def top_category (s : State) : Option String :=
  (best_of ((by_category s).mergeSort (fun a b => decide (a.1 ≤ b.1)))).map (·.1)"""
TOP_LAW = ("top_category_is_a_max", """theorem best_of_none (l : List (String × Int)) (h : best_of l = none) : l = [] := by
  cases l with
  | nil => rfl
  | cons p rest =>
    simp only [best_of] at h
    split at h
    · simp at h
    · split at h <;> simp at h

theorem best_of_spec (l : List (String × Int)) :
    ∀ r, best_of l = some r → r ∈ l ∧ ∀ p ∈ l, p.2 ≤ r.2 := by
  induction l with
  | nil => simp [best_of]
  | cons p rest ih =>
    intro r h
    simp only [best_of] at h
    split at h
    · next hn =>
      have := best_of_none rest hn
      subst this
      simp at h
      subst h
      simp
    · next q hq =>
      obtain ⟨hmem, hmax⟩ := ih q hq
      split at h
      · next hgt =>
        simp at h; subst h
        refine ⟨by simp [hmem], ?_⟩
        intro x hx
        simp at hx
        rcases hx with rfl | hx
        · omega
        · exact hmax x hx
      · next hle =>
        simp at h; subst h
        refine ⟨by simp, ?_⟩
        intro x hx
        simp at hx
        rcases hx with rfl | hx
        · omega
        · have := hmax x hx; omega

theorem top_category_is_a_max (s : State) (t : String) (h : top_category s = some t) :
    ∀ p ∈ by_category s, ∃ v, (t, v) ∈ by_category s ∧ p.2 ≤ v := by
  unfold top_category at h
  simp only [Option.map_eq_some_iff] at h
  obtain ⟨⟨t', v⟩, hb, rfl⟩ := h
  obtain ⟨hmem, hmax⟩ := best_of_spec _ _ hb
  intro p hp
  refine ⟨v, ?_, ?_⟩
  · simpa [List.mem_mergeSort] using hmem
  · exact hmax p (by simpa [List.mem_mergeSort] using hp)""")

ADD8 = """def add_expense (s : State) (amount : Int) (category : String) (note : Option String := none) :
    Except String (Nat × State) :=
  if amount ≤ 0 then .error "amount must be positive"
  else if category = "" then .error "category required"
  else
    let s' := { s with expenses := s.expenses ++ [{ cents := amount, category, note }] }
    .ok (s'.expenses.length, s')"""

turns = [
    turn("add expenses", ["add_expense"], [ADD1], [COUNT1]),
    turn("total", ["total"], [TOTAL2]),
    turn("by category", ["by_category", "add_to"], [ADD_TO, BYCAT], [bycat_law("")]),
    turn("exact cents", ["total", "sum_cents"], [SUM_CENTS, TOTAL4], [TOTAL_EXACT, bycat_law(", sum_cents")]),
    turn("validate expenses", ["add_expense"], [ADD5], add_laws(False, None, None)),
    turn("budgets", ["set_budget", "over_budget", "put"], [PUT, SET_BUDGET, OVER], [OVER_LAW, PUT_LAW]),
    turn("top category", ["top_category", "best_of"], [BEST_OF, TOP], [TOP_LAW]),
    turn("notes", ["add_expense"], [ADD8], add_laws(True, None, None)),
]

def probe(scope, form): return {"scope": scope, "forms": [form]}
probes = {
    "side_effect": probe(["total"], "instance : Add Int := ⟨fun _ _ => 0⟩"),
    "breaks_ratchet": probe(["total"], "def total (s : State) : Int := 0"),
    "breaks_invariant": probe(["add_expense"], """def add_expense (s : State) (amount : Int) (category : String) (note : Option String := none) :
    Except String (Nat × State) :=
  if amount ≤ 0 then .error "amount must be positive"
  else if category = "" then .error "category required"
  else
    let s' := { s with expenses := s.expenses ++ [{ cents := -amount, category, note }] }
    .ok (s'.expenses.length, s')"""),
    "loops": probe(["total"], "def total (s : State) : Int := total s"),
    "calls_missing": probe(["total"], "def total (s : State) : Int := sum_everything s.expenses"),
    "breaks_trace": probe(["total"], """def top_category (s : State) : Except String (Option String × State) :=
  .error "boom\""""),
}

out = {"turns": turns, "probes": probes}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "reference.json"), "w") as f:
    json.dump(out, f, indent=1, ensure_ascii=False)
print("wrote reference.json")
