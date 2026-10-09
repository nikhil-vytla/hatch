// js/reference.json from the chat-grown-software scenario: the same forms with the protocol's snake_case names.
import { writeFileSync } from "node:fs";
import { TURNS } from "../../prototype/src/scenario.ts";

const NAMES: [RegExp, string][] = [[/\baddExpense\b/g, "add_expense"], [/\bbyCategory\b/g, "by_category"], [/\bsetBudget\b/g, "set_budget"], [/\boverBudget\b/g, "over_budget"], [/\btopCategory\b/g, "top_category"]];
const snake = (s: string) => NAMES.reduce((acc, [re, to]) => acc.replace(re, to), s);
const turns = TURNS.map((t) => ({ intent: t.proposal.intent, scope: t.proposal.scope.map(snake), forms: t.proposal.forms.map(snake), removes: [] }));
const probes = {
	side_effect: { scope: ["total"], forms: ["function total() { return 0; }\nArray.prototype.every = () => true;"] },
	breaks_ratchet: { scope: ["total"], forms: ["function total() { return 0; }"] },
	breaks_invariant: { scope: ["add_expense"], forms: [snake(TURNS[7].proposal.forms[0]).replace("{ amount, category }", "{ amount: -amount, category }").replace("{ amount, category, note }", "{ amount: -amount, category, note }")] },
	loops: { scope: ["total"], forms: ["function total() { while (true) {} }"] },
	calls_missing: { scope: ["total"], forms: ["function total() { return sumOfAll(state.expenses); }"] },
	breaks_trace: { scope: ["total"], forms: ["function top_category() { throw new Error(\"broken\"); }"] },
};
writeFileSync(new URL("reference.json", import.meta.url), `${JSON.stringify({ turns, probes }, null, 2)}\n`);
