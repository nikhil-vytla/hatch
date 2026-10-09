// Which contract catches a misunderstanding? Each misreading (misreadings.ts) is a coherent program for one turn that
// does the wrong thing. It goes through every layer against the world, contract and use-traces as they stood before
// that turn, under three contracts:
//
//   self     the model's own examples: its proposed calls, with the answers its own program gives (self-graded)
//   written  the examples the user confirmed in the scenario as written (they had to think of them)
//   chat     the kernel's questions about the misread candidate (proposed calls, boundaries from the user's words,
//            uncovered functions), answered by the simulated user from the intended program
//
// The earlier turns' contract (the ratchet) is the as-written one for self and written, and the chat one for chat.
//   node --experimental-strip-types --no-warnings src/misunderstanding-eval.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmed, questions } from "./ask.ts";
import { chatContract } from "./chat.ts";
import { buildCandidate, checkInvariants, type Example, LAYERS, type Layer, type Proposal, type Spec, verify } from "./gates.ts";
import { Kernel } from "./kernel.ts";
import type { Misreading } from "./misreadings.ts";
import type { Turn } from "./scenario.ts";
import { pick } from "./scenarios.ts";
import { answer, intendedFunctions } from "./sim-user.ts";
import type { Trace } from "./store.ts";
import { declaredFunctions, type Snapshot, type World } from "./world.ts";

type Start = { base: Snapshot; spec: Spec; traces: Trace[] };
const SCENARIO = pick();
const { turns: TURNS, invariants: INVARIANTS, generators: GENERATORS, misreadings: MISREADINGS } = SCENARIO;

function replay(turns: Turn[]): Start[] {
	const dir = mkdtempSync(join(tmpdir(), "grown-mis-"));
	const k = new Kernel(dir, { spec: { invariants: INVARIANTS, examples: [], properties: [] }, generators: GENERATORS });
	const starts: Start[] = [];
	for (const t of turns) {
		starts.push({ base: k.world.snapshot(), spec: structuredClone(k.spec), traces: k.store.traces() });
		const r = k.develop(t.proposal, k.generation);
		if (r.revision === undefined || (r.failed ?? []).length > 0) throw new Error(`turn ${t.proposal.intent}: ${r.status}`);
		for (const e of t.use) k.execute(e);
	}
	rmSync(dir, { recursive: true, force: true });
	return starts;
}

const misread = (p: Proposal, m: Misreading): Proposal => {
	const names = p.forms.map((f) => declaredFunctions(f)[0]);
	const forms = p.forms.map((f, i) => m.forms[names[i]] ?? f);
	for (const [n, src] of Object.entries(m.forms)) if (!names.includes(n)) forms.push(src);
	return { ...p, forms, migrate: m.noMigration ? undefined : p.migrate };
};

const evaluate = (w: World, state: unknown, expr: string): string => {
	w.setState(state);
	try {
		return JSON.stringify([w.evaluate(expr), w.state()]);
	} catch (e) {
		return /timed out/.test(String((e as Error).message)) ? "timeout" : "error";
	}
};

// Ground truth: does the misreading behave differently from the intended program on generated states and probes?
let seed = 11;
const rand = () => {
	seed = (seed * 16807) % 2147483647;
	return (seed - 1) / 2147483646;
};
const FIXTURES: unknown[] = [{}, ...Array.from({ length: 40 }, () => GENERATORS[Object.keys(GENERATORS)[0]](rand)), ...SCENARIO.fixtures];
// Probes that tell readings apart: the scenario's, plus (for expenses) the ones added for its misreadings.
const PROBES = [
	...SCENARIO.probes,
	...(SCENARIO.name === "expenses" ? [`addExpense(5, "Food")`, `addExpense(2)`, `addExpense(1.5, "fun", "")`, `(addExpense(1, "a"), addExpense(2, "b"), state.expenses[0])`, `(setBudget("food", 20), setBudget("food", 20))`, "cents(0.29)"] : []),
];
const FIXTURES_EXTRA = SCENARIO.name === "expenses" ? [{ expenses: [{ amount: 5, category: "b" }, { amount: 5, category: "a" }], budgets: { a: 5 } }] : [];
FIXTURES.push(...FIXTURES_EXTRA);

function differs(base: Snapshot, a: Proposal, b: Proposal): boolean {
	const wa = buildCandidate(base, a).world!;
	const wb = buildCandidate(base, b).world;
	if (wb === undefined) return true;
	if (JSON.stringify(wa.state()) !== JSON.stringify(wb.state())) return true; // a migration that differs on the live data
	const usable = PROBES.filter((e) => [...e.matchAll(/([A-Za-z_$][\w$]*)\(/g)].every((m) => wa.functions.has(m[1])));
	return FIXTURES.some((s) => usable.some((e) => evaluate(wa, s, e) !== evaluate(wb, s, e)));
}

const asWritten = replay(TURNS);
const chatTurns = await chatContract(SCENARIO);
const asChat = replay(chatTurns);

type Row = { id: string; turn: number; reading: string; real: boolean; contract: string; killed: Record<Layer, boolean>; surfaced: number; corrections: number };
const rows: Row[] = [];
for (const m of MISREADINGS) {
	const t = m.turn - 1;
	const turn = TURNS[t];
	const wrong = misread(turn.proposal, m);
	const real = differs(asWritten[t].base, turn.proposal, wrong);
	const calls = turn.proposal.examples.map((e) => ({ fixture: e.fixture, expr: e.call ?? e.expr, call: e.call ?? e.expr }));
	for (const contract of ["self", "written", "chat"] as const) {
		const start = contract === "chat" ? asChat[t] : asWritten[t];
		const built = buildCandidate(start.base, wrong);
		let examples: Example[];
		let corrections = 0;
		if (contract === "written") examples = turn.proposal.examples;
		else if (contract === "self")
			examples = calls.map((c) => {
				const out = evaluate(built.world!, c.fixture, c.expr);
				return { ...c, expect: out === "error" || out === "timeout" ? out : JSON.parse(out)[0] };
			});
		else {
			const history = [...start.spec.examples.map((e) => e.call ?? e.expr), ...start.traces.map((tr) => tr.expr)];
			const valid = (s: unknown) => checkInvariants(built.world!, start.spec.invariants, s) === undefined;
			const qs = questions({ candidate: built.world!, proposal: { ...wrong, examples: calls.map((c) => ({ ...c, expect: undefined })) }, words: turn.user, history, valid }).questions;
			const fns = intendedFunctions(TURNS, t);
			const answers = qs.map((q) => answer(fns, q));
			corrections = qs.filter((q, i) => JSON.stringify(q.answer) !== JSON.stringify(answers[i])).length;
			examples = confirmed(qs, answers);
		}
		const report = verify({ base: start.base, proposal: { ...wrong, examples }, spec: start.spec, traces: start.traces, generators: GENERATORS });
		const killed = Object.fromEntries(LAYERS.map((l) => [l, report.verdicts.find((v) => v.layer === l)?.ok === false])) as Record<Layer, boolean>;
		rows.push({ id: m.id, turn: m.turn, reading: m.reading, real, contract, killed, surfaced: report.surfaced.length, corrections });
	}
}

// --- report ---
const SAFETY: Layer[] = ["static", "invariants", "ratchet", "properties", "fuzz", "traces"];
const caught = (r: Row) => LAYERS.some((l) => r.killed[l]);
const mark = (r: Row) => (caught(r) ? LAYERS.filter((l) => r.killed[l]).join("+") : r.surfaced > 0 ? `missed; ${r.surfaced} behavior diff(s) shown` : "MISSED");
const lines: string[] = [];
const real = MISREADINGS.filter((m) => rows.find((r) => r.id === m.id)!.real);
lines.push(`misreadings: ${MISREADINGS.length} (${real.length} behave differently from the intended program on the probes)`);
lines.push("");
lines.push("| turn | misreading | self-graded | as-written examples | kernel's questions (user corrected) |");
lines.push("|---|---|---|---|---|");
for (const m of MISREADINGS) {
	const rs = (c: string) => rows.find((r) => r.id === m.id && r.contract === c)!;
	lines.push(`| ${m.turn} | ${m.id}: ${m.reading}${rs("self").real ? "" : " (no observable difference)"} | ${mark(rs("self"))} | ${mark(rs("written"))} | ${mark(rs("chat"))} (${rs("chat").corrections}) |`);
}
lines.push("");
lines.push("| contract | caught (any layer) | by safety layers alone | by goals (this turn's examples) | missed, but a behavior diff was shown | missed silently |");
lines.push("|---|---|---|---|---|---|");
const pct = (n: number, d: number) => `${n}/${d} (${Math.round((100 * n) / d)}%)`;
for (const c of ["self", "written", "chat"]) {
	const rs = rows.filter((r) => r.contract === c && r.real);
	lines.push(`| ${c} | ${pct(rs.filter(caught).length, rs.length)} | ${pct(rs.filter((r) => SAFETY.some((l) => r.killed[l])).length, rs.length)} | ${pct(rs.filter((r) => r.killed.goals).length, rs.length)} | ${rs.filter((r) => !caught(r) && r.surfaced > 0).length} | ${rs.filter((r) => !caught(r) && r.surfaced === 0).length} |`);
}
const text = lines.join("\n");
console.log(text);
const tag = `${SCENARIO.name === "expenses" ? "" : `-${SCENARIO.name}`}${process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : ""}`;
writeFileSync(join(import.meta.dirname, "..", "results", `misunderstanding-eval${tag}.md`), `${text}\n`);
writeFileSync(join(import.meta.dirname, "..", "results", `misunderstanding-eval${tag}.json`), JSON.stringify(rows, null, 1));
