// The simulated user's knowledge: the JS reference program from chat-grown-software, run on language-neutral calls.
// It answers a question {fixture, calls} after turn i by what the intended program does (PROTOCOL.md outcomes).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INVARIANTS as EXPENSE_INVARIANTS, TURNS } from "../../chat-grown-software/prototype/src/scenario.ts";
import { intendedFunctions } from "../../chat-grown-software/prototype/src/sim-user.ts";
import { World } from "../../chat-grown-software/prototype/src/world.ts";
import { ROOT } from "./kernel-client.ts";

export type Call = { fn: string; args: unknown[] };
export type Question = { fixture: unknown; calls: Call[] };
export type Outcome = { value?: unknown; state?: unknown; throws?: boolean; error?: string; timeout?: boolean };

export const SCENARIO_NAME = process.env.SCENARIO ?? "expenses";
export const SCENARIO = JSON.parse(readFileSync(join(ROOT, "scenario", `${SCENARIO_NAME}.json`), "utf8"));
// A scenario with its own JS reference lists each turn's declarations with the protocol's names already.
const OWN: { TURNS: string[][]; INVARIANTS: { name: string; check: string }[] } | undefined = SCENARIO.reference ? await import(join(ROOT, "scenario", SCENARIO.reference)) : undefined;
const INVARIANTS = OWN?.INVARIANTS ?? EXPENSE_INVARIANTS;

/** The invariant a state breaks, if any. */
export function broken(state: unknown): string | undefined {
	const w = new World({ functions: {}, state });
	return INVARIANTS.find((inv) => w.evaluate(inv.check) !== true)?.name;
}
const NAMES: Record<string, string> = { add_expense: "addExpense", total: "total", by_category: "byCategory", set_budget: "setBudget", over_budget: "overBudget", top_category: "topCategory" };
const clone = <T>(v: T): T => (v === undefined ? (null as T) : JSON.parse(JSON.stringify(v)));

export function fixture(f: unknown): unknown {
	return clone(typeof f === "string" ? SCENARIO.fixtures[f] : f);
}

/** What the intended program (after `turn`) does with these calls on this fixture. */
export function intended(turn: number, q: Question): Outcome {
	const world = new World({ functions: OWN ? {} : intendedFunctions(TURNS, turn), state: fixture(q.fixture) });
	if (OWN) for (const forms of OWN.TURNS.slice(0, turn + 1)) for (const f of forms) world.define(f);
	let value: unknown = null;
	for (const c of q.calls) {
		const before = clone(world.state());
		const name = OWN ? (world.functions.has(c.fn) ? c.fn : undefined) : NAMES[c.fn];
		if (name === undefined) return { throws: true, error: `no function ${c.fn}`, state: before };
		try {
			value = clone(world.evaluate(`${name}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`));
			// The user's invariants hold from the first turn: a call the intended program would let break one, the
			// user says should fail (the reference program alone accepts e.g. a negative amount before turn 5).
			const inv = broken(world.state());
			if (inv !== undefined && broken(before) === undefined) return { throws: true, error: `breaks ${inv}`, state: before };
		} catch (e) {
			if (/timed out/.test(String((e as Error).message))) return { timeout: true };
			return { throws: true, error: String((e as Error).message), state: before };
		}
	}
	return { value, state: clone(world.state()) };
}

/** Outcome equality (PROTOCOL.md): deep JSON equality, key order ignored, numbers within 1e-9, and an outcome's
 * top-level `error` message not compared. */
export function same(a: unknown, b: unknown, top = true): boolean {
	if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i], false));
	const keep = (k: string) => !(top && k === "error");
	const ka = Object.keys(a).filter(keep).sort();
	const kb = Object.keys(b).filter(keep).sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as any)[k], (b as any)[k], false));
}

export const show = (v: unknown) => JSON.stringify(v)?.slice(0, 200);
