// The JavaScript baseline kernel for PROTOCOL.md: the chat-grown-software World (a node:vm realm with frozen
// intrinsics) behind the language-neutral protocol. It is the yardstick the other ports are compared against.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { INVARIANTS as EXPENSE_INVARIANTS } from "../../prototype/src/scenario.ts";
import { INVARIANTS as GATEWAY_INVARIANTS } from "../scenario/gateway.reference.js";

const INVARIANTS = process.env.SCENARIO === "gateway" ? GATEWAY_INVARIANTS : EXPENSE_INVARIANTS;
import { World } from "../../prototype/src/world.ts";

type Call = { fn: string; args: unknown[] };
type Question = { fixture: unknown; calls: Call[] };
type Outcome = { value?: unknown; state?: unknown; throws?: boolean; error?: string; timeout?: boolean };
type Example = Question & { expect: Outcome; scope: string[] };
type Revision = { id: string; code_id: string; data_id: string; intent: string; scope: string[]; asked: unknown; functions: Record<string, string> };
type Trace = { before: unknown; call: Call; value: unknown };

const dir = process.argv[2] ?? "data";
mkdirSync(dir, { recursive: true });
const file = join(dir, "world.json");
let db = { generation: 0, revision: null as string | null, revisions: [] as Revision[], examples: [] as Example[], traces: [] as Trace[], requests: {} as Record<string, unknown>, state: {} as unknown };
if (existsSync(file)) db = JSON.parse(readFileSync(file, "utf8"));
const live = () => new World({ functions: db.revisions.find((r) => r.id === db.revision)?.functions ?? {}, state: db.state }, 1000);
let world = live();
const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(db)); renameSync(`${file}.tmp`, file); };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));

function same(a: unknown, b: unknown): boolean {
	if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
	const ka = Object.keys(a).filter((k) => k !== "error").sort(), kb = Object.keys(b).filter((k) => k !== "error").sort();
	return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as any)[k], (b as any)[k]));
}

/** Run calls on a fixture in a copy of `functions` (PROTOCOL.md outcomes; each call is a transaction). */
function run(functions: Record<string, string>, fixture: unknown, calls: Call[]): Outcome {
	const w = new World({ functions, state: clone(fixture) }, 1000);
	let value: unknown = null;
	for (const c of calls) {
		const before = w.state();
		if (!/^[a-z_][a-z0-9_]*$/.test(c.fn) || !(c.fn in functions)) return { throws: true, error: `no function ${c.fn}`, state: before };
		try {
			value = w.evaluate(`${c.fn}(${c.args.map((a) => JSON.stringify(a)).join(", ")})`);
		} catch (e) {
			const msg = String((e as Error).message);
			if (/timed out/.test(msg)) return { timeout: true };
			w.setState(before);
			return { throws: true, error: msg, state: before };
		}
	}
	return { value, state: w.state() };
}

function invariantProblem(functions: Record<string, string>, state: unknown): string | undefined {
	const w = new World({ functions: {}, state }, 1000);
	for (const inv of INVARIANTS) if (w.evaluate(inv.check) !== true) return `${inv.name} fails on ${JSON.stringify(state).slice(0, 120)}`;
	return undefined;
}

/** Candidate functions: live code plus forms minus removes; throws if a form does not load. */
function candidate(forms: string[], removes: string[] = []): Record<string, string> {
	const w = new World({ functions: Object.fromEntries(world.functions), state: {} }, 1000);
	for (const f of forms) w.define(f);
	for (const r of removes) w.remove(r);
	return Object.fromEntries(w.functions);
}

function develop(req: any) {
	if (req.generation !== db.generation) return { status: "stale" };
	const failed: { layer: string; detail: string }[] = [];
	let fns: Record<string, string>;
	try {
		fns = candidate(req.forms, req.removes);
	} catch (e) {
		return { status: "rejected", failed: [{ layer: "static", detail: String((e as Error).message) }] };
	}
	const scope: string[] = req.scope ?? [];
	const mine: Example[] = (req.examples ?? []).map((e: any) => ({ fixture: e.fixture, calls: e.calls, expect: e.expect, scope }));
	// an earlier example is superseded when all its functions are in scope and one of this turn's examples asks the same calls on the same fixture differently
	const kept = db.examples.filter((old) => !(old.calls.every((c) => scope.includes(c.fn)) && mine.some((m) => same(m.fixture, old.fixture) && same(m.calls, old.calls) && !same(m.expect, old.expect))));
	for (const ex of [...kept, ...mine]) {
		const got = run(fns, ex.fixture, ex.calls);
		if (!same(got, ex.expect)) { failed.push({ layer: "ratchet", detail: `${JSON.stringify(ex.calls)} gave ${JSON.stringify(got).slice(0, 150)}, confirmed ${JSON.stringify(ex.expect).slice(0, 150)}` }); break; }
	}
	const states = [db.state, ...mine.map((m) => run(fns, m.fixture, m.calls).state).filter((s) => s !== undefined)];
	for (const t of db.traces) {
		const got = run(fns, t.before, [t.call]);
		if (got.state !== undefined) states.push(got.state);
		if (got.timeout || got.throws) { failed.push({ layer: "traces", detail: `${t.call.fn}(${JSON.stringify(t.call.args)}) now ${got.timeout ? "times out" : `throws: ${got.error}`}` }); break; }
		if (!scope.includes(t.call.fn) && !same(got.value, t.value)) { failed.push({ layer: "traces", detail: `${t.call.fn} is out of scope but now returns ${JSON.stringify(got.value)} instead of ${JSON.stringify(t.value)}` }); break; }
	}
	for (const s of states) { const p = invariantProblem(fns, s); if (p) { failed.push({ layer: "invariants", detail: p }); break; } }
	if (failed.length) return { status: "rejected", failed };
	const id = `rev-${String(db.revisions.length + 1).padStart(4, "0")}`;
	db.revisions.push({ id, code_id: `code-${db.revisions.length + 1}`, data_id: `data-${db.traces.length}`, intent: req.intent, scope, asked: req.asked, functions: fns });
	db.examples = [...kept, ...mine];
	db.revision = id;
	db.generation++;
	world = live();
	save();
	return { status: "accepted", revision: id, generation: db.generation, failed: [] };
}

function handle(req: any): unknown {
	switch (req.op) {
		case "observe":
			return { generation: db.generation, revision: db.revision, functions: Object.fromEntries(world.functions), state: db.state };
		case "try":
			try {
				const fns = candidate(req.forms ?? [], req.removes);
				return { ok: true, outcomes: (req.questions ?? []).map((q: Question) => run(fns, q.fixture, q.calls)) };
			} catch (e) {
				return { ok: false, error: String((e as Error).message) };
			}
		case "develop":
			return develop(req);
		case "execute": {
			if (req.request_id !== undefined && req.request_id in db.requests) return { ...(db.requests[req.request_id] as object), replayed: true };
			const got = run(Object.fromEntries(world.functions), db.state, [req.call]);
			const result = got.throws || got.timeout ? { ok: false, error: got.error ?? "timeout" } : { ok: true, value: got.value, replayed: false };
			if (result.ok) { db.traces.push({ before: db.state, call: req.call, value: got.value }); db.state = got.state; world.setState(db.state); }
			if (req.request_id !== undefined) db.requests[req.request_id] = result;
			save();
			return result;
		}
		case "rollback": {
			const i = db.revisions.findIndex((r) => r.id === db.revision);
			const target = req.revision ? db.revisions.find((r) => r.id === req.revision) : db.revisions[i - 1];
			if (!target) return { ok: false, error: "no such revision" };
			const p = invariantProblem(target.functions, db.state);
			if (p) return { ok: false, error: p };
			for (const t of db.traces) { const got = run(target.functions, t.before, [t.call]); if (got.throws || got.timeout) return { ok: false, error: `trace ${t.call.fn} fails under ${target.id}` }; }
			db.revision = target.id;
			db.generation++;
			world = live();
			save();
			return { ok: true, revision: target.id, generation: db.generation };
		}
		case "why": {
			const current = db.revisions.find((r) => r.id === db.revision);
			const src = current?.functions[req.fn];
			if (src === undefined) return null;
			// the last revision (up to the current one) in which fn's source changed
			let found: Revision | undefined, prev: string | undefined;
			for (const r of db.revisions.slice(0, db.revisions.indexOf(current!) + 1)) { if (r.functions[req.fn] !== prev) found = r; prev = r.functions[req.fn]; }
			return found ? { revision: found.id, intent: found.intent, asked: found.asked } : null;
		}
		default:
			return { error: `unknown op ${req.op}` };
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	let out: unknown;
	try { out = handle(JSON.parse(line)); } catch (e) { out = { error: String((e as Error).message) }; }
	process.stdout.write(`${JSON.stringify(out)}\n`);
});
