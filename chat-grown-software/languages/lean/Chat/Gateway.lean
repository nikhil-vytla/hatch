import Chat.Codec
open Lean (Json JsonNumber)

/-! Prelude of the LLM-gateway scenario (SCENARIO=gateway). Same calling convention as `Chat.Prelude`.
Tokens, quotas and prices (cents per 1000 tokens) are `Nat`; money produced by `cost` is `Int` cents. -/

structure Call where
  key : String
  model : String
  tokens : Nat
  deriving Repr, BEq

structure State where
  calls : List Call := []
  prices : List (String × Nat) := []
  quotas : List (String × Nat) := []
  deriving Repr, BEq

/-- Tokens recorded for a key. -/
def State.used (s : State) (key : String) : Nat := ((s.calls.filter (·.key == key)).map (·.tokens)).sum

/-- Every key with a quota has used at most that quota. -/
def State.WithinQuota (s : State) : Prop := ∀ k q, s.quotas.lookup k = some q → s.used k ≤ q

/-- Every call has a non-empty key and model and positive tokens. -/
def State.WellFormed (s : State) : Prop := ∀ c ∈ s.calls, c.key ≠ "" ∧ c.model ≠ "" ∧ 0 < c.tokens

def Call.toJson (c : Call) : Json :=
  Json.mkObj [("key", Json.str c.key), ("model", Json.str c.model), ("tokens", ToJ.toJ c.tokens)]

def State.toJson (s : State) : Json :=
  Json.mkObj ((if s.calls.isEmpty then [] else [("calls", Json.arr (s.calls.map Call.toJson).toArray)]) ++
    (if s.prices.isEmpty then [] else [("prices", ToJ.toJ s.prices)]) ++
    (if s.quotas.isEmpty then [] else [("quotas", ToJ.toJ s.quotas)]))

def Call.ofJson (j : Json) : Except String Call := do
  let key ← (← j.getObjVal? "key").getStr?
  let model ← (← j.getObjVal? "model").getStr?
  let tokens ← FromJ.fromJ (← j.getObjVal? "tokens")
  pure { key, model, tokens }

def State.ofJson (j : Json) : Except String State := do
  let calls ← match j.getObjVal? "calls" with
    | .error _ => pure []
    | .ok (.arr a) => a.toList.mapM Call.ofJson
    | .ok _ => throw "calls is not an array"
  let prices ← match j.getObjVal? "prices" with
    | .error _ => pure []
    | .ok b => FromJ.fromJ b
  let quotas ← match j.getObjVal? "quotas" with
    | .error _ => pure []
    | .ok b => FromJ.fromJ b
  pure { calls, prices, quotas }

class Ret (α : Type) where run : α → State → Except String (Json × State)
instance [ToJ α] : Ret α := ⟨fun a s => .ok (ToJ.toJ a, s)⟩
instance [ToJ α] : Ret (Except String (α × State)) := ⟨fun r _ => r.map fun (a, s') => (ToJ.toJ a, s')⟩

class Args (α : Type) where run : α → State → List Json → Except String (Json × State)
instance [Ret α] : Args α := ⟨fun a s args => if args.isEmpty then Ret.run a s else .error "too many arguments"⟩
instance [FromJ β] [Args γ] : Args (β → γ) := ⟨fun f s args =>
  match args with
  | [] => (FromJ.fromJ Json.null).bind fun b => Args.run (f b) s []
  | x :: rest => (FromJ.fromJ x).bind fun b => Args.run (f b) s rest⟩

def Fn.run [Args γ] (f : State → γ) (s : State) (args : List Json) : Except String (Json × State) :=
  Args.run (f s) s args
