import Lean.Data.Json
open Lean (Json JsonNumber)

-- Money is an Int count of cents everywhere (no alias: omega and simp see through plain Int).


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

