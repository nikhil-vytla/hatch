#!/usr/bin/env python3
"""Writes ../reference-gateway.json: the gateway scenario's turns as a correct Lean model would write them, with proved laws."""
import json, os

def turn(intent, scope, forms, laws=()):
    return {"intent": intent, "scope": scope, "forms": forms, "removes": [],
            "laws": [{"name": n, "check": c} for n, c in laws]}

USAGE = "def usage (s : State) (key : String) : Nat := s.used key"
RECORD1 = """def record_usage (s : State) (key model : String) (tokens : Nat) : Except String (Nat × State) :=
  let s' := { s with calls := s.calls ++ [{ key, model, tokens }] }
  .ok (usage s' key, s')"""
USED_APPEND = """theorem used_append_new (s : State) (key model k : String) (t : Nat) :
    ({ s with calls := s.calls ++ [{ key, model, tokens := t }] } : State).used k
      = s.used k + (if key == k then t else 0) := by
  simp [State.used, List.filter_append]
  by_cases h : key = k <;> simp [h]"""
LAW1 = ("record_usage_returns_new_total", """theorem record_usage_returns_new_total (s : State) (k m : String) (t r : Nat) (s' : State)
    (h : record_usage s k m t = .ok (r, s')) : r = usage s k + t := by
  simp [record_usage] at h
  obtain ⟨rfl, rfl⟩ := h
  simp [usage, used_append_new]""")

PUT = """def put : List (String × Nat) → String → Nat → List (String × Nat)
  | [], k, v => [(k, v)]
  | (k', v') :: rest, k, v => if k' = k then (k, v) :: rest else (k', v') :: put rest k v"""
SET_PRICE = """def set_price (s : State) (model : String) (cents : Nat) : Except String (Nat × State) :=
  .ok (cents, { s with prices := put s.prices model cents })"""
# cost is dollars rounded to cents, held as Int cents: round-half-up of (sum tokens*price)/1000 cents, exactly,
# which is Math.round(sum (tokens/1000)*price) without the float error.
COST = """def cost (s : State) (key : String) : Int :=
  let n := ((s.calls.filter (·.key == key)).map (fun c => c.tokens * ((s.prices.lookup c.model).getD 0))).sum
  Int.ofNat ((2 * n + 1000) / 2000)"""
LAW_PRICE = ("set_price_returns_the_price", """theorem set_price_returns_the_price (s : State) (m : String) (c r : Nat) (s' : State)
    (h : set_price s m c = .ok (r, s')) : r = c := by
  simp [set_price] at h
  omega""")

SET_QUOTA = """def set_quota (s : State) (key : String) (tokens : Nat) : Except String (Nat × State) :=
  if usage s key > tokens then .error "already over that quota"
  else .ok (tokens, { s with quotas := put s.quotas key tokens })"""
RECORD3 = """def record_usage (s : State) (key model : String) (tokens : Nat) : Except String (Nat × State) :=
  let s' := { s with calls := s.calls ++ [{ key, model, tokens }] }
  match s.quotas.lookup key with
  | some q => if usage s key + tokens > q then .error "over quota" else .ok (usage s' key, s')
  | none => .ok (usage s' key, s')"""

def quota_law(validated):
    pre = """  unfold record_usage at h
"""
    if validated:
        pre += """  by_cases e1 : key = ""
  · simp [e1] at h
  by_cases e2 : model = ""
  · simp [e1, e2] at h
  by_cases e3 : tokens = 0
  · simp [e1, e2, e3] at h
  rw [if_neg e1, if_neg e2, if_neg e3] at h
"""
    simp = "e1, e2, e3, " if validated else ""
    tail = f"""  split at h
  · next q0 hq0 =>
    split at h
    · simp [{simp}*] at h
    · simp [{simp}*] at h
      obtain ⟨_, rfl⟩ := h
      intro j q hj
      simp at hj
      rw [used_append_new]
      by_cases hk : k = j
      · subst hk
        rw [hq0] at hj; cases hj
        simp [usage] at *; omega
      · simp [hk]; exact hs j q hj
  · simp [{simp}*] at h
    obtain ⟨_, rfl⟩ := h
    intro j q hj
    simp at hj
    rw [used_append_new]
    by_cases hk : k = j
    · subst hk; simp_all
    · simp [hk]; exact hs j q hj"""
    return pre.replace("key", "k").replace("model", "m").replace("tokens", "t") + tail

def law_returns(validated):
    pre = "  unfold record_usage at h\n"
    simp = ""
    if validated:
        pre += """  by_cases e1 : k = ""
  · simp [e1] at h
  by_cases e2 : m = ""
  · simp [e1, e2] at h
  by_cases e3 : t = 0
  · simp [e1, e2, e3] at h
"""
        simp = "e1, e2, e3, "
        pre += "  rw [if_neg e1, if_neg e2, if_neg e3] at h\n"
    body = f"""  split at h
  · split at h
    · simp [{simp}*] at h
    · simp [{simp}*] at h
      obtain ⟨rfl, rfl⟩ := h
      simp [usage, used_append_new]
  · simp [{simp}*] at h
    obtain ⟨rfl, rfl⟩ := h
    simp [usage, used_append_new]"""
    return ("record_usage_returns_new_total", """theorem record_usage_returns_new_total (s : State) (k m : String) (t r : Nat) (s' : State)
    (h : record_usage s k m t = .ok (r, s')) : r = usage s k + t := by
""" + pre + body)

def law_quota(validated):
    return ("no_key_exceeds_its_quota", """theorem no_key_exceeds_its_quota (s : State) (k m : String) (t r : Nat) (s' : State)
    (h : record_usage s k m t = .ok (r, s')) (hs : s.WithinQuota) : s'.WithinQuota := by
""" + quota_law(validated))

LOOKUP_PUT = """theorem lookup_put_self (m : List (String × Nat)) (k : String) (v : Nat) : (put m k v).lookup k = some v := by
  induction m with
  | nil => simp [put, List.lookup]
  | cons p rest ih =>
    obtain ⟨k', v'⟩ := p
    by_cases h : k' = k
    · subst h; simp [put, List.lookup]
    · have : (k == k') = false := by simp; exact fun e => h e.symm
      simp [put, h, List.lookup, this, ih]

theorem lookup_put_ne (m : List (String × Nat)) (k : String) (v : Nat) (j : String) (hj : j ≠ k) :
    (put m k v).lookup j = m.lookup j := by
  have hjk : (j == k) = false := by simpa using hj
  induction m with
  | nil => simp [put, List.lookup, hjk]
  | cons p rest ih =>
    obtain ⟨k', v'⟩ := p
    by_cases h : k' = k
    · subst h; simp [put, List.lookup, hjk]
    · simp [put, h, List.lookup, ih]"""
LAW_SETQ = ("set_quota_keeps_within_quota", LOOKUP_PUT + """

theorem set_quota_keeps_within_quota (s : State) (k : String) (t r : Nat) (s' : State)
    (h : set_quota s k t = .ok (r, s')) (hs : s.WithinQuota) : s'.WithinQuota := by
  unfold set_quota at h
  by_cases h1 : usage s k > t
  · simp [h1] at h
  simp [h1] at h
  obtain ⟨_, rfl⟩ := h
  intro j q hj
  by_cases hk : j = k
  · subst hk
    simp only [lookup_put_self] at hj
    cases hj
    simp [usage] at h1; exact h1
  · rw [lookup_put_ne _ _ _ _ hk] at hj
    exact hs j q hj""")

RECORD4 = """def record_usage (s : State) (key model : String) (tokens : Nat) : Except String (Nat × State) :=
  if key = "" then .error "key required"
  else if model = "" then .error "model required"
  else if tokens = 0 then .error "tokens must be a positive whole number"
  else
    let s' := { s with calls := s.calls ++ [{ key, model, tokens }] }
    match s.quotas.lookup key with
    | some q => if usage s key + tokens > q then .error "over quota" else .ok (usage s' key, s')
    | none => .ok (usage s' key, s')"""
LAW_WF = ("record_usage_keeps_calls_well_formed", """theorem record_usage_keeps_calls_well_formed (s : State) (k m : String) (t r : Nat) (s' : State)
    (h : record_usage s k m t = .ok (r, s')) (hs : s.WellFormed) : s'.WellFormed := by
  unfold record_usage at h
  by_cases e1 : k = ""
  · simp [e1] at h
  by_cases e2 : m = ""
  · simp [e1, e2] at h
  by_cases e3 : t = 0
  · simp [e1, e2, e3] at h
  have key : ∀ q : Option Nat, (match q with
      | some q => if usage s k + t > q then Except.error "over quota" else Except.ok (usage { s with calls := s.calls ++ [{ key := k, model := m, tokens := t }] } k, { s with calls := s.calls ++ [{ key := k, model := m, tokens := t }] })
      | none => Except.ok (usage { s with calls := s.calls ++ [{ key := k, model := m, tokens := t }] } k, { s with calls := s.calls ++ [{ key := k, model := m, tokens := t }] }))
        = Except.ok (r, s') → s' = { s with calls := s.calls ++ [{ key := k, model := m, tokens := t }] } := by
    intro q hq
    cases q with
    | none => simp at hq; exact hq.2.symm
    | some q =>
      by_cases hc : usage s k + t > q
      · simp [hc] at hq
      · simp [hc] at hq; exact hq.2.symm
  have hs' := key _ (by simpa [e1, e2, e3] using h)
  subst hs'
  intro c hc
  simp at hc
  rcases hc with hc | rfl
  · exact hs c hc
  · exact ⟨e1, e2, Nat.pos_of_ne_zero e3⟩""")

BEST_OF = """def best_of : List (String × Int) → Option (String × Int)
  | [] => none
  | p :: rest =>
    match best_of rest with
    | none => some p
    | some q => if q.2 > p.2 then some q else some p"""
TOP = """def top_spender (s : State) : Option String :=
  let keys := (s.calls.map (·.key)).eraseDups.mergeSort (fun a b => decide (a ≤ b))
  (best_of (keys.map fun k => (k, cost s k))).map (·.1)"""
LAW_TOP = ("top_spender_is_a_max", """theorem best_of_none (l : List (String × Int)) (h : best_of l = none) : l = [] := by
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

theorem top_spender_is_a_max (s : State) (t : String) (h : top_spender s = some t) :
    (∃ c ∈ s.calls, c.key = t) ∧ ∀ c ∈ s.calls, cost s c.key ≤ cost s t := by
  unfold top_spender at h
  simp only [Option.map_eq_some_iff] at h
  obtain ⟨⟨t', v⟩, hb, rfl⟩ := h
  obtain ⟨hmem, hmax⟩ := best_of_spec _ _ hb
  simp [List.mem_mergeSort] at hmem
  obtain ⟨k, hk, rfl, rfl⟩ := hmem
  refine ⟨?_, ?_⟩
  · simpa using hk
  · intro c hc
    exact hmax (c.key, cost s c.key) (by simp [List.mem_mergeSort]; exact ⟨c.key, ⟨c, hc, rfl⟩, rfl, rfl⟩)""")

turns = [
    turn("usage", ["record_usage", "usage", "used_append_new"], [USAGE, RECORD1, USED_APPEND], [LAW1]),
    turn("prices", ["set_price", "cost", "put"], [PUT, SET_PRICE, COST], [LAW_PRICE]),
    turn("quotas", ["set_quota", "record_usage"], [SET_QUOTA, RECORD3], [law_returns(False), law_quota(False), LAW_SETQ]),
    turn("validation", ["record_usage"], [RECORD4], [law_returns(True), law_quota(True), LAW_WF]),
    turn("top spender", ["top_spender", "best_of"], [BEST_OF, TOP], [LAW_TOP]),
]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "reference-gateway.json"), "w") as f:
    json.dump({"turns": turns}, f, indent=1, ensure_ascii=False)
print("wrote reference-gateway.json")
