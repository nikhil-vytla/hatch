import Lean.Data.Json
open Lean (Json JsonNumber)

-- Money is an Int count of cents everywhere (no alias: omega and simp see through plain Int).

structure Expense where
  cents : Int
  category : String
  note : Option String := none
  deriving Repr, BEq

structure State where
  expenses : List Expense := []
  budgets : List (String × Int) := []
  deriving Repr, BEq

def Expense.ok (e : Expense) : Prop := 0 < e.cents ∧ e.category ≠ ""
def State.WellFormed (s : State) : Prop :=
  (∀ e ∈ s.expenses, e.ok) ∧ (∀ b ∈ s.budgets, 0 ≤ b.2)

instance (e : Expense) : Decidable e.ok := by unfold Expense.ok; infer_instance
instance (s : State) : Decidable s.WellFormed := by unfold State.WellFormed; infer_instance

example : (State.mk [] []).WellFormed := by decide

/-! ## JSON boundary

Every `Int` that crosses the boundary is money in cents: JSON `12.5` <-> `1250`.
`Nat` is a plain JSON integer. Exact decimal arithmetic, no floats anywhere. -/

class FromJ (α : Type) where fromJ : Json → Except String α
class ToJ (α : Type) where toJ : α → Json

def jsonToCents (n : JsonNumber) : Int :=
  -- round(x * 100), halves up, exactly (the reference program's Math.round)
  let p : Int := (10 : Int) ^ n.exponent
  (n.mantissa * 200 + p) / (2 * p)

def centsToJson (c : Int) : Json := Json.num ⟨c, 2⟩

instance : FromJ Int := ⟨fun
  | .num n => .ok (jsonToCents n)
  | j => .error s!"expected a number (money), got {j.compress}"⟩
instance : ToJ Int := ⟨centsToJson⟩
instance : FromJ Nat := ⟨fun j => match j.getNat? with
  | .ok n => .ok n
  | .error _ => .error s!"expected a whole number, got {j.compress}"⟩
instance : ToJ Nat := ⟨fun n => Json.num ⟨n, 0⟩⟩
instance : FromJ String := ⟨fun | .str s => .ok s | j => .error s!"expected a string, got {j.compress}"⟩
instance : ToJ String := ⟨Json.str⟩
instance : FromJ Bool := ⟨fun | .bool b => .ok b | j => .error s!"expected a boolean, got {j.compress}"⟩
instance : ToJ Bool := ⟨Json.bool⟩
instance : ToJ Unit := ⟨fun _ => Json.null⟩
instance [FromJ α] : FromJ (Option α) := ⟨fun | .null => .ok none | j => (FromJ.fromJ j).map some⟩
instance [ToJ α] : ToJ (Option α) := ⟨fun | none => Json.null | some a => ToJ.toJ a⟩
instance [FromJ α] : FromJ (List α) := ⟨fun
  | .arr a => a.toList.mapM FromJ.fromJ
  | j => .error s!"expected an array, got {j.compress}"⟩
instance [ToJ α] : ToJ (List α) := ⟨fun l => Json.arr (l.map ToJ.toJ).toArray⟩
/-- An association list `List (String × α)` is a JSON object. -/
instance [FromJ α] : FromJ (List (String × α)) := ⟨fun
  | .obj o => o.toArray.toList.mapM fun ⟨k, v⟩ => (FromJ.fromJ v).map (k, ·)
  | j => .error s!"expected an object, got {j.compress}"⟩
instance [ToJ α] : ToJ (List (String × α)) :=
  ⟨fun l => Json.mkObj (l.map fun (k, v) => (k, ToJ.toJ v))⟩

def Expense.toJson (e : Expense) : Json :=
  Json.mkObj ([("amount", centsToJson e.cents), ("category", Json.str e.category)] ++
    (match e.note with | some n => [("note", Json.str n)] | none => []))

def State.toJson (s : State) : Json :=
  Json.mkObj ((if s.expenses.isEmpty then [] else [("expenses", Json.arr (s.expenses.map Expense.toJson).toArray)]) ++
    (if s.budgets.isEmpty then [] else [("budgets", ToJ.toJ s.budgets)]))

def Expense.ofJson (j : Json) : Except String Expense := do
  let amount ← j.getObjVal? "amount"
  let category ← (← j.getObjVal? "category").getStr?
  let note ← match j.getObjVal? "note" with
    | .error _ => pure none
    | .ok .null => pure none
    | .ok v => some <$> v.getStr?
  match amount with
  | .num n => pure { cents := jsonToCents n, category, note }
  | _ => throw "amount is not a number"

def State.ofJson (j : Json) : Except String State := do
  let expenses ← match j.getObjVal? "expenses" with
    | .error _ => pure []
    | .ok (.arr a) => a.toList.mapM Expense.ofJson
    | .ok _ => throw "expenses is not an array"
  let budgets ← match j.getObjVal? "budgets" with
    | .error _ => pure []
    | .ok b => FromJ.fromJ b
  pure { expenses, budgets }

/-! ## Calling a form from JSON: the kernel elaborates `Fn.run f` for every `def f (s : State) ...`. -/

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
