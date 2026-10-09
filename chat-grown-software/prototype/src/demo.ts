// Grow the expense tracker turn by turn through the kernel, then show what the kernel refuses, a recovery in a fresh
// process, and a rollback.
//   node --experimental-strip-types --no-warnings src/demo.ts
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Proposal } from "./gates.ts";
import { Kernel } from "./kernel.ts";
import { GENERATORS, INVARIANTS, TURNS } from "./scenario.ts";

const DIR = join(import.meta.dirname, "..", "data", "demo");
const open = () => new Kernel(DIR, { spec: { invariants: INVARIANTS, examples: [], properties: [] }, generators: GENERATORS });

if (process.argv[2] === "crash") {
	// Executes with a request id and dies after the commit, before it can reply (CRASH_AFTER_COMMIT=1).
	open().execute(`addExpense(2, "fun")`, "req-retry-1");
	process.exit(0);
}

if (process.argv[2] === "recover") {
	const k = open();
	console.log(`fresh process recovered ${k.revision!.id} ("${k.revision!.reason}"): functions ${k.observe().functions.join(", ")}`);
	console.log(`  total() = ${JSON.stringify(k.execute("total()"))}, overBudget() = ${JSON.stringify(k.execute("overBudget()"))}`);
	console.log(`  contract carried over: ${k.spec.examples.length} confirmed examples, ${k.spec.properties.length} properties, ${k.spec.invariants.length} invariants`);
	process.exit(0);
}

rmSync(DIR, { recursive: true, force: true });
const k = open();
const show = (label: string, r: ReturnType<Kernel["develop"]>) => {
	const failed = r.report?.verdicts.filter((v) => !v.ok).map((v) => `${v.layer}: ${v.detail}`) ?? [];
	console.log(`  ${label} -> ${r.status}${r.revision ? ` (${r.revision})` : ""}`);
	for (const f of failed) console.log(`     x ${f}`);
	for (const s of r.report?.surfaced ?? []) console.log(`     ~ behavior diff for you to confirm: ${s.expr}: ${JSON.stringify(s.before)} -> ${JSON.stringify(s.after)}`);
	for (const n of r.report?.uncovered ?? []) console.log(`     ? no example you confirmed calls ${n}(): give one?`);
	const fresh = (r.report?.advisories ?? []).filter((a) => !a.includes("as the accepted version does"));
	if (fresh.length) console.log(`     ! fuzzing found inputs that would corrupt state (the kernel undoes such calls): ${fresh.slice(0, 2).join("; ")}${fresh.length > 2 ? ` (+${fresh.length - 2} more)` : ""}`);
};

for (const [i, turn] of TURNS.entries()) {
	console.log(`\nturn ${i + 1}  user> ${turn.user}`);
	show(`develop [${turn.proposal.scope.join(", ")}]`, k.develop(turn.proposal, k.generation, { asked: { message: i, text: turn.user } }));
	for (const expr of turn.use) console.log(`  use ${expr} => ${JSON.stringify(k.execute(expr))}`);
}

console.log(`\nWhat the kernel refuses:`);
// 1. A proposal computed against an old observation.
show("stale proposal (saw generation 0)", k.develop({ ...TURNS[6].proposal, intent: "stale" }, 0));
// 2. A "helpful" refactor that changes total() for floats, slipped into an unrelated request.
const driveBy: Proposal = {
	intent: "export to CSV",
	scope: ["toCSV"],
	forms: [
		`function toCSV() { return (state.expenses || []).map(e => e.amount + "," + e.category).join("\\n"); }`,
		`function total() { return Math.floor((state.expenses || []).reduce((s, e) => s + e.amount, 0)); }`,
	],
	examples: [{ fixture: { expenses: [{ amount: 1, category: "a" }] }, expr: "toCSV()", expect: "1,a" }],
};
show("CSV export + drive-by edit to total()", k.develop(driveBy, k.generation));
// 3. A version of overBudget that caches into state.
show(
	"overBudget that caches into state",
	k.develop({ ...TURNS[5].proposal, intent: "faster overBudget", scope: ["overBudget"], forms: [TURNS[5].proposal.forms[1].replace("const spent = byCategory();", "const spent = byCategory(); state.cache = spent;")], examples: [] }, k.generation),
);
// 4. Using the app in a way that would break an invariant is undone, not recorded.
console.log(`  use state.expenses.push({amount: -3, category: "x"}) => ${JSON.stringify(k.execute(`state.expenses.push({amount: -3, category: "x"})`))}`);
// 5. A hang.
show("addExpense with an accidental infinite loop", k.develop({ ...TURNS[7].proposal, intent: "hang", forms: [TURNS[7].proposal.forms[0].replace("state.expenses = state.expenses || [];", "while (state.expenses) {}")] }, k.generation));

console.log(`\nA fresh process:`);
spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", import.meta.filename, "recover"], { stdio: "inherit" });

console.log(`\nWhy is topCategory the way it is?`);
const why = k.why("topCategory")!;
console.log(`  ${why.revision} ("${why.reason}"), asked for in chat message ${why.asked?.message}: "${why.asked?.text}"`);

console.log(`\nRollback of code to before notes existed (data stays):`);
const beforeNotes = k.store.revisions().filter((r) => r.reason === "top category").at(-1)!;
const noted = () => (k.world.state() as { expenses: { note?: string }[] }).expenses.filter((e) => e.note !== undefined).length;
const dataBefore = k.revision!.dataId;
const rb = k.rollback(beforeNotes.id);
console.log(`  published ${rb.id}: its code id ${rb.codeId === beforeNotes.codeId ? "equals" : "DIFFERS FROM"} ${beforeNotes.id}'s; its data id ${rb.dataId === dataBefore ? "equals" : "DIFFERS FROM"} the data before the rollback; expenses with a note kept: ${noted()}`);
console.log(`  addExpense(1, "food", "x") => ${JSON.stringify(k.execute(`(addExpense(1, "food", "x"), state.expenses.at(-1))`))} (the note is ignored again)`);
const both = k.rollback(beforeNotes.id, "both");
console.log(`  Jiti-style rollback of code and data (${both.id}) instead: expenses with a note kept: ${noted()}, and the expense just added is gone too`);

console.log(`\nExactly-once execute: a client sends addExpense(2, "fun") with request id req-retry-1; the kernel dies after the commit, before replying:`);
const count = () => (k.world.state() as { expenses: unknown[] }).expenses.length;
const n0 = count();
const crash = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", import.meta.filename, "crash"], { env: { ...process.env, CRASH_AFTER_COMMIT: "1" } });
const k2 = open();
console.log(`  the process exited with ${crash.status}; recovered ${k2.revision!.id} ("${k2.revision!.reason}"), ${(k2.world.state() as { expenses: unknown[] }).expenses.length} expenses (was ${n0})`);
console.log(`  the client retries the same id => ${JSON.stringify(k2.execute(`addExpense(2, "fun")`, "req-retry-1"))}; expenses: ${(k2.world.state() as { expenses: unknown[] }).expenses.length}`);
console.log(`  a new id applies again => ${JSON.stringify(k2.execute(`addExpense(2, "fun")`, "req-retry-2"))}`);
