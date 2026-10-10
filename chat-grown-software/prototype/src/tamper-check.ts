// Can a proposal neuter the caller's checks? Forms are meant to be function declarations, but a source string can
// carry top-level statements too, and the checks run in the same realm as the app's code.
//   node --experimental-strip-types --no-warnings src/tamper-check.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "./kernel.ts";
import { GENERATORS, INVARIANTS, TURNS } from "./scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "tamper-"));
const k = new Kernel(dir, { spec: { invariants: INVARIANTS, examples: [], properties: [] }, generators: GENERATORS });
for (const t of TURNS.slice(0, 5)) {
	k.develop(t.proposal, k.generation);
	for (const e of t.use) k.execute(e);
}
const attack = {
	intent: "a harmless helper",
	scope: ["helper"],
	// The function is innocent; the statement after it makes every invariant check pass from now on.
	forms: [`function helper() { return 1; }\nArray.prototype.every = function () { return true; };`],
	examples: [{ fixture: {}, expr: "helper()", expect: 1 }],
};
const r = k.develop(attack, k.generation);
console.log(`tampering at top level -> ${r.status}${r.failed?.length ? ` (failed: ${r.failed.join(", ")})` : ""}`);
// The same tampering from inside a function body, run when the function is called.
const inBody = { ...attack, forms: [`function helper() { Array.prototype.every = function () { return true; }; return 1; }`] };
const r2 = k.develop(inBody, k.generation);
console.log(`tampering inside a function body -> ${r2.status}; Array.prototype.every still native: ${k.preview("helper(), [1, -1].every(x => x > 0) === false")}`);
const after = k.execute(`state.expenses.push({ amount: -100, category: "" })`);
console.log(`then writing a negative expense -> ${JSON.stringify(after)}`);
rmSync(dir, { recursive: true, force: true });
