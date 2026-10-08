// Showcase part 1: the live image over the JSON-lines protocol. Run: node showcase/demo.mjs (from smalltalk/)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = mkdtempSync(join(tmpdir(), "st-demo-"));
const proc = spawn(join(import.meta.dirname, "..", "run.sh"), [dir]);
const lines = []; const waiting = [];
createInterface({ input: proc.stdout }).on("line", (l) => { const w = waiting.shift(); w ? w(l) : lines.push(l); });
const ask = (req, note) => new Promise((resolve) => {
	if (note) console.log(`\n# ${note}`);
	console.log(`> ${JSON.stringify(req).slice(0, 300)}`);
	proc.stdin.write(`${JSON.stringify(req)}\n`);
	const done = (l) => { console.log(`< ${l.slice(0, 400)}`); resolve(JSON.parse(l)); };
	const l = lines.shift(); l ? done(l) : waiting.push(done);
});
const cents = "cents: x\n\t^ (x * 100) rounded / 100.0";
const addExpense = "add_expense: amount category: category\n\t| list |\n\tlist := state at: 'expenses' ifAbsentPut: [ OrderedCollection new ].\n\tlist add: { 'amount' -> amount. 'category' -> category } asDictionary.\n\t^ list size";
const byCat = (round) => `by_category\n\t| out |\n\tout := Dictionary new.\n\t(state at: 'expenses' ifAbsent: [ #() ]) do: [ :e |\n\t\tout at: (e at: 'category') put: ${round ? "(self cents: (out at: (e at: 'category') ifAbsent: [ 0 ]) + (e at: 'amount'))" : "(out at: (e at: 'category') ifAbsent: [ 0 ]) + (e at: 'amount')"} ].\n\t^ out`;
const setBudget = "set_budget: category amount: amount\n\t(state at: 'budgets' ifAbsentPut: [ Dictionary new ]) at: category put: amount.\n\t^ amount";
const over = "over_budget\n\t| spent budgets |\n\tspent := self by_category.\n\tbudgets := state at: 'budgets' ifAbsent: [ Dictionary new ].\n\t^ (budgets keys select: [ :c | (spent at: c ifAbsent: [ 0 ]) > (budgets at: c) ]) sorted";
const call = (fn, ...args) => ({ fn, args });
const dev = async (g, intent, scope, forms, examples, text, note) => ask({ op: "develop", generation: g, intent, scope, forms, removes: [], examples, asked: { message: g * 10, text } }, note);

console.log("== Part 1: methods compiled into a live class; callers see recompiled methods at once ==");
await ask({ op: "develop", generation: 0, intent: "add expenses", scope: ["add_expense"], forms: [addExpense], removes: [], examples: [{ fixture: {}, calls: [call("add_expense", 1, "a")], expect: { value: 1, state: { expenses: [{ amount: 1, category: "a" }] } } }], asked: { message: 10, text: "Let me record expenses" } }, "turn 1: add_expense becomes the method ExpenseApp>>add_expense:category:");
await dev(1, "by category", ["by_category"], [byCat(false)], [{ fixture: { expenses: [{ amount: 0.1, category: "a" }, { amount: 0.2, category: "a" }] }, calls: [call("by_category")], expect: { value: { a: 0.30000000000000004 }, state: { expenses: [{ amount: 0.1, category: "a" }, { amount: 0.2, category: "a" }] } } }], "Break it down by category", "turn 2: by_category (plain float sums)");
await dev(2, "budgets", ["set_budget", "over_budget"], [setBudget, over], [], "Let me set a monthly budget", "turn 3: over_budget CALLS self by_category (a late-bound send)");
await ask({ op: "execute", call: call("add_expense", 0.1, "food"), request_id: "r1" });
await ask({ op: "execute", call: call("add_expense", 0.2, "food"), request_id: "r2" });
await ask({ op: "execute", call: call("set_budget", "food", 0.3), request_id: "r3" });
await ask({ op: "try", forms: [], removes: [], questions: [{ fixture: { expenses: [{ amount: 0.1, category: "food" }, { amount: 0.2, category: "food" }], budgets: { food: 0.3 } }, calls: [call("over_budget")] }] }, "over_budget today: 0.1 + 0.2 = 0.30000000000000004 > 0.3, so food looks over budget");
await dev(3, "round to cents", ["by_category", "cents"], [cents, byCat(true)], [{ fixture: { expenses: [{ amount: 0.1, category: "a" }, { amount: 0.2, category: "a" }] }, calls: [call("by_category")], expect: { value: { a: 0.3 }, state: { expenses: [{ amount: 0.1, category: "a" }, { amount: 0.2, category: "a" }] } } }], "Money should be in cents", "turn 4: only by_category and the new helper cents: are recompiled; over_budget's source is untouched");
await ask({ op: "try", forms: [], removes: [], questions: [{ fixture: { expenses: [{ amount: 0.1, category: "food" }, { amount: 0.2, category: "food" }], budgets: { food: 0.3 } }, calls: [call("over_budget")] }] }, "same over_budget, same call: it now reaches the NEW by_category method (no reload, no re-link)");
await ask({ op: "why", fn: "by_category" }, "why: the revision that last compiled the method, and the chat message that asked");
await ask({ op: "why", fn: "over_budget" });
await ask({ op: "changes", limit: 10 }, "the image's own change log (Epicea): every compile into ExpenseApp, oldest first");
await ask({ op: "rollback", revision: "rev-0003" }, "rollback = recompile the old methods into the same class; today's data kept");
await ask({ op: "try", forms: [], removes: [], questions: [{ fixture: { expenses: [{ amount: 0.1, category: "food" }, { amount: 0.2, category: "food" }], budgets: { food: 0.3 } }, calls: [call("over_budget")] }] }, "over_budget is back to the old answer: it sees the restored by_category");
await ask({ op: "changes", limit: 5 }, "the rollback is just more entries in the same log");
await ask({ op: "observe" });
proc.stdin.end();
await new Promise((r) => proc.on("exit", r));
console.log(`\n(world dir kept for part 2: ${dir})`);
console.log(`WORLD=${dir}`);
