// What the kernel asks the user before a change counts as done.
//
// The model may propose example *calls*, but it never supplies the expected answers: the kernel runs each call on the
// candidate and shows the user what it does (the value and the state after), and only the user's answer becomes the
// expectation. Five sources of questions (ASK_RULES picks the rule set, below):
//   1. the calls the model proposed;
//   2. boundary variants of those calls, taken from the user's own words ("zero or less" -> 0 and -1, "without a
//      category" -> "");
//   3. data boundaries: numbers the user says, put into the state each proposed call runs on;
//   4. repetition: each state-changing call asked twice in a row;
//   5. coverage: a function in scope that no question calls gets a call built from argument values already seen in
//      this chat (examples and real use). The kernel refuses "done" while any function in scope stays uncovered.
//
// Every question observes both the value and the effect, because round 3 of the mutation study showed an example that
// checks only the state misses a dropped `return`.
import type { Example, Proposal } from "./gates.ts";
import { World } from "./world.ts";

export type Question = { fixture: unknown; call: string; expr: string; why: string; answer?: unknown };

/** Wrap a call so its outcome shows both what it returned (or that it threw) and the state it left. */
export const watch = (call: string) =>
	`(() => { try { const value = (${call}); return { value: value === undefined ? null : value, state }; } catch (e) { return { throws: true, state }; } })()`;

// Which rule set: v1 (as first designed), v2 (+ repetition), v3 (+ data boundaries, coverage needs an observed result).
const RULES = Number((process.env.ASK_RULES ?? "v3").slice(1));

// Words a user says that name a boundary, and the literal each one implies.
const NUMBER_WORDS: [RegExp, number[]][] = [
	[/\bzero\b|\b0\b|\bnothing\b/i, [0]],
	[/\bless\b|\bnegative\b|\bbelow\b|\bminus\b/i, [-1]],
	[/\bpositive\b/i, [0]],
];
const STRING_WORDS: [RegExp, string[]][] = [[/\bwithout\b|\bempty\b|\bblank\b|\bmissing\b/i, [""]]];

/** Literal arguments of the top-level calls in an expression: numbers and double-quoted strings. */
function literals(expr: string): { index: number; text: string; kind: "number" | "string" }[] {
	const out: { index: number; text: string; kind: "number" | "string" }[] = [];
	for (const m of expr.matchAll(/"(?:[^"\\]|\\.)*"|(?<![\w.$])-?\d+(?:\.\d+)?(?![\w.])/g)) {
		const before = expr.slice(0, m.index).trimEnd();
		if (!before.endsWith("(") && !before.endsWith(",")) continue; // only call arguments, not indexes or results
		out.push({ index: m.index!, text: m[0], kind: m[0].startsWith('"') ? "string" : "number" });
	}
	return out;
}

/** Argument values seen anywhere in the chat so far, by kind, to build calls for uncovered functions. */
function seenValues(exprs: string[]): { number: unknown[]; string: unknown[] } {
	const seen = { number: new Set<string>(), string: new Set<string>() };
	for (const e of exprs) for (const l of literals(e)) if (l.text !== '""' && !l.text.startsWith("-") && l.text !== "0") seen[l.kind].add(l.text);
	return { number: [...seen.number].map(Number), string: [...seen.string].map((s) => JSON.parse(s)) };
}

export function questions(args: {
	candidate: World;
	proposal: Proposal;
	words: string;
	history: string[];
	/** Whether a state is acceptable (the invariants): a coverage call must not corrupt the state it runs on. */
	valid: (state: unknown) => boolean;
}): { questions: Question[]; uncovered: string[] } {
	const { candidate, proposal, words } = args;
	const out: Question[] = [];
	const add = (fixture: unknown, call: string, why: string) => {
		if (out.some((q) => q.call === call && JSON.stringify(q.fixture) === JSON.stringify(fixture))) return;
		out.push({ fixture, call, expr: watch(call), why });
	};
	for (const ex of proposal.examples) add(ex.fixture, ex.call ?? ex.expr, "the model proposed this call");
	// Boundaries the user named.
	for (const ex of proposal.examples) {
		const call = ex.call ?? ex.expr;
		for (const lit of literals(call)) {
			const table = lit.kind === "number" ? NUMBER_WORDS : STRING_WORDS;
			for (const [re, values] of table) {
				if (!re.test(words)) continue;
				for (const v of values) {
					const text = JSON.stringify(v);
					if (text === lit.text) continue;
					add(ex.fixture, call.slice(0, lit.index) + text + call.slice(lit.index + lit.text.length), `you said "${words.match(re)![0]}"`);
				}
			}
		}
	}
	// Data boundaries (v3, added after the shop scenario, see NOTES): a number the user says ("fewer than 5", "back to
	// 10", "zero") is also tried as a value in the state each proposed call runs on, one numeric field at a time.
	if (RULES >= 3) {
		const numbers = new Set<number>();
		for (const m of words.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?!\w|\.\d)/g)) numbers.add(Number(m[0]));
		if (NUMBER_WORDS[0][0].test(words)) numbers.add(0);
		for (const ex of proposal.examples) {
			let added = 0;
			for (const path of numericLeaves(ex.fixture).slice(0, 8)) {
				for (const n of numbers) {
					const fixture = setAt(ex.fixture, path, n);
					if (JSON.stringify(fixture) === JSON.stringify(ex.fixture) || !args.valid(fixture) || added >= 8) continue;
					add(fixture, ex.call ?? ex.expr, `you said "${n}": ${path.join(".")} = ${n}`);
					added++;
				}
			}
		}
	}
	// Coverage: every function in scope must be called by some question. From v3 a function counts only when a
	// question observes its own result (a direct call, an array element, or the last part of a comma expression):
	// `(setPrice("pear", 1.25), stockValue())` calls setPrice but throws its return value away.
	const covered = new Set<string>();
	const coverOf = (q: Question) => {
		candidate.setState(q.fixture);
		const direct = new Set([...q.call.matchAll(/(?:^|\[\s*|,\s*)([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));
		try {
			for (const c of candidate.traced(q.expr).calls) if (RULES < 3 || direct.has(c)) covered.add(c);
		} catch {}
	};
	out.forEach(coverOf);
	const seen = seenValues([...args.history, ...proposal.examples.map((e) => e.call ?? e.expr)]);
	for (const name of proposal.scope) {
		if (covered.has(name) || !candidate.functions.has(name)) continue;
		const arity = Number(candidate.evaluate(`${name}.length`));
		// Try argument tuples from what the user has already typed: strings and numbers in each position.
		const choices = [...seen.string.slice(0, 2), ...seen.number.slice(0, 2)];
		const tuples: unknown[][] = arity === 0 ? [[]] : cartesian(arity, choices).slice(0, 40);
		for (const tuple of tuples) {
			const call = `${name}(${tuple.map((v) => JSON.stringify(v)).join(", ")})`;
			candidate.setState({});
			let ok = true;
			try {
				candidate.evaluate(call);
				ok = args.valid(candidate.state());
			} catch {
				ok = false;
			}
			if (!ok) continue;
			add({}, call, `no call you have confirmed exercises ${name}()`);
			coverOf(out.at(-1)!);
			break;
		}
	}
	// Repetition (added after the first misunderstanding run, see NOTES): a call that changes state is also asked twice
	// in a row, which separates "set" from "add to", and "replace" from "append". ASK_RULES=v1 turns it off.
	if (RULES >= 2) {
		for (const q of [...out]) {
			if (q.why.startsWith("you said")) continue;
			candidate.setState(q.fixture);
			let changes = false;
			try {
				candidate.evaluate(q.call);
				changes = JSON.stringify(candidate.state()) !== JSON.stringify(q.fixture ?? {});
			} catch {}
			if (changes) add(q.fixture, `[${q.call}, ${q.call}]`, "the same call twice: does it set, or add to?");
		}
	}
	for (const q of out) {
		candidate.setState(q.fixture);
		try {
			q.answer = candidate.evaluate(q.expr);
		} catch (e) {
			q.answer = /timed out/.test(String((e as Error).message)) ? "timeout" : "error";
		}
	}
	return { questions: out, uncovered: proposal.scope.filter((n) => candidate.functions.has(n) && !covered.has(n)) };
}

/** Paths to the numeric values inside a fixture, e.g. ["stock", "apple"]. */
function numericLeaves(value: unknown, path: string[] = []): string[][] {
	if (typeof value === "number") return [path];
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([k, v]) => numericLeaves(v, [...path, k]));
}

function setAt(value: unknown, path: string[], n: number): unknown {
	const copy = structuredClone(value) as Record<string, unknown>;
	let at = copy;
	for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
	at[path.at(-1)!] = n;
	return copy;
}

function cartesian(n: number, choices: unknown[]): unknown[][] {
	if (n === 0) return [[]];
	return cartesian(n - 1, choices).flatMap((t) => choices.map((c) => [...t, c]));
}

/** The user's answers turn questions into the contract: an answer the user gives is the expectation. */
export function confirmed(qs: Question[], answers: unknown[]): Example[] {
	return qs.map((q, i) => ({ fixture: q.fixture, expr: q.expr, call: q.call, expect: answers[i] }));
}
