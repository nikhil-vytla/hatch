/-
Live kernel for chat-grown software, in Lean 4 (PROTOCOL.md v1).

One process holds a Lean `Environment`. Every accepted change is elaborated by the real Lean frontend in-process
(`IO.processCommands`), compiled to IR, and run with `evalConst` through the interpreter: the world is a live
image, there is no `lean` subprocess. Proved laws are `theorem`s checked by Lean's kernel against that same
environment on every develop.
-/
import Lean
import Chat.Prelude
open Lean Elab

/-! ## evalConst plumbing (unsafe, isolated) -/

abbrev Adapter := State → List Json → Except String (Json × State)
unsafe def evalAdapterImpl (env : Environment) (n : Name) : Except String Adapter := env.evalConst Adapter {} n
@[implemented_by evalAdapterImpl] opaque evalAdapter (env : Environment) (n : Name) : Except String Adapter

/-! ## JSON helpers -/

partial def jsonSame : Json → Json → Bool
  | .num a, .num b => (a.toFloat - b.toFloat).abs ≤ 1e-9
  | .arr a, .arr b => a.size == b.size && (a.zip b).all fun (x, y) => jsonSame x y
  | .obj a, .obj b =>
    let ka := a.toArray.filter (·.1 != "error")
    let kb := b.toArray.filter (·.1 != "error")
    ka.size == kb.size && ka.all fun (k, v) => match b.get? k with | some w => jsonSame v w | none => false
  | a, b => a == b

def sh (j : Json) : String := let s := j.compress; if s.length > 200 then (s.take 200).toString ++ "..." else s

def getStr (j : Json) (k : String) : String := (j.getObjValAs? String k).toOption.getD ""
def getArr (j : Json) (k : String) : Array Json := (j.getObjValAs? (Array Json) k).toOption.getD #[]
def getStrs (j : Json) (k : String) : Array String :=
  (getArr j k).filterMap fun x => x.getStr?.toOption

/-! ## The scenario's three invariants, on JSON states -/

def invariantViolations (s : Json) : List String := Id.run do
  let mut out := []
  let some o := s.getObj?.toOption | return ["state is not an object"]
  for (k, _) in o.toArray do
    if k != "expenses" && k != "budgets" then out := out ++ [s!"known-keys: unexpected key {k}"]
  match s.getObjVal? "expenses" with
  | .error _ => pure ()
  | .ok (.arr es) =>
    for e in es do
      let ok := match e with
        | .obj eo =>
          eo.toArray.all (fun (k, _) => k == "amount" || k == "category" || k == "note") &&
          (match eo.get? "amount" with | some (.num n) => 0 < n.mantissa | _ => false) &&
          (match eo.get? "category" with | some (.str c) => c != "" | _ => false) &&
          (match eo.get? "note" with | none | some (.str _) => true | _ => false)
        | _ => false
      if !ok then out := out ++ [s!"expenses-shape: bad expense {sh e}"]
  | .ok _ => out := out ++ ["expenses-shape: expenses is not an array"]
  match s.getObjVal? "budgets" with
  | .error _ => pure ()
  | .ok (.obj bo) =>
    for (k, v) in bo.toArray do
      match v with
      | .num n => if n.mantissa < 0 then out := out ++ [s!"budgets-shape: budget {k} is negative"]
      | _ => out := out ++ [s!"budgets-shape: budget {k} is not a number"]
  | .ok _ => out := out ++ ["budgets-shape: budgets is not an object"]
  return out

/-! ## Static gate: parse a form and check its shape -/

structure Decl where
  name : Name
  kind : String
  deriving Inhabited

/-- All atoms and identifier names of a syntax tree, in order. -/
partial def tokens (stx : Syntax) : Array (Bool × String × Name) :=
  match stx with
  | .atom _ v => #[(false, v, .anonymous)]
  | .ident _ _ n _ => #[(true, "", n)]
  | .node _ _ args => args.foldl (fun acc a => acc ++ tokens a) #[]
  | _ => #[]

partial def findKind (stx : Syntax) (k : SyntaxNodeKind) : Array Syntax :=
  match stx with
  | .node _ kind args => (if kind == k then #[stx] else #[]) ++ args.foldl (fun acc a => acc ++ findKind a k) #[]
  | _ => #[]

def deniedAtoms : List String :=
  ["unsafe", "partial", "noncomputable", "sorry", "native_decide", "run_tac", "run_cmd", "run_elab", "set_option",
   "open", "implemented_by", "extern", "export", "macro", "macro_rules", "elab", "elab_rules", "syntax", "deriving",
   "attribute", "initialize", "builtin_initialize", "import", "mutual", "namespace", "section", "variable",
   "+native", "unsafe_cast"]
def deniedRoots : List String :=
  ["IO", "EIO", "BaseIO", "ST", "System", "Lean", "unsafeBaseIO", "unsafeIO", "unsafeEIO", "unsafeCast",
   "dbgTrace", "dbgTraceVal", "dbgTraceIfShared", "dbgSleep", "ptrAddrUnsafe", "sorryAx", "_root_", "Task", "Thunk"]
def allowedAttrs : List String := ["simp", "inline", "noinline", "macro_inline", "reducible", "irreducible", "specialize"]

def parseSource (env : Environment) (src : String) : ExceptT String IO (Array Syntax) := do
  let ictx := Parser.mkInputContext src "<form>"
  let pmctx : Parser.ParserModuleContext := { env, options := {}, currNamespace := .anonymous, openDecls := [] }
  let mut ps : Parser.ModuleParserState := {}
  let mut msgs : MessageLog := {}
  let mut out := #[]
  for _ in [0:200] do
    let (stx, ps', msgs') := Parser.parseCommand ictx pmctx ps msgs
    ps := ps'; msgs := msgs'
    if Parser.isTerminalCommand stx then break
    out := out.push stx
  if msgs.hasErrors then
    let first := msgs.toList.find? (·.severity == .error)
    let txt ← match first with
      | some m => pure s!"{m.pos.line}:{m.pos.column}: {← m.data.toString}"
      | none => pure "parse error"
    throw s!"parse error: {txt}"
  return out

def staticShape (env : Environment) (src : String) (kinds : List String) (maxDecls : Nat) :
    ExceptT String IO (Array Decl) := do
  let cmds ← parseSource env src
  if cmds.isEmpty then throw "empty form"
  if maxDecls == 1 && cmds.size != 1 then throw s!"a form must be exactly one definition, found {cmds.size} commands"
  let mut decls := #[]
  for stx in cmds do
    unless stx.getKind == ``Parser.Command.declaration do
      throw s!"not a plain declaration (found {stx.getKind}): only `def` and `theorem` are allowed, no commands, notation, macros, instances or options"
    let inner := stx[1]
    let kind ← match inner.getKind with
      | ``Parser.Command.definition => pure "def"
      | ``Parser.Command.abbrev => pure "def"
      | ``Parser.Command.theorem => pure "theorem"
      | k => throw s!"only `def` and `theorem` are allowed here, found {k}"
    unless kinds.contains kind do throw s!"a {kind} is not allowed here (allowed: {kinds})"
    let nm := inner[1][0].getId
    if nm.isAnonymous || nm.getNumParts != 1 then throw "declaration name must be a simple name"
    if (nm.toString.startsWith "__") then throw "names starting with __ are reserved"
    decls := decls.push { name := nm, kind }
    for (isId, atom, n) in tokens stx do
      if !isId && deniedAtoms.contains atom then throw s!"forbidden keyword `{atom}`"
      if !isId && atom.startsWith "#" then throw s!"forbidden command `{atom}`"
      if isId && deniedRoots.contains n.getRoot.toString then throw s!"forbidden identifier `{n}` (no IO, unsafe or reflection)"
    for a in findKind stx ``Parser.Term.attrInstance do
      let first := (tokens a).find? fun (_, v, n) => v != "" || !n.isAnonymous
      let nm := match first with | some (true, _, n) => n.toString | some (false, v, _) => v | none => ""
      unless allowedAttrs.contains nm do throw s!"attribute `{nm}` is not allowed"
  return decls

/-! ## Elaboration -/

def elabIn (env : Environment) (src : String) : IO (Environment × List String) := do
  let ictx := Parser.mkInputContext src "<form>"
  let opts : Options := Options.empty.setBool `Elab.async false
  let cs := Command.mkState env {} opts
  let st ← IO.processCommands ictx {} cs
  let mut errs := []
  for m in st.commandState.messages.toList do
    let txt ← m.data.toString
    if m.severity == .error then errs := errs ++ [s!"{m.pos.line}:{m.pos.column}: {txt}"]
    else if m.severity == .warning && (txt.splitOn "sorry").length > 1 then errs := errs ++ [s!"uses sorry: {txt}"]
  return (st.commandState.env, errs)

instance : MonadEnv (StateM Environment) := ⟨get, modify⟩

def axiomsOf (env : Environment) (n : Name) : Array Name :=
  ((collectAxioms n : StateM Environment (Array Name)).run' env) |> Id.run

def badAxioms (env : Environment) (n : Name) : List Name :=
  (axiomsOf env n).toList.filter fun a => ![`propext, `Classical.choice, `Quot.sound].contains a

def layerOf (msg : String) : String :=
  if (msg.splitOn "termination").length > 1 || (msg.splitOn "structural recursion").length > 1 ||
     (msg.splitOn "well-founded").length > 1 then "termination" else "static"

/-! ## World data -/

structure Form where
  name : String
  kind : String
  src : String
  deriving ToJson, FromJson, Inhabited

structure Law where
  name : String
  src : String
  deriving ToJson, FromJson, Inhabited

structure Ex where
  fixture : Json
  calls : Array Json
  expect : Json
  deriving ToJson, FromJson

structure Rev where
  id : String
  codeId : String
  dataId : String
  intent : String
  scope : Array String
  asked : Json
  parent : Option String
  changed : Array String
  forms : Array Form
  laws : Array Law
  deriving ToJson, FromJson

structure Trace where
  before : Json
  call : Json
  value : Json
  deriving ToJson, FromJson

structure WorldData where
  generation : Nat := 0
  revCounter : Nat := 0
  revision : Option String := none
  forms : Array Form := #[]
  laws : Array Law := #[]
  examples : Array Ex := #[]
  revisions : Array Rev := #[]
  traces : Array Trace := #[]
  state : Json := Json.mkObj []
  requests : Array (String × Json) := #[]
  deriving ToJson, FromJson

/-- A compiled candidate or live world: the environment after all forms, plus the adapters cache. -/
structure Built where
  env : Environment
  steps : Array (String × Environment)
  defs : Array String
  cache : IO.Ref (RBMap String Adapter compare)
  /-- functions that timed out while this candidate was being judged (later calls to them are not retried) -/
  slow : IO.Ref (Array String)

def adapterName (fn : String) : Name := Name.mkSimple s!"__call_{fn}"

/-- Dependency order: a form comes after the forms whose names it mentions; ties keep the stored order. -/
def orderForms (env : Environment) (forms : Array Form) : IO (Array Form) := do
  let names := forms.map (·.name)
  let mut deps : Array (Array String) := #[]
  for f in forms do
    match ← (parseSource env f.src).run with
    | .error _ => deps := deps.push #[]
    | .ok cmds =>
      let ids := cmds.foldl (fun acc c => acc ++ (tokens c).filterMap fun (isId, _, n) =>
        if isId then some n.getRoot.toString else none) #[]
      deps := deps.push (names.filter fun n => n != f.name && ids.contains n)
  let mut state : Array Nat := Array.replicate forms.size 0  -- 0 new, 1 visiting, 2 done
  let mut out : Array Form := #[]
  for i in [0:forms.size] do
    -- iterative DFS with an explicit stack of (index, next dep position)
    if state[i]! != 0 then continue
    let mut stack : Array (Nat × Nat) := #[(i, 0)]
    state := state.set! i 1
    while !stack.isEmpty do
      let (j, k) := stack.back!
      let ds := deps[j]!
      if k < ds.size then
        stack := stack.pop.push (j, k + 1)
        match names.findIdx? (· == ds[k]!) with
        | some d =>
          if state[d]! == 0 then
            state := state.set! d 1
            stack := stack.push (d, 0)
        | none => pure ()
      else
        stack := stack.pop
        state := state.set! j 2
        out := out.push forms[j]!
  return out

def buildWorld (base : Environment) (forms : Array Form) (prev : Option Built) :
    IO (Except (Array (String × String)) Built) := do
  let ordered ← orderForms base forms
  let mut env := base
  let mut steps : Array (String × Environment) := #[]
  let mut defs : Array String := #[]
  let mut errs : Array (String × String) := #[]
  let mut reuse := prev.isSome
  for f in ordered, i in [0:ordered.size] do
    if reuse then
      match prev with
      | some p => if h : i < p.steps.size then
          if p.steps[i].1 == f.src then
            env := p.steps[i].2; steps := steps.push p.steps[i]
            if f.kind == "def" && env.contains (adapterName f.name) then defs := defs.push f.name
            continue
        | _ => pure ()
      reuse := false
    let (env', es) ← elabIn env f.src
    if !es.isEmpty then
      errs := errs.push (layerOf (String.intercalate "\n" es), s!"{f.name}: {String.intercalate "\n" (es.take 3)}")
      steps := steps.push (f.src ++ "\n-- failed", env)
      continue
    let bad := badAxioms env' (Name.mkSimple f.name)
    if !bad.isEmpty then
      errs := errs.push ("static", s!"{f.name}: depends on forbidden axioms {bad} (sorry, native_decide, ...)")
      steps := steps.push (f.src ++ "\n-- failed", env)
      continue
    env := env'
    if f.kind == "def" then
      let (env2, es2) ← elabIn env s!"def «{(adapterName f.name)}» := Fn.run @{f.name}"
      if es2.isEmpty then
        env := env2
        defs := defs.push f.name
    steps := steps.push (f.src, env)
  if errs.isEmpty then
    return .ok { env, steps, defs, cache := (← IO.mkRef {}), slow := (← IO.mkRef #[]) }
  else return .error errs

/-! ## Running calls (one second each) -/

inductive Outcome where
  | value (v : Json) (s : Json)
  | throws (msg : String) (s : Json)
  | timeout

def Outcome.toJson : Outcome → Json
  | .value v s => Json.mkObj [("value", v), ("state", s)]
  | .throws m s => Json.mkObj [("throws", true), ("error", m), ("state", s)]
  | .timeout => Json.mkObj [("timeout", true)]

def stateJson (orig : Json) (s : State) : Json :=
  let j := s.toJson
  let add (k : String) (e : Json) (j : Json) : Json :=
    if (orig.getObjVal? k).toOption.isSome && (j.getObjVal? k).toOption.isNone then j.setObjVal! k e else j
  add "expenses" (Json.arr #[]) (add "budgets" (Json.mkObj []) j)

def Built.adapter (b : Built) (fn : String) : IO (Option Adapter) := do
  if let some f := (← b.cache.get).find? fn then return some f
  if !b.defs.contains fn then return none
  match evalAdapter b.env (adapterName fn) with
  | .ok f => b.cache.modify (·.insert fn f); return some f
  | .error _ => return none

/-- `none` means the call ran over a second. A runaway thread cannot be killed in Lean; it is abandoned. -/
def callOnce (b : Built) (st : State) (fn : String) (args : List Json) (quick : Bool := false) :
    IO (Option (Except String (Json × State))) := do
  let some f ← b.adapter fn | return some (.error s!"no function {fn}")
  if quick && (← b.slow.get).contains fn then return none
  let t := Task.spawn (prio := .dedicated) fun _ => f st args
  let start ← IO.monoMsNow
  let mut spins := 0
  repeat
    if ← IO.hasFinished t then return some t.get
    if (← IO.monoMsNow) - start > 1000 then
      if quick then b.slow.modify (·.push fn)
      return none
    if spins < 200 then spins := spins + 1 else IO.sleep 1
  return none

def runCalls (b : Built) (fixture : Json) (calls : Array Json) (quick : Bool := true) : IO Outcome := do
  let st0 ← match State.ofJson fixture with
    | .ok s => pure s
    | .error e => return .throws s!"bad state: {e}" fixture
  let mut st := st0
  let mut v := Json.null
  for c in calls do
    let fn := getStr c "fn"
    let args := (getArr c "args").toList
    match ← callOnce b st fn args quick with
    | none => return .timeout
    | some (.error e) => return .throws e (stateJson fixture st)
    | some (.ok (v', st')) => v := v'; st := st'
  return .value v (stateJson fixture st)

def outcomeState : Outcome → Option Json
  | .value _ s => some s
  | .throws _ s => some s
  | .timeout => none

/-! ## Laws: proved theorems -/

def checkLaws (b : Built) (laws : Array Law) : IO (Array (String × String)) := do
  let mut env := b.env
  let mut fails := #[]
  let defNames : List Name := (b.defs.map Name.mkSimple).toList
  for law in laws do
    match ← (staticShape env law.src ["theorem"] 100).run with
    | .error e => fails := fails.push ("static", s!"law {law.name}: {e}")
    | .ok decls =>
      let (env', es) ← elabIn env law.src
      if !es.isEmpty then
        fails := fails.push ("proof", s!"law {law.name}: {String.intercalate "\n" (es.take 3)}")
        continue
      let mut bad := false
      for d in decls do
        let ax := badAxioms env' d.name
        if !ax.isEmpty then
          fails := fails.push ("proof", s!"law {law.name}: proof depends on {ax}")
          bad := true
      if let some d := decls.back? then
        let used := ((env'.find? d.name).map fun ci => ci.type.getUsedConstants.toList).getD []
        if !used.any defNames.contains then
          fails := fails.push ("proof", s!"law {law.name}: the statement does not mention any app function")
          bad := true
      if !bad then env := env'
  return fails

/-! ## The kernel -/

structure Kernel where
  dir : System.FilePath
  base : Environment
  world : IO.Ref WorldData
  live : IO.Ref Built

def Kernel.persist (k : Kernel) : IO Unit := do
  let w ← k.world.get
  let tmp := k.dir / "world.json.tmp"
  IO.FS.writeFile tmp (toJson w).pretty
  IO.FS.rename tmp (k.dir / "world.json")

def hex (n : UInt64) : String := String.ofList (Nat.toDigits 16 n.toNat)

def codeId (forms : Array Form) : String := hex (forms.foldl (fun h f => mixHash h (hash f.src)) 7)

/-- Apply forms and removals to the stored list: a form with a known name replaces it in place. -/
def applyForms (cur : Array Form) (new : Array Form) (removes : Array String) : Array Form := Id.run do
  let mut out := cur.filter fun f => !removes.contains f.name
  for f in new do
    match out.findIdx? (·.name == f.name) with
    | some i => out := out.set! i f
    | none => out := out.push f
  return out

def parseForms (base : Environment) (srcs : Array String) : IO (Except String (Array Form)) := do
  let mut acc := #[]
  for src in srcs do
    match ← (staticShape base src ["def", "theorem"] 1).run with
    | .error e => return .error s!"{((src.splitOn "\n").head!.take 60).toString}: {e}"
    | .ok ds => acc := acc.push { name := ds[0]!.name.toString, kind := ds[0]!.kind, src }
  return .ok acc

def errList (errs : Array (String × String)) : Json :=
  Json.arr (errs.map fun (l, d) => Json.mkObj [("layer", l), ("detail", d)])

def failRes (status : String) (errs : Array (String × String)) (gen : Nat) : Json :=
  Json.mkObj [("status", status), ("generation", gen), ("failed", errList errs)]

def fnsOf (calls : Array Json) : Array String := calls.map (getStr · "fn")

def Kernel.develop (k : Kernel) (req : Json) : IO Json := do
  let w ← k.world.get
  let gen := (req.getObjValAs? Nat "generation").toOption.getD 0
  if gen != w.generation then return Json.mkObj [("status", "stale"), ("generation", w.generation)]
  let scope := getStrs req "scope"
  let intent := getStr req "intent"
  let asked := (req.getObjVal? "asked").toOption.getD Json.null
  let newForms ← match ← parseForms k.base (getStrs req "forms") with
    | .error e => return failRes "rejected" #[("static", e)] w.generation
    | .ok fs => pure fs
  let removes := getStrs req "removes"
  let forms := applyForms w.forms newForms removes
  -- laws: same name replaces, others carry over
  let mut laws := w.laws
  for l in getArr req "laws" do
    let nl : Law := { name := getStr l "name", src := getStr l "check" }
    match laws.findIdx? (·.name == nl.name) with
    | some i => laws := laws.set! i nl
    | none => laws := laws.push nl
  let newExamples : Array Ex := (getArr req "examples").map fun e =>
    { fixture := (e.getObjVal? "fixture").toOption.getD Json.null, calls := getArr e "calls",
      expect := (e.getObjVal? "expect").toOption.getD Json.null }
  -- gate 1: static (every form loads and type checks, termination included)
  let prev ← k.live.get
  let b ← match ← buildWorld k.base forms (some prev) with
    | .error errs => return failRes "rejected" errs w.generation
    | .ok b => pure b
  let mut fails : Array (String × String) := #[]
  -- gate 2: ratchet (earlier examples that this request does not supersede, plus this request's)
  let kept := w.examples.filter fun p =>
    !(fnsOf p.calls |>.all scope.contains) ||
    !(newExamples.any fun q => jsonSame q.fixture p.fixture && jsonSame (Json.arr q.calls) (Json.arr p.calls) && !jsonSame q.expect p.expect)
  let mut resultStates : Array Json := #[]
  for ex in kept ++ newExamples do
    let o ← runCalls b ex.fixture ex.calls
    if let some s := outcomeState o then resultStates := resultStates.push s
    unless jsonSame o.toJson ex.expect do
      fails := fails.push ("ratchet", s!"{sh (Json.arr ex.calls)} on {sh ex.fixture}: got {sh o.toJson}, expected {sh ex.expect}")
  -- gate 3: invariants (live state, every example's resulting state, every trace replay)
  for v in invariantViolations w.state do fails := fails.push ("invariants", s!"live state: {v}")
  for s in resultStates do
    for v in invariantViolations s do fails := fails.push ("invariants", s!"example result {sh s}: {v}")
  -- gate 4: traces
  for t in w.traces do
    let o ← runCalls b t.before #[t.call]
    let fn := getStr t.call "fn"
    match o with
    | .value v s =>
      for viol in invariantViolations s do fails := fails.push ("invariants", s!"trace {sh t.call}: {viol}")
      if !scope.contains fn && !jsonSame v t.value then
        fails := fails.push ("traces", s!"{sh t.call} used to return {sh t.value}, now {sh v} ({fn} is not in scope)")
    | .throws e _ => fails := fails.push ("traces", s!"{sh t.call} used to run, now throws: {e}")
    | .timeout => fails := fails.push ("traces", s!"{sh t.call} used to run, now times out")
  -- gate 5: language layer: every law is a Lean theorem about these functions, and must check
  fails := fails ++ (← checkLaws b laws)
  if !fails.isEmpty then return failRes "rejected" fails w.generation
  -- accept
  let counter := w.revCounter + 1
  let id := s!"rev-{String.ofList (Nat.toDigits 10 (10000 + counter)) |>.drop 1}"
  let changed := (forms.filter fun f => (w.forms.find? (·.name == f.name)).map (·.src != f.src) |>.getD true).map (·.name)
    ++ removes
  let rev : Rev := { id, codeId := codeId forms, dataId := hex (hash (w.state.compress)), intent, scope, asked,
                     parent := w.revision, changed, forms, laws }
  k.world.set { w with generation := w.generation + 1, revCounter := counter, revision := some id, forms, laws,
                       examples := kept ++ newExamples, revisions := w.revisions.push rev }
  k.live.set b
  k.persist
  return Json.mkObj [("status", "accepted"), ("revision", id), ("generation", toJson (w.generation + 1)), ("failed", Json.arr #[]),
    ("proved", Json.arr (laws.map fun l => Json.str l.name))]

def Kernel.observe (k : Kernel) : IO Json := do
  let w ← k.world.get
  return Json.mkObj [("generation", w.generation),
    ("revision", match w.revision with | some r => Json.str r | none => Json.null),
    ("functions", Json.mkObj (w.forms.toList.map fun f => (f.name, Json.str f.src))),
    ("state", w.state)]

def Kernel.try_ (k : Kernel) (req : Json) : IO Json := do
  let w ← k.world.get
  let newForms ← match ← parseForms k.base (getStrs req "forms") with
    | .error e => return Json.mkObj [("ok", false), ("error", e)]
    | .ok fs => pure fs
  let forms := applyForms w.forms newForms (getStrs req "removes")
  match ← buildWorld k.base forms (some (← k.live.get)) with
  | .error errs =>
    return Json.mkObj [("ok", false), ("error", String.intercalate "\n" (errs.toList.map fun (l, d) => s!"[{l}] {d}"))]
  | .ok b =>
    let mut outs := #[]
    for q in getArr req "questions" do
      outs := outs.push (← runCalls b ((q.getObjVal? "fixture").toOption.getD (Json.mkObj [])) (getArr q "calls")).toJson
    return Json.mkObj [("ok", true), ("outcomes", Json.arr outs)]

def Kernel.execute (k : Kernel) (req : Json) : IO Json := do
  let w ← k.world.get
  let rid := getStr req "request_id"
  if rid != "" then
    if let some (_, r) := w.requests.find? (·.1 == rid) then
      return r.setObjVal! "replayed" true
  let some call := (req.getObjVal? "call").toOption | return Json.mkObj [("error", "execute needs a call")]
  let fn := getStr call "fn"
  let args := (getArr call "args").toList
  let b ← k.live.get
  let respond (r : Json) : IO Json := do
    if rid != "" then k.world.modify fun w => { w with requests := w.requests.push (rid, r) }
    k.persist
    return r
  let st ← match State.ofJson w.state with
    | .ok s => pure s
    | .error e => return ← respond (Json.mkObj [("ok", false), ("error", s!"bad state: {e}")])
  match ← callOnce b st fn args with
  | none => respond (Json.mkObj [("ok", false), ("error", "timed out after 1 s")])
  | some (.error e) => respond (Json.mkObj [("ok", false), ("error", e)])
  | some (.ok (v, st')) =>
    let sj := stateJson w.state st'
    let viol := invariantViolations sj
    if !viol.isEmpty then
      return ← respond (Json.mkObj [("ok", false), ("error", s!"refused: it would break an invariant: {viol.head!}")])
    k.world.modify fun w => { w with state := sj, traces := w.traces.push { before := w.state, call, value := v } }
    respond (Json.mkObj [("ok", true), ("value", v), ("replayed", false)])

def Kernel.rollback (k : Kernel) (req : Json) : IO Json := do
  let w ← k.world.get
  let err (m : String) : IO Json := return Json.mkObj [("ok", false), ("error", m)]
  let some cur := w.revision | return ← err "nothing to roll back"
  let target ← match getStr req "revision" with
    | "" => match (w.revisions.find? (·.id == cur)).bind (·.parent) with
      | some p => pure p
      | none => return ← err "no earlier revision"
    | r => pure r
  let some rev := w.revisions.find? (·.id == target) | return ← err s!"unknown revision {target}"
  let b ← match ← buildWorld k.base rev.forms none with
    | .error errs => return ← err s!"old code does not load: {errs[0]!.2}"
    | .ok b => pure b
  for v in invariantViolations w.state do return ← err s!"today's data breaks an invariant: {v}"
  for t in w.traces do
    match ← runCalls b t.before #[t.call] with
    | .value _ s =>
      if let some v := (invariantViolations s).head? then return ← err s!"old code breaks an invariant on trace {sh t.call}: {v}"
    | .throws e _ => return ← err s!"old code fails the recorded {sh t.call}: {e}"
    | .timeout => return ← err s!"old code times out on the recorded {sh t.call}"
  k.world.set { w with generation := w.generation + 1, revision := some target, forms := rev.forms, laws := rev.laws }
  k.live.set b
  k.persist
  return Json.mkObj [("ok", true), ("revision", target), ("generation", toJson (w.generation + 1))]

def Kernel.why (k : Kernel) (req : Json) : IO Json := do
  let w ← k.world.get
  let fn := getStr req "fn"
  let mut cur := w.revision
  for _ in [0:w.revisions.size + 1] do
    let some id := cur | return Json.null
    let some r := w.revisions.find? (·.id == id) | return Json.null
    if r.changed.contains fn then
      return Json.mkObj [("revision", r.id), ("intent", r.intent), ("asked", r.asked)]
    cur := r.parent
  return Json.null

def Kernel.handle (k : Kernel) (req : Json) : IO Json := do
  match getStr req "op" with
  | "observe" => k.observe
  | "try" => k.try_ req
  | "develop" => k.develop req
  | "execute" => k.execute req
  | "rollback" => k.rollback req
  | "why" => k.why req
  | op => return Json.mkObj [("error", s!"unknown op {op}")]

unsafe def main (args : List String) : IO UInt32 := do
  let some dirArg := args.head? | IO.eprintln "usage: kernel <data-dir>"; return 2
  enableInitializersExecution
  let dir : System.FilePath := dirArg
  IO.FS.createDirAll dir
  let root ← IO.appPath
  -- <root>/.lake/build/bin/kernel -> <root>/.lake/build/lib/lean
  let libDir : System.FilePath := match root.parent.bind (·.parent) with
    | some p => p / "lib" / "lean"
    | none => "."
  initSearchPath (← findSysroot) [libDir]
  let base ← importModules #[{module := `Init}, {module := `Chat.Prelude}] {} (trustLevel := 0) (loadExts := true)
  let w : WorldData ← do
    let f := dir / "world.json"
    if ← f.pathExists then
      match (Json.parse (← IO.FS.readFile f)) >>= fromJson? with
      | .ok w => pure w
      | .error e => IO.eprintln s!"cannot read world.json: {e}"; return 1
    else pure {}
  let live ← match ← buildWorld base w.forms none with
    | .ok b => pure b
    | .error errs => IO.eprintln s!"stored world does not load: {errs}"; return 1
  let k : Kernel := { dir, base, world := ← IO.mkRef w, live := ← IO.mkRef live }
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    if line.trimAscii.isEmpty then continue
    let resp ← try
        match Json.parse line with
        | .error e => pure (Json.mkObj [("error", s!"bad JSON: {e}")])
        | .ok req => k.handle req
      catch e => pure (Json.mkObj [("error", s!"kernel error: {e}")])
    stdout.putStrLn resp.compress
    stdout.flush
  IO.Process.exit 0
