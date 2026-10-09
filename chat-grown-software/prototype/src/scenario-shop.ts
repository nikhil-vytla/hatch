// A second scenario: stock for a small shop, grown in six chat turns. It was written after the kernel's question
// rules were designed on the expense tracker, and its misreadings were written before any run, so it is a held-out
// test of those rules. Turn 6 changes how names are stored and carries a migration of the live data.
import type { Example, Invariant } from "./gates.ts";
import type { Misreading } from "./misreadings.ts";
import type { Turn } from "./scenario.ts";

const ex = (fixture: unknown, expr: string, expect: unknown): Example => ({ fixture, expr, expect });
const tryExpr = (expr: string) => `(() => { try { ${expr}; return "accepted"; } catch (e) { return "rejected"; } })()`;
const shelf = { stock: { apple: 10, pear: 4, fig: 0 } };

export const INVARIANTS: Invariant[] = [
	{ name: "stock-shape", check: `Object.values(state.stock ?? {}).every(q => Number.isInteger(q) && q >= 0)` },
	{ name: "prices-shape", check: `Object.values(state.prices ?? {}).every(p => typeof p === "number" && isFinite(p) && p >= 0)` },
	{ name: "known-keys", check: `Object.keys(state).every(k => k === "stock" || k === "prices")` },
];

export const GENERATORS: Record<string, (rand: () => number) => unknown> = {
	shop: (rand) => {
		const names = ["apple", "pear", "fig", "plum", "kiwi"];
		const stock = Object.fromEntries(names.filter(() => rand() < 0.7).map((n) => [n, Math.floor(rand() * 16)]));
		const prices = Object.fromEntries(Object.keys(stock).filter(() => rand() < 0.6).map((n) => [n, Math.round(rand() * 500) / 100]));
		return { stock, prices };
	},
};

const SELL = `function sell(name, qty) {
  const have = (state.stock || {})[name] || 0;
  if (!(Number.isInteger(qty) && qty > 0)) throw new Error("quantity must be a positive whole number");
  if (qty > have) throw new Error("not enough " + name);
  state.stock[name] = have - qty;
  return state.stock[name];
}`;

export const TURNS: Turn[] = [
	{
		user: "I run a small shop. Let me add stock: an item name and how many.",
		proposal: {
			intent: "add stock",
			scope: ["addItem"],
			forms: [`function addItem(name, qty) {
  state.stock = state.stock || {};
  state.stock[name] = (state.stock[name] || 0) + qty;
  return state.stock[name];
}`],
			examples: [ex({}, `addItem("apple", 10)`, 10), ex({ stock: { apple: 3 } }, `addItem("apple", 5)`, 8)],
		},
		use: [`addItem("apple", 12)`, `addItem("pear", 4)`, `addItem("fig", 7)`],
	},
	{
		user: "Record a sale. Never let stock go below zero: refuse the sale instead.",
		proposal: {
			intent: "sales",
			scope: ["sell"],
			forms: [SELL],
			examples: [ex(shelf, `sell("apple", 3)`, 7), ex(shelf, tryExpr(`sell("apple", 11)`), "rejected")],
		},
		use: [`sell("apple", 2)`, `sell("fig", 7)`],
	},
	{
		user: "What's running low? Anything with fewer than 5 left.",
		proposal: {
			intent: "low stock",
			scope: ["lowStock"],
			forms: [`function lowStock() {
  return Object.keys(state.stock || {}).filter(n => state.stock[n] < 5).sort();
}`],
			examples: [ex(shelf, `lowStock()`, ["fig", "pear"]), ex({}, `lowStock()`, [])],
		},
		use: [`lowStock()`],
	},
	{
		user: "Let me set a price per item, and tell me what my stock is worth. Items without a price count as nothing.",
		proposal: {
			intent: "stock value",
			scope: ["setPrice", "stockValue"],
			forms: [
				`function setPrice(name, price) {
  state.prices = state.prices || {};
  state.prices[name] = price;
  return price;
}`,
				`function stockValue() {
  let v = 0;
  for (const n of Object.keys(state.stock || {})) v += state.stock[n] * ((state.prices || {})[n] || 0);
  return Math.round(v * 100) / 100;
}`,
			],
			examples: [ex({ stock: { apple: 10, pear: 4 }, prices: { apple: 0.5 } }, `stockValue()`, 5), ex({ stock: { pear: 4 } }, `(setPrice("pear", 1.25), stockValue())`, 5)],
			properties: [{ name: "value-not-negative", gen: "shop", check: `stockValue() >= 0` }],
		},
		use: [`setPrice("apple", 0.4)`, `setPrice("pear", 0.75)`, `stockValue()`],
	},
	{
		user: "Give me a restock list: everything that's low, with how many to order to get back to 10.",
		proposal: {
			intent: "restock",
			scope: ["restock"],
			forms: [`function restock() {
  const out = {};
  for (const n of lowStock()) out[n] = 10 - state.stock[n];
  return out;
}`],
			examples: [ex(shelf, `restock()`, { fig: 10, pear: 6 })],
			properties: [{ name: "restock-tops-up-to-10", gen: "shop", check: `Object.entries(restock()).every(([n, k]) => state.stock[n] + k === 10)` }],
		},
		use: [`restock()`],
	},
	{
		user: "Item names shouldn't care about capitals or spaces: 'Apple ' and 'apple' are the same item.",
		proposal: {
			intent: "normalize names",
			scope: ["key", "addItem", "sell", "setPrice"],
			forms: [
				`function key(name) {
  return String(name).trim().toLowerCase();
}`,
				`function addItem(name, qty) {
  state.stock = state.stock || {};
  state.stock[key(name)] = (state.stock[key(name)] || 0) + qty;
  return state.stock[key(name)];
}`,
				SELL.replace("function sell(name, qty) {", "function sell(name, qty) {\n  name = key(name);"),
				`function setPrice(name, price) {
  state.prices = state.prices || {};
  state.prices[key(name)] = price;
  return price;
}`,
			],
			migrate: `(() => { const s = {}; for (const [n, q] of Object.entries(state.stock || {})) s[key(n)] = (s[key(n)] || 0) + q; state.stock = s; if (state.prices) { const p = {}; for (const [n, v] of Object.entries(state.prices)) p[key(n)] = v; state.prices = p; } })()`,
			examples: [ex({}, `(addItem("Apple ", 2), addItem("apple", 3))`, 5), ex({ stock: { apple: 3 } }, `sell("APPLE", 1)`, 2)],
		},
		use: [`addItem("Pear", 6)`, `lowStock()`],
	},
];

const SELL_BODY = (check: string, update = "state.stock[name] = have - qty;\n  return state.stock[name];") => `function sell(name, qty) {
  const have = (state.stock || {})[name] || 0;
  if (!(Number.isInteger(qty) && qty > 0)) throw new Error("quantity must be a positive whole number");
  ${check}
  ${update}
}`;

// Written before any run of this scenario.
export const MISREADINGS: Misreading[] = [
	{ turn: 1, id: "add-sets-count", reading: "how many = the count on the shelf, not how many arrived", forms: { addItem: `function addItem(name, qty) {
  state.stock = state.stock || {};
  state.stock[name] = qty;
  return qty;
}` } },
	{ turn: 1, id: "add-returns-kinds", reading: "returns how many different items there are", forms: { addItem: `function addItem(name, qty) {
  state.stock = state.stock || {};
  state.stock[name] = (state.stock[name] || 0) + qty;
  return Object.keys(state.stock).length;
}` } },
	{ turn: 2, id: "sell-clamps", reading: '"never below zero" as "stop at zero"', forms: { sell: SELL_BODY("", "state.stock[name] = Math.max(0, have - qty);\n  return state.stock[name];") } },
	{ turn: 2, id: "sell-keeps-one", reading: "refuses a sale that would empty the shelf", forms: { sell: SELL_BODY(`if (qty >= have) throw new Error("not enough " + name);`) } },
	{ turn: 2, id: "sell-returns-sold", reading: "returns how many were sold", forms: { sell: SELL_BODY(`if (qty > have) throw new Error("not enough " + name);`, "state.stock[name] = have - qty;\n  return qty;") } },
	{ turn: 3, id: "low-inclusive", reading: '"fewer than 5" as "5 or fewer"', forms: { lowStock: `function lowStock() {
  return Object.keys(state.stock || {}).filter(n => state.stock[n] <= 5).sort();
}` } },
	{ turn: 3, id: "low-not-out", reading: "out of stock is not 'low'", forms: { lowStock: `function lowStock() {
  return Object.keys(state.stock || {}).filter(n => state.stock[n] > 0 && state.stock[n] < 5).sort();
}` } },
	{ turn: 3, id: "low-with-counts", reading: "the low items with how many are left", forms: { lowStock: `function lowStock() {
  const out = {};
  for (const n of Object.keys(state.stock || {}).sort()) if (state.stock[n] < 5) out[n] = state.stock[n];
  return out;
}` } },
	{ turn: 4, id: "value-formatted", reading: "the worth as display text", forms: { stockValue: `function stockValue() {
  let v = 0;
  for (const n of Object.keys(state.stock || {})) v += state.stock[n] * ((state.prices || {})[n] || 0);
  return "$" + v.toFixed(2);
}` } },
	{ turn: 4, id: "value-unrounded", reading: "no rounding to cents", forms: { stockValue: `function stockValue() {
  let v = 0;
  for (const n of Object.keys(state.stock || {})) v += state.stock[n] * ((state.prices || {})[n] || 0);
  return v;
}` } },
	{ turn: 4, id: "value-prices-only", reading: "worth = the sum of the prices on the shelf labels", forms: { stockValue: `function stockValue() {
  let v = 0;
  for (const n of Object.keys(state.stock || {})) if (state.stock[n] > 0) v += (state.prices || {})[n] || 0;
  return Math.round(v * 100) / 100;
}` } },
	{ turn: 5, id: "restock-to-5", reading: "order back up to the low line (5)", forms: { restock: `function restock() {
  const out = {};
  for (const n of lowStock()) out[n] = 5 - state.stock[n];
  return out;
}` } },
	{ turn: 5, id: "restock-under-10", reading: "everything under 10, not just the low items", forms: { restock: `function restock() {
  const out = {};
  for (const n of Object.keys(state.stock || {}).sort()) if (state.stock[n] < 10) out[n] = 10 - state.stock[n];
  return out;
}` } },
	{ turn: 5, id: "restock-names", reading: "just the names to reorder", forms: { restock: `function restock() {
  return lowStock();
}` } },
	{ turn: 6, id: "key-no-trim", reading: "capitals only; spaces still matter", forms: { key: `function key(name) {
  return String(name).toLowerCase();
}` } },
	{ turn: 6, id: "key-title-case", reading: "names are stored as 'Apple'", forms: { key: `function key(name) {
  const s = String(name).trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}` } },
	{ turn: 6, id: "key-no-migration", reading: "new entries only; old names are left as they are", forms: {}, noMigration: true },
];

export const PROBES = [
	"lowStock()",
	"stockValue()",
	"restock()",
	`addItem("apple", 3)`,
	`addItem("Apple ", 2)`,
	`addItem("kiwi", 1)`,
	`(addItem("x", 1), addItem("x", 1))`,
	`sell("apple", 1)`,
	`sell("apple", 0)`,
	`sell("pear", 100)`,
	`sell("fig", (state.stock || {}).fig || 1)`,
	`setPrice("apple", 2)`,
	`key(" A ")`,
];
export const FIXTURES: unknown[] = [{ stock: { Apple: 3, apple: 2, " fig": 5 }, prices: { Apple: 1 } }, { stock: { a: 5, b: 4, c: 0, fig: 5 } }];
