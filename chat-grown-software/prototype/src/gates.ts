// Verification for chat-grown software: what a proposed change must survive before the live world accepts it.
//
// The model writes code, but it never writes the acceptance contract. Each layer below is owned by the caller (the user
// and the harness), not by the model, following Jiti's ADR 0004/0008 ("model-generated implementation or a completion
// message cannot replace the acceptance contract"). Layers, cheapest first:
//
//   static      the forms compile, define functions, and call no function that does not exist
//   invariants  caller-owned predicates on the managed state, checked on the live state and after every run below
//   ratchet     every example the user confirmed in earlier turns still gives the confirmed answer
//   properties  caller-owned laws (e.g. "categories sum to the total") over seeded generated states
//   traces      replay of real use: (a) functions changed outside the request's declared scope must not change any
//               recorded outcome; (b) any recorded outcome that changes must involve a function in scope. Outcomes
//               that change inside scope are not failures: they are surfaced to the user as a behavior diff.
//   goals       the current request's own examples ("is it done?"); unmet goals block "done", not safety
//
// A timeout anywhere is a failure of the layer that ran the code.
import { declaredFunctions, type Snapshot, World } from "./world.ts";
import type { Trace } from "./store.ts";

export type Example = { fixture: unknown; expr: string; expect: unknown; turn?: number; call?: string };
export type Invariant = { name: string; check: string }; // an expression over `state` (and world functions) that must be true
export type Property = { name: string; gen: string; check: string; runs?: number };
export type Proposal = { intent: string; scope: string[]; forms: string[]; removes?: string[]; migrate?: string; examples: Example[]; properties?: Property[] };
export type Spec = { invariants: Invariant[]; examples: Example[]; properties: Property[] };

export const LAYERS = ["static", "invariants", "ratchet", "properties", "fuzz", "traces", "goals"] as const;
export type Layer = (typeof LAYERS)[number];
export type Verdict = { layer: Layer; ok: boolean; detail?: string };
export type Report = {
	verdicts: Verdict[];
	surfaced: { expr: string; before: unknown; after: unknown }[];
	/** Latent gaps found by fuzzing that the accepted version had too: not blocking, shown to the user. */
	advisories: string[];
	/** Functions in scope that no confirmed example of this turn ever calls: the contract does not cover them. */
	uncovered: string[];
	candidate?: Snapshot;
};

// Boundary-heavy argument pool for fuzzing: the values a person never types into an example.
const POOL = [0, -1, 1, 2.5, 0.1, 1e9, Number.NaN, "", "food", "x", null, undefined, true, [], {}];

const BUILTINS = new Set(
	"Math JSON Object Array String Number Boolean Error TypeError RangeError Date Set Map parseInt parseFloat isFinite isNaN Symbol Infinity NaN"
		.split(" "),
);
const KEYWORDS = new Set("if for while switch catch return typeof function new throw do else case await yield delete void in of".split(" "));

type Outcome = { value?: unknown; error?: string; timeout?: true };

function run(world: World, state: unknown, expr: string, trace = false): { outcome: Outcome; after: unknown; calls: string[] } {
	world.setState(state);
	try {
		if (trace) {
			const { value, calls } = world.traced(expr);
			return { outcome: { value }, after: world.state(), calls };
		}
		return { outcome: { value: world.evaluate(expr) }, after: world.state(), calls: [] };
	} catch (error) {
		const message = String((error as Error)?.message ?? error);
		if (/timed out/.test(message)) return { outcome: { timeout: true }, after: null, calls: [] };
		return { outcome: { error: "error" }, after: safeState(world), calls: [] };
	}
}

function safeState(world: World): unknown {
	try {
		return world.state();
	} catch {
		return null;
	}
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Build the candidate world: the live functions and state, then the proposal's forms, removals and migration. */
export function buildCandidate(base: Snapshot, proposal: Proposal): { world?: World; error?: string } {
	const world = new World(base);
	try {
		for (const name of proposal.removes ?? []) world.remove(name);
		for (const form of proposal.forms) world.define(form);
		if (proposal.migrate) world.evaluate(proposal.migrate);
		return { world };
	} catch (error) {
		return { error: String((error as Error).message) };
	}
}

/** Calls to names that are neither world functions, builtins, nor locals declared in the same function. */
export function unknownCalls(functions: Map<string, string>): string[] {
	const problems: string[] = [];
	for (const [name, source] of functions) {
		const locals = new Set([...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
		for (const m of source.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
			const callee = m[2];
			if (functions.has(callee) || BUILTINS.has(callee) || KEYWORDS.has(callee) || locals.has(callee) || callee === name) continue;
			if (source.slice(Math.max(0, (m.index ?? 0) - 9), m.index! + m[1].length).endsWith("function ")) continue;
			problems.push(`${name} calls unknown ${callee}()`);
		}
	}
	return problems;
}

export function checkInvariants(world: World, invariants: Invariant[], state: unknown): string | undefined {
	for (const inv of invariants) {
		const { outcome } = run(world, state, inv.check);
		if (outcome.value !== true) return `${inv.name} ${outcome.timeout ? "timed out" : `is ${JSON.stringify(outcome.value ?? outcome.error)}`}`;
	}
	return undefined;
}

export function verify(args: {
	base: Snapshot;
	proposal: Proposal;
	spec: Spec;
	traces: Trace[];
	generators: Record<string, (rand: () => number) => unknown>;
	layers?: readonly Layer[];
}): Report {
	const { base, proposal, spec, traces } = args;
	const layers = new Set(args.layers ?? LAYERS);
	const verdicts: Verdict[] = [];
	const surfaced: Report["surfaced"] = [];
	const advisories: string[] = [];
	const built = buildCandidate(base, proposal);
	if (built.world === undefined) {
		// Nothing else can run on a candidate that does not load.
		for (const layer of LAYERS) if (layers.has(layer)) verdicts.push({ layer, ok: false, detail: `does not load: ${built.error}` });
		return { verdicts, surfaced, advisories, uncovered: [] };
	}
	const world = built.world;
	const liveState = world.state();
	const candidate = world.snapshot();

	if (layers.has("static")) {
		const problems = unknownCalls(world.functions);
		const definesNothing = proposal.forms.some((f) => declaredFunctions(f).length === 0);
		verdicts.push({ layer: "static", ok: problems.length === 0 && !definesNothing, detail: problems.join("; ") || undefined });
	}

	if (layers.has("invariants")) {
		// The live state after the change, then the state after every example and every replayed trace.
		let problem = checkInvariants(world, spec.invariants, liveState);
		const states: unknown[] = [];
		for (const ex of [...spec.examples, ...proposal.examples]) {
			const r = run(world, ex.fixture, ex.expr);
			if (r.outcome.timeout) problem ??= `timed out running ${ex.expr}`;
			else states.push(r.after);
		}
		for (const t of traces) {
			const r = run(world, t.before, t.expr);
			if (r.outcome.timeout) problem ??= `timed out replaying ${t.expr}`;
			else if (r.outcome.error === undefined) states.push(r.after);
		}
		for (const s of states) problem ??= checkInvariants(world, spec.invariants, s);
		verdicts.push({ layer: "invariants", ok: problem === undefined, detail: problem });
	}

	if (layers.has("ratchet")) {
		let problem: string | undefined;
		for (const ex of spec.examples) {
			const r = run(world, ex.fixture, ex.expr);
			if (!same(r.outcome.value, ex.expect) || r.outcome.error || r.outcome.timeout) {
				problem = `turn ${ex.turn ?? "?"}: ${ex.expr} gave ${JSON.stringify(r.outcome.value ?? r.outcome.error ?? "timeout")}, confirmed ${JSON.stringify(ex.expect)}`;
				break;
			}
		}
		verdicts.push({ layer: "ratchet", ok: problem === undefined, detail: problem });
	}

	if (layers.has("properties")) {
		let problem: string | undefined;
		outer: for (const p of [...spec.properties, ...(proposal.properties ?? [])]) {
			let seed = 1;
			const rand = () => {
				seed = (seed * 16807) % 2147483647;
				return (seed - 1) / 2147483646;
			};
			for (let i = 0; i < (p.runs ?? 40); i++) {
				const state = args.generators[p.gen](rand);
				const r = run(world, state, p.check);
				if (r.outcome.value !== true) {
					problem = `${p.name} fails on ${JSON.stringify(state).slice(0, 160)}${r.outcome.timeout ? " (timeout)" : ""}`;
					break outer;
				}
			}
		}
		verdicts.push({ layer: "properties", ok: problem === undefined, detail: problem });
	}

	if (layers.has("fuzz")) {
		// Call functions with boundary arguments on a few generated states. Blocking: a hang anywhere in scope; a function
		// outside scope that behaves differently from the accepted version; an input on which the candidate corrupts the
		// state but the accepted version did not. Advisory: corruption the accepted version allowed too.
		let problem: string | undefined;
		const old = new World(base);
		const scope = new Set(proposal.scope);
		let seed = 3;
		const rand = () => {
			seed = (seed * 16807) % 2147483647;
			return (seed - 1) / 2147483646;
		};
		const states = [{}, ...Array.from({ length: 3 }, () => args.generators[Object.keys(args.generators)[0]](rand))];
		const lit = (v: unknown) => (v === undefined ? "undefined" : Number.isNaN(v) ? "NaN" : JSON.stringify(v));
		outer: for (const name of world.functions.keys()) {
			const arity = Number(world.evaluate(`${name}.length`));
			const tuples = arity === 0 ? [[]] : Array.from({ length: 24 }, () => Array.from({ length: arity }, () => POOL[Math.floor(rand() * POOL.length)]));
			for (const state of states) {
				for (const tuple of tuples) {
					const expr = `${name}(${tuple.map(lit).join(", ")})`;
					const now = run(world, state, expr);
					if (now.outcome.timeout) {
						problem = `${expr} hangs`;
						break outer;
					}
					const hadIt = base.functions[name] !== undefined;
					const was = hadIt ? run(old, state, expr) : undefined;
					if (!scope.has(name) && was && (!same(now.outcome, was.outcome) || !same(now.after, was.after))) {
						problem = `${name} is outside the request but ${expr} changed: ${JSON.stringify(was.outcome)} -> ${JSON.stringify(now.outcome)}`;
						break outer;
					}
					if (now.outcome.error !== undefined) continue;
					const broken = checkInvariants(world, spec.invariants, now.after);
					if (broken === undefined) continue;
					const brokeBefore = was !== undefined && was.outcome.error === undefined && checkInvariants(old, spec.invariants, was.after) !== undefined;
					if (hadIt && !brokeBefore) {
						problem = `${expr} now leaves ${broken} (the accepted version did not)`;
						break outer;
					}
					const note = `${expr} leaves ${broken}${hadIt ? " (as the accepted version does)" : ""}`;
					if (advisories.length < 50 && !advisories.includes(note)) advisories.push(note);
				}
			}
		}
		verdicts.push({ layer: "fuzz", ok: problem === undefined, detail: problem });
	}

	if (layers.has("traces")) {
		let problem: string | undefined;
		const changed = [...world.functions.keys()].filter((n) => base.functions[n] !== world.functions.get(n));
		const removed = Object.keys(base.functions).filter((n) => !world.functions.has(n));
		const scope = new Set(proposal.scope);
		const undeclared = [...changed, ...removed].filter((n) => !scope.has(n) && base.functions[n] !== undefined);
		// (a) Undeclared edits must be behavior-preserving: the old world plus only those edits replays every trace.
		if (undeclared.length > 0) {
			const hybrid = new World(base);
			for (const n of undeclared) {
				if (world.functions.has(n)) hybrid.define(world.functions.get(n)!);
				else hybrid.remove(n);
			}
			for (const t of traces) {
				const r = run(hybrid, t.before, t.expr);
				if (r.outcome.timeout || !same(r.outcome.value, t.value) || !same(r.after, t.after)) {
					problem = `undeclared change to ${undeclared.join(", ")} alters ${t.expr}`;
					break;
				}
			}
		}
		// (b) Every outcome that changes must be explained by the request's scope.
		if (problem === undefined) {
			for (const t of traces) {
				const r = run(world, t.before, t.expr, true);
				if (r.outcome.timeout) {
					problem = `replaying ${t.expr} timed out`;
					break;
				}
				const diff = !same(r.outcome.value, t.value) || !same(r.after, t.after) || r.outcome.error !== undefined;
				if (!diff) continue;
				const involved = new Set([...t.calls, ...r.calls]);
				const after = same(r.outcome.value, t.value) && r.outcome.error === undefined ? `${JSON.stringify(t.value)}, but the state after differs` : (r.outcome.value ?? r.outcome.error);
				if ([...involved].some((n) => scope.has(n))) surfaced.push({ expr: t.expr, before: t.value, after });
				else {
					problem = `${t.expr} changed (${JSON.stringify(t.value)} -> ${JSON.stringify(r.outcome.value ?? r.outcome.error)}) without touching ${[...scope].join(", ")}`;
					break;
				}
			}
		}
		verdicts.push({ layer: "traces", ok: problem === undefined, detail: problem });
	}

	if (layers.has("goals")) {
		let problem: string | undefined;
		for (const ex of proposal.examples) {
			const r = run(world, ex.fixture, ex.expr);
			if (!same(r.outcome.value, ex.expect) || r.outcome.error || r.outcome.timeout) {
				problem = `${ex.expr} gave ${JSON.stringify(r.outcome.value ?? r.outcome.error ?? "timeout")}, asked for ${JSON.stringify(ex.expect)}`;
				break;
			}
		}
		verdicts.push({ layer: "goals", ok: problem === undefined, detail: problem });
	}

	// Coverage of the contract: does some confirmed example of this turn exercise each function in scope?
	const covered = new Set<string>();
	for (const ex of proposal.examples) for (const c of run(world, ex.fixture, ex.expr, true).calls) covered.add(c);
	const uncovered = proposal.scope.filter((n) => world.functions.has(n) && !covered.has(n));

	return { verdicts, surfaced, advisories, uncovered, candidate };
}
