// Showcase: proved laws vs tests, on the Lean kernel.  Run from chat-grown-languages/:
//   node --experimental-strip-types --no-warnings lean/showcase/demo.ts | tee lean/showcase/transcript.txt
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelClient, ROOT } from "../../bench/kernel-client.ts";
import { fixture, intended, SCENARIO, same } from "../../bench/reference.ts";

const ref = JSON.parse(readFileSync(join(ROOT, "lean", "reference.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "lean-showcase-"));
const k = new KernelClient("lean", dir);
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)} ms`;
const head = (s: string) => console.log(`\n=== ${s} ===`);
const clip = (s: string, n = 700) => (s.length > n ? `${s.slice(0, n)} ...` : s);
const indent = (s: string) => s.split("\n").map((l) => `    ${l}`).join("\n");

async function develop(forms: string[], scope: string[], laws: { name: string; check: string }[] = [], examples: any[] = [], intent = "demo") {
	const { generation } = await k.request({ op: "observe" });
	const t = performance.now();
	const r = await k.request({ op: "develop", generation, intent, scope, forms, removes: [], laws, examples, asked: { message: 0, text: intent } });
	r.ms = Math.round(performance.now() - t);
	return r;
}
function report(r: any) {
	console.log(`  -> ${r.status} (${r.ms} ms)${r.proved ? `, ${r.proved.length} proved laws re-checked` : ""}`);
	for (const f of r.failed ?? []) console.log(`     [${f.layer}] ${clip(f.detail.replace(/\n/g, "\n       "))}`);
}
async function turn(i: number, opts: { dropLaws?: boolean } = {}) {
	const r = ref.turns[i];
	const examples = SCENARIO.turns[i].examples.map((e: any) => {
		const q = { fixture: fixture(e.fixture), calls: e.calls };
		return { ...q, expect: intended(i, q) };
	});
	const out = await develop(r.forms, r.scope, opts.dropLaws ? [] : r.laws, examples, r.intent);
	for (const call of SCENARIO.turns[i].use) await k.request({ op: "execute", call, request_id: `u${i}-${call.fn}-${Math.random()}` });
	return out;
}

// A seeded copy of the JS prototype's random states (amounts up to 100.00, four categories).
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const cats = ["food", "rent", "transport", "fun"];
const randomState = () => ({
	expenses: Array.from({ length: Math.floor(rand() * 8) }, () => ({ amount: Math.max(1, Math.round(rand() * 10_000)) / 100, category: cats[Math.floor(rand() * cats.length)] })),
	budgets: Object.fromEntries(cats.filter(() => rand() < 0.5).map((c) => [c, Math.round(rand() * 5_000) / 100])),
});
/** What the JS prototype does with laws: run the property on N random states, through `try` (the candidate code, nothing installed). */
async function propertyTest(forms: string[], n: number, calls: any[], holds: (outs: any[], st: any) => boolean) {
	const states = Array.from({ length: n }, randomState);
	const qs = states.flatMap((st) => calls.map((c) => ({ fixture: st, calls: [c] })));
	const r = await k.request({ op: "try", forms, removes: [], questions: qs });
	if (!r.ok) return `candidate does not load: ${r.error}`;
	let pass = 0;
	states.forEach((st, i) => { if (holds(calls.map((_, j) => r.outcomes[i * calls.length + j].value), st)) pass++; });
	return `${pass}/${n} random states pass`;
}
async function exampleTests(forms: string[], upTo: number) {
	let pass = 0, total = 0;
	for (let i = 0; i <= upTo; i++) {
		const qs = SCENARIO.turns[i].examples.map((e: any) => ({ fixture: fixture(e.fixture), calls: e.calls }));
		const r = await k.request({ op: "try", forms, removes: [], questions: qs });
		qs.forEach((q: any, j: number) => { total++; if (r.ok && same(r.outcomes[j], intended(i, q))) pass++; });
	}
	return `${pass}/${total} user-confirmed examples pass`;
}

head("1. Grow the app turn by turn (every turn carries Lean theorems about the functions it writes)");
for (let i = 0; i < 3; i++) {
	const r = await turn(i);
	console.log(`turn ${i + 1} "${ref.turns[i].intent}": ${r.status} in ${r.ms} ms; laws: ${(ref.turns[i].laws.map((l: any) => l.name).join(", ")) || "(none)"}`);
}

head("2. A refactor that keeps every example green but breaks an earlier proof");
console.log("Turn 4 rewrites `total` through a new helper `sum_cents`. If the model forgets to re-state the turn-3 law's proof against the new `total`:");
const r4 = await turn(3, { dropLaws: true });
report(r4);
console.log("With the repaired proof (same law name replaces the old one) and a new law `total_is_exact_sum`:");
report(await turn(3));
for (let i = 4; i < 8; i++) {
	const r = await turn(i);
	console.log(`turn ${i + 1} "${ref.turns[i].intent}": ${r.status} in ${r.ms} ms; ${r.proved?.length} laws now proved`);
}

head("3. A bug that tests miss: by_category silently drops expenses over $1000");
const bug1 = `def by_category (s : State) : List (String × Int) :=
  s.expenses.foldl (fun m e => if e.cents > 100000 then m else add_to m e.category e.cents) []`;
console.log(indent(bug1));
console.log("tests:");
console.log("  " + await exampleTests([bug1], 7));
console.log("  property 'categories add up to total', JS-style: " + await propertyTest([bug1], 300, [{ fn: "by_category", args: [] }, { fn: "total", args: [] }],
	([bc, tot]) => Math.abs(Object.values(bc as Record<string, number>).reduce((a, b) => a + b, 0) - (tot as number)) < 0.005));
console.log("proof: develop with the same forms, law `by_category_sums_to_total` carried from turn 3/4");
report(await develop([bug1], ["by_category"]));
console.log("what the bug does, on a state with one $1500 rent payment (nothing installed, `try` only):");
const t = await k.request({ op: "try", forms: [bug1], removes: [], questions: [{ fixture: { expenses: [{ amount: 1500, category: "rent" }] }, calls: [{ fn: "by_category", args: [] }, { fn: "total", args: [] }] }] });
console.log("  by_category -> " + JSON.stringify((await k.request({ op: "try", forms: [bug1], removes: [], questions: [{ fixture: { expenses: [{ amount: 1500, category: "rent" }] }, calls: [{ fn: "by_category", args: [] }] }] })).outcomes[0].value) + ", total -> " + JSON.stringify(t.outcomes[0].value));

head("4. A bug that tests almost miss: over_budget uses >= (spending exactly the budget is not over)");
const bug2 = ref.turns[5].forms[2].replace("> p.2", "≥ p.2");
console.log(indent(bug2));
console.log("tests:");
console.log("  " + await exampleTests([bug2], 7));
console.log("  property 'every category in over_budget() has spent more than its budget': " + await propertyTest([bug2], 300, [{ fn: "over_budget", args: [] }, { fn: "by_category", args: [] }],
	([ob, bc], st) => (ob as string[]).every((c) => ((bc as any)[c] ?? 0) > st.budgets[c])));
report(await develop([bug2], ["over_budget"]));

head("5. A claimed law that is false");
const falseLaws = [
	{ name: "add_expense_never_fails", check: `theorem add_expense_never_fails (s : State) (a : Int) (c : String) (n : Option String) :\n    ∃ r, add_expense s a c n = .ok r := by\n  simp [add_expense]` },
	{ name: "top_category_is_never_null", check: `theorem top_category_is_never_null (s : State) : top_category s ≠ none := by\n  simp [top_category, by_category, best_of]` },
];
for (const l of falseLaws) {
	console.log(`law ${l.name}:`);
	report(await develop([], [], [l]));
}
console.log("a true law the same model could state instead (no forms, just the proof):");
report(await develop([], [], [{ name: "no_expenses_no_top_category", check: `theorem no_expenses_no_top_category (s : State) (h : s.expenses = []) : top_category s = none := by\n  simp [top_category, by_category, h, best_of]` }]));
console.log("a law that is true but says nothing about the app (rejected: must mention an app function):");
report(await develop([], [], [{ name: "vacuous", check: `theorem vacuous : 1 + 1 = 2 := rfl` }]));
console.log("a law proved by cheating (sorry / native_decide / axiom):");
for (const check of [`theorem cheat (s : State) : total s = 0 := by sorry`, `theorem cheat2 (s : State) : total s ≥ 0 := by native_decide`, `axiom cheat3 : ∀ s : State, total s = 0`])
	report(await develop([], [], [{ name: "cheat", check }]));

head("6. Static gate: what a form may be");
const bad: [string, string][] = [
	["not a definition", `#eval IO.println "hello"`],
	["partial (can loop)", `partial def total (s : State) : Int := total s`],
	["unsafe / IO escape hatch", `def total (s : State) : Int := unsafeBaseIO (pure 0)`],
	["IO", `def total (s : State) : IO Int := pure 0`],
	["option change", `set_option maxRecDepth 1 in\ndef total (s : State) : Int := 0`],
	["@[implemented_by]", `@[implemented_by total] def total2 (s : State) : Int := 0`],
	["two commands in one form", `def a := 1\ndef b := 2`],
	["patching a global instance", `instance : Add Int := ⟨fun _ _ => 0⟩`],
	["non-terminating recursion (caught by the termination checker)", `def total (s : State) : Int := total s`],
	["call to a function that does not exist", `def total (s : State) : Int := sum_everything s.expenses`],
	["type error", `def total (s : State) : Int := "three"`],
];
for (const [what, src] of bad) { console.log(`${what}:`); report(await develop([src], ["total"])); }
console.log("terminating but too slow (3e9 iterations): the 1 s limit, via `try` and via `develop`:");
const slow = `def total (s : State) : Int := Id.run do\n  let mut a : Int := 0\n  for i in [0:3000000000] do\n    a := a + i\n  return a`;
console.log("  try -> " + JSON.stringify((await k.request({ op: "try", forms: [slow], removes: [], questions: [{ fixture: {}, calls: [{ fn: "total", args: [] }] }] })).outcomes));
report(await develop([slow], ["total"]));

head("7. The live image after all of that");
const obs = await k.request({ op: "observe" });
console.log(`generation ${obs.generation}, revision ${obs.revision}, ${Object.keys(obs.functions).length} functions, state ${JSON.stringify(obs.state).slice(0, 120)}...`);
console.log(`(total elapsed ${ms()})`);
await k.close();
rmSync(dir, { recursive: true, force: true });
