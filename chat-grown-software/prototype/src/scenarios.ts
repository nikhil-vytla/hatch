// The scenarios, selected with SCENARIO=expenses (the default) or SCENARIO=shop.
import type { Invariant } from "./gates.ts";
import { MISREADINGS, type Misreading } from "./misreadings.ts";
import * as expenses from "./scenario.ts";
import * as shop from "./scenario-shop.ts";

export type Scenario = {
	name: string;
	turns: expenses.Turn[];
	invariants: Invariant[];
	generators: Record<string, (rand: () => number) => unknown>;
	misreadings: Misreading[];
	/** Expressions for the differential "does this behave differently?" oracle, beyond examples and traces. */
	probes: string[];
	/** Hand-picked states for that oracle, beyond the generated ones. */
	fixtures: unknown[];
};

export const SCENARIOS: Record<string, Scenario> = {
	expenses: {
		name: "expenses",
		turns: expenses.TURNS,
		invariants: expenses.INVARIANTS,
		generators: expenses.GENERATORS,
		misreadings: MISREADINGS,
		probes: ["total()", "byCategory()", "topCategory()", "overBudget()", `addExpense(5, "food")`, `addExpense(0, "food")`, `addExpense(-1, "x")`, `addExpense(2, "")`, `addExpense(1.5, "fun", "n")`, `setBudget("food", 20)`, `setBudget("rent", 0)`, "cents(0.125)", "cents(10)"],
		fixtures: [],
	},
	shop: { name: "shop", turns: shop.TURNS, invariants: shop.INVARIANTS, generators: shop.GENERATORS, misreadings: shop.MISREADINGS, probes: shop.PROBES, fixtures: shop.FIXTURES },
};

export function pick(): Scenario {
	const s = SCENARIOS[process.env.SCENARIO ?? "expenses"];
	if (s === undefined) throw new Error(`no scenario ${process.env.SCENARIO}; have ${Object.keys(SCENARIOS).join(", ")}`);
	return s;
}
