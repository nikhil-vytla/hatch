// An expense tracker grown in eight chat turns, as a model would answer each request. Each turn carries:
//   - what the user said;
//   - the change: declared scope (the functions the request is about) and the forms;
//   - examples the user confirmed in the chat ("so 0.1 + 0.2 shows 0.3?" "yes"): this turn's goals, the ratchet later;
//   - optionally a property the user agreed to ("categories always add up to the total");
//   - then some real use of the app, which becomes the trace record.
import type { Example, Invariant, Property, Proposal } from "./gates.ts";

export type Turn = { user: string; proposal: Proposal; use: string[] };

const three = { expenses: [{ amount: 12.5, category: "food" }, { amount: 40, category: "transport" }, { amount: 7.25, category: "food" }] };
const ex = (fixture: unknown, expr: string, expect: unknown): Example => ({ fixture, expr, expect });
const tryExpr = (expr: string) => `(() => { try { ${expr}; return "accepted"; } catch (e) { return "rejected"; } })()`;

// Owned by the caller from the start: what the data must always look like.
export const INVARIANTS: Invariant[] = [
	{ name: "expenses-shape", check: `(state.expenses ?? []).every(e => typeof e.amount === "number" && isFinite(e.amount) && e.amount > 0 && typeof e.category === "string" && e.category.length > 0 && (e.note === undefined || typeof e.note === "string"))` },
	{ name: "budgets-shape", check: `Object.values(state.budgets ?? {}).every(b => typeof b === "number" && b >= 0)` },
	{ name: "known-keys", check: `Object.keys(state).every(k => k === "expenses" || k === "budgets")` },
];

export const GENERATORS: Record<string, (rand: () => number) => unknown> = {
	expenses: (rand) => {
		const cats = ["food", "rent", "transport", "fun"];
		const n = Math.floor(rand() * 8);
		const expenses = Array.from({ length: n }, () => ({ amount: Math.max(1, Math.round(rand() * 10_000)) / 100, category: cats[Math.floor(rand() * cats.length)] }));
		const budgets = Object.fromEntries(cats.filter(() => rand() < 0.5).map((c) => [c, Math.round(rand() * 5_000) / 100]));
		return { expenses, budgets };
	},
};

const TURNS_AS_WRITTEN: Turn[] = [
	{
		user: "Let me record expenses: an amount and a category.",
		proposal: {
			intent: "add expenses",
			scope: ["addExpense"],
			forms: [`function addExpense(amount, category) {
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category });
  return state.expenses.length;
}`],
			examples: [ex({}, `addExpense(12.5, "food")`, 1), ex(three, `addExpense(2, "fun")`, 4)],
		},
		use: [`addExpense(12.5, "food")`, `addExpense(40, "transport")`, `addExpense(7.25, "food")`],
	},
	{
		user: "What's my total so far?",
		proposal: {
			intent: "total",
			scope: ["total"],
			forms: [`function total() {
  return (state.expenses || []).reduce((sum, e) => sum + e.amount, 0);
}`],
			examples: [ex(three, `total()`, 59.75), ex({}, `total()`, 0)],
		},
		use: [`total()`],
	},
	{
		user: "Break it down by category. The categories should always add up to the total.",
		proposal: {
			intent: "by category",
			scope: ["byCategory"],
			forms: [`function byCategory() {
  const out = {};
  for (const e of state.expenses || []) out[e.category] = (out[e.category] || 0) + e.amount;
  return out;
}`],
			examples: [ex(three, `byCategory()`, { food: 19.75, transport: 40 }), ex({}, `byCategory()`, {})],
			properties: [{ name: "categories-sum-to-total", gen: "expenses", check: `Math.abs(Object.values(byCategory()).reduce((a, b) => a + b, 0) - total()) < 0.005` }],
		},
		use: [`byCategory()`, `addExpense(3.1, "fun")`, `byCategory()`],
	},
	{
		user: "Money should be in cents. When I add 0.10 and 0.20 the total should say 0.3, not 0.30000000000000004.",
		proposal: {
			intent: "round to cents",
			scope: ["total", "byCategory", "cents"],
			forms: [
				`function cents(x) {
  return Math.round(x * 100) / 100;
}`,
				`function total() {
  return cents((state.expenses || []).reduce((sum, e) => sum + e.amount, 0));
}`,
				`function byCategory() {
  const out = {};
  for (const e of state.expenses || []) out[e.category] = cents((out[e.category] || 0) + e.amount);
  return out;
}`,
			],
			examples: [ex({ expenses: [{ amount: 0.1, category: "a" }, { amount: 0.2, category: "a" }] }, `[total(), byCategory().a]`, [0.3, 0.3])],
			properties: [{ name: "total-in-cents", gen: "expenses", check: `Math.round(total() * 100) / 100 === total()` }],
		},
		use: [`total()`],
	},
	{
		user: "Don't let me add an expense of zero or less, or one without a category. Throw an error.",
		proposal: {
			intent: "validate expenses",
			scope: ["addExpense"],
			forms: [`function addExpense(amount, category) {
  if (!(typeof amount === "number" && amount > 0)) throw new Error("amount must be positive");
  if (!category) throw new Error("category required");
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category });
  return state.expenses.length;
}`],
			examples: [ex({}, tryExpr(`addExpense(-5, "food")`), "rejected"), ex({}, tryExpr(`addExpense(5, "")`), "rejected"), ex({}, tryExpr(`addExpense(5, "food")`), "accepted")],
		},
		use: [`addExpense(9.99, "fun")`],
	},
	{
		user: "Let me set a monthly budget per category and tell me which ones I'm over.",
		proposal: {
			intent: "budgets",
			scope: ["setBudget", "overBudget"],
			forms: [
				`function setBudget(category, amount) {
  state.budgets = state.budgets || {};
  state.budgets[category] = amount;
  return amount;
}`,
				`function overBudget() {
  const spent = byCategory();
  return Object.keys(state.budgets || {}).filter(c => (spent[c] || 0) > state.budgets[c]).sort();
}`,
			],
			examples: [ex({ ...three, budgets: { food: 15, transport: 50 } }, `overBudget()`, ["food"]), ex(three, `overBudget()`, [])],
			properties: [{ name: "over-budget-is-over", gen: "expenses", check: `overBudget().every(c => (byCategory()[c] || 0) > state.budgets[c])` }],
		},
		use: [`setBudget("food", 15)`, `overBudget()`, `setBudget("fun", 100)`, `overBudget()`],
	},
	{
		user: "Which category do I spend the most on? If two tie, pick the alphabetically first.",
		proposal: {
			intent: "top category",
			scope: ["topCategory"],
			forms: [`function topCategory() {
  const spent = byCategory();
  let best = null;
  for (const c of Object.keys(spent).sort()) if (best === null || spent[c] > spent[best]) best = c;
  return best;
}`],
			examples: [ex(three, `topCategory()`, "transport"), ex({ expenses: [{ amount: 5, category: "b" }, { amount: 5, category: "a" }] }, `topCategory()`, "a"), ex({}, `topCategory()`, null)],
			properties: [{ name: "top-is-max", gen: "expenses", check: `topCategory() === null || Object.values(byCategory()).every(v => v <= byCategory()[topCategory()])` }],
		},
		use: [`topCategory()`],
	},
	{
		user: "Can expenses have an optional note? Like 'coffee with Sam'.",
		proposal: {
			intent: "notes",
			scope: ["addExpense"],
			forms: [`function addExpense(amount, category, note) {
  if (!(typeof amount === "number" && amount > 0)) throw new Error("amount must be positive");
  if (!category) throw new Error("category required");
  state.expenses = state.expenses || [];
  state.expenses.push(note === undefined ? { amount, category } : { amount, category, note });
  return state.expenses.length;
}`],
			examples: [ex({}, `(addExpense(4, "food", "coffee with Sam"), state.expenses[0].note)`, "coffee with Sam"), ex({}, `(addExpense(4, "food"), "note" in state.expenses[0])`, false)],
		},
		use: [`addExpense(4.5, "food", "coffee with Sam")`, `topCategory()`, `total()`],
	},
];

// CONTRACT=fixed: the two examples a kernel that enforces coverage and asks about the user's own boundary words would
// have obtained. Turn 5's request says "zero or less", so 0 is the boundary to confirm; turn 6's examples set budgets
// only through fixtures, so `setBudget` itself was never exercised (the coverage report flags it).
const FIXES: Record<string, Example[]> = {
	"validate expenses": [ex({}, tryExpr(`addExpense(0, "food")`), "rejected")],
	budgets: [ex({}, `(setBudget("food", 20), setBudget("rent", 900), state.budgets)`, { food: 20, rent: 900 })],
};

export const TURNS: Turn[] =
	process.env.CONTRACT === "fixed"
		? TURNS_AS_WRITTEN.map((t) => ({ ...t, proposal: { ...t.proposal, examples: [...t.proposal.examples, ...(FIXES[t.proposal.intent] ?? [])] } }))
		: TURNS_AS_WRITTEN;
