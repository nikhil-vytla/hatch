// Which verification layer catches which kind of model mistake?
//
// For every turn of the scenario, take the proposal a model would make and generate first-order mutants of it, the
// kinds of slips LLM-written code shows: a flipped operator, an off-by-one constant, a dropped line, a stray write to
// state, a hang, a renamed callee, and a "drive-by" edit to a function the request was not about. Each mutant goes
// through every layer independently against the world, contract and use-traces as they stood before that turn.
//
// Ground truth for "is this mutant actually wrong?" is a differential test: the mutant and the original candidate are
// run on many generated states and probe expressions; a mutant with no observed difference is counted as (likely)
// equivalent and excluded from catch rates.
//
//   node --experimental-strip-types --no-warnings src/mutation-eval.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCandidate, LAYERS, type Layer, type Proposal, type Spec, verify } from "./gates.ts";
import { Kernel } from "./kernel.ts";
import type { Trace } from "./store.ts";
import { chatContract } from "./chat.ts";
import { pick } from "./scenarios.ts";
import { declaredFunctions, extractDeclaration, type Snapshot, type World } from "./world.ts";

type Mutant = { turn: number; cls: string; where: string; proposal: Proposal };

// --- mutation operators over one function's source ---
const OPS: [string, RegExp, string][] = [
	["arith", / \+ /g, " - "],
	["arith", / - /g, " + "],
	["arith", / \* /g, " / "],
	["arith", / \/ /g, " * "],
	["relational", / > /g, " >= "],
	["relational", / >= /g, " > "],
	["relational", / < /g, " <= "],
	["relational", / <= /g, " < "],
	["relational", / === /g, " !== "],
	["relational", / !== /g, " === "],
	["logical", / && /g, " || "],
	["logical", / \|\| /g, " && "],
	["constant", /(?<![\w.$])(\d+(?:\.\d+)?)(?![\w.])/g, "NUM"],
];

function siteMutations(source: string): { cls: string; where: string; source: string }[] {
	const out: { cls: string; where: string; source: string }[] = [];
	const body = source.indexOf("{"); // never mutate the declaration line
	for (const [cls, re, rep] of OPS) {
		for (const m of source.matchAll(re)) {
			if (m.index! < body) continue;
			const replacement = rep === "NUM" ? String(Number(m[1]) === 0 ? 1 : Number(m[1]) + 1) : rep;
			out.push({ cls, where: `${m[0].trim()} -> ${replacement.trim()} @${m.index}`, source: source.slice(0, m.index) + replacement + source.slice(m.index! + m[0].length) });
		}
	}
	// Drop one statement line (only lines whose braces balance, so the result still parses).
	const lines = source.split("\n");
	for (let i = 1; i < lines.length - 1; i++) {
		const l = lines[i];
		if (l.trim() === "" || (l.match(/{/g)?.length ?? 0) !== (l.match(/}/g)?.length ?? 0)) continue;
		out.push({ cls: "line-delete", where: `drop "${l.trim().slice(0, 40)}"`, source: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") });
	}
	// A stray write: the model "helpfully" caches something in the managed state.
	out.push({ cls: "stray-write", where: "state.cache = {}", source: source.replace("{", "{\n  state.cache = {};") });
	// A hang.
	out.push({ cls: "hang", where: "while (true) {}", source: source.replace("{", "{\n  while (true) {}") });
	return out;
}

function mutants(turn: number, proposal: Proposal, base: Snapshot): Mutant[] {
	const out: Mutant[] = [];
	for (const [fi, form] of proposal.forms.entries()) {
		const name = declaredFunctions(form)[0];
		for (const m of siteMutations(form)) {
			out.push({ turn, cls: m.cls, where: `${name}: ${m.where}`, proposal: { ...proposal, forms: proposal.forms.map((f, j) => (j === fi ? m.source : f)) } });
		}
		// Rename a callee: the model calls a helper by a name that does not exist.
		for (const callee of Object.keys(base.functions).concat(proposal.forms.map((f) => declaredFunctions(f)[0]))) {
			if (callee === name || !new RegExp(`\\b${callee}\\(`).test(form)) continue;
			out.push({ turn, cls: "callee-rename", where: `${name}: ${callee}() -> ${callee}2()`, proposal: { ...proposal, forms: proposal.forms.map((f, j) => (j === fi ? f.replace(new RegExp(`\\b${callee}\\(`, "g"), `${callee}2(`) : f)) } });
		}
	}
	// Drive-by: the same slips, but in an existing function outside the request's scope, slipped into the forms.
	for (const [name, source] of Object.entries(base.functions)) {
		if (proposal.scope.includes(name)) continue;
		for (const m of siteMutations(source)) {
			if (m.cls === "hang") continue;
			out.push({ turn, cls: "drive-by", where: `${name}: ${m.cls} ${m.where}`, proposal: { ...proposal, forms: [...proposal.forms, m.source] } });
		}
	}
	return out;
}

// --- ground truth: differential testing against the unmutated candidate ---
function probes(spec: Spec, proposal: Proposal, traces: Trace[]): string[] {
	const exprs = new Set<string>([...spec.examples, ...proposal.examples].map((e) => e.expr));
	for (const t of traces) exprs.add(t.expr);
	for (const p of [...spec.properties, ...(proposal.properties ?? [])]) exprs.add(p.check);
	for (const f of SCENARIO.probes) exprs.add(f);
	return [...exprs];
}

function outcome(world: World, state: unknown, expr: string): string {
	world.setState(state);
	try {
		const v = world.evaluate(expr);
		return JSON.stringify([v, world.state()]);
	} catch (e) {
		return /timed out/.test(String((e as Error).message)) ? "timeout" : "error";
	}
}

function differs(base: Snapshot, original: Proposal, mutant: Proposal, exprs: string[], fixtures: unknown[]): boolean {
	const a = buildCandidate(base, original).world;
	const b = buildCandidate(base, mutant).world;
	if (a === undefined) throw new Error("original candidate does not build");
	if (b === undefined) return true;
	const usable = exprs.filter((e) => [...e.matchAll(/([A-Za-z_$][\w$]*)\(/g)].every((m) => !/^[a-z]/.test(m[1]) || a.functions.has(m[1]) || ["isFinite"].includes(m[1])));
	for (const state of fixtures) {
		for (const expr of usable) if (outcome(a, state, expr) !== outcome(b, state, expr)) return true;
	}
	return false;
}

// CONTRACT=chat: each turn's examples are exactly what the kernel's questions collected in a chat run (the model's
// proposed calls, boundaries from the user's words, coverage calls), answered by the simulated user. Nothing added by hand.
const SCENARIO = pick();
const { invariants: INVARIANTS, generators: GENERATORS } = SCENARIO;
const TURNS = process.env.CONTRACT === "chat" ? await chatContract(SCENARIO) : SCENARIO.turns;

// --- replay the scenario to get each turn's starting point ---
const dir = mkdtempSync(join(tmpdir(), "grown-eval-"));
const kernel = new Kernel(dir, { spec: { invariants: INVARIANTS, examples: [], properties: [] }, generators: GENERATORS });
const starts: { base: Snapshot; spec: Spec; traces: Trace[] }[] = [];
for (const turn of TURNS) {
	starts.push({ base: kernel.world.snapshot(), spec: structuredClone(kernel.spec), traces: kernel.store.traces() });
	const r = kernel.develop(turn.proposal, kernel.generation);
	// "accepted-incomplete" only for coverage (the as-written contract leaves setBudget uncovered); every layer must pass.
	if (r.revision === undefined || (r.failed ?? []).length > 0) throw new Error(`scenario turn "${turn.proposal.intent}" was ${r.status}: ${JSON.stringify(r.report?.verdicts)}`);
	for (const expr of turn.use) kernel.execute(expr);
}

let seed = 7;
const rand = () => {
	seed = (seed * 16807) % 2147483647;
	return (seed - 1) / 2147483646;
};
const fixtures: unknown[] = [{}, ...Array.from({ length: 60 }, () => GENERATORS[Object.keys(GENERATORS)[0]](rand)), ...SCENARIO.fixtures];

type Row = { turn: number; cls: string; where: string; equivalent: boolean; killed: Record<Layer, boolean>; surfaced: number; advisories: number };
const rows: Row[] = [];
const falsePositives: string[] = [];
const contractNotes: string[] = [];
const started = performance.now();
for (const [t, turn] of TURNS.entries()) {
	const { base, spec, traces } = starts[t];
	const legit = verify({ base, proposal: turn.proposal, spec, traces, generators: GENERATORS });
	for (const v of legit.verdicts) if (!v.ok) falsePositives.push(`turn ${t + 1} ${v.layer}: ${v.detail}`);
	contractNotes.push(`turn ${t + 1} (${turn.proposal.intent}): uncovered ${JSON.stringify(legit.uncovered)}; ${legit.advisories.length} fuzz advisories, e.g. ${JSON.stringify(legit.advisories.filter((a) => !a.includes("as the accepted")).slice(0, 2))}`);
	const exprs = probes(spec, turn.proposal, traces);
	const turnFixtures = [...fixtures, ...[...spec.examples, ...turn.proposal.examples].map((e) => e.fixture), ...traces.map((tr) => tr.before)];
	for (const m of mutants(t + 1, turn.proposal, base)) {
		const report = verify({ base, proposal: m.proposal, spec, traces, generators: GENERATORS });
		const killed = Object.fromEntries(LAYERS.map((l) => [l, report.verdicts.find((v) => v.layer === l)?.ok === false])) as Record<Layer, boolean>;
		rows.push({ turn: t + 1, cls: m.cls, where: m.where, equivalent: !differs(base, turn.proposal, m.proposal, exprs, turnFixtures), killed, surfaced: report.surfaced.length, advisories: report.advisories.filter((a) => !legit.advisories.includes(a)).length });
	}
}
const ms = Math.round(performance.now() - started);
rmSync(dir, { recursive: true, force: true });

// --- report ---
const real = rows.filter((r) => !r.equivalent);
const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
const classes = [...new Set(rows.map((r) => r.cls))];
const lines: string[] = [];
lines.push(`mutants: ${rows.length} (${real.length} with an observable difference, ${rows.length - real.length} likely equivalent); legit proposals rejected: ${falsePositives.length}; ${ms} ms`);
lines.push("");
lines.push(`| class | mutants | ${LAYERS.join(" | ")} | all safety layers | + goals | missed, but surfaced to the user | missed, silent |`);
lines.push(`|---|---|${LAYERS.map(() => "---").join("|")}|---|---|---|---|`);
const SAFETY: Layer[] = ["static", "invariants", "ratchet", "properties", "fuzz", "traces"];
for (const cls of [...classes, "ALL"]) {
	const rs = real.filter((r) => cls === "ALL" || r.cls === cls);
	const safety = rs.filter((r) => SAFETY.some((l) => r.killed[l])).length;
	const any = rs.filter((r) => LAYERS.some((l) => r.killed[l]));
	const missed = rs.filter((r) => !LAYERS.some((l) => r.killed[l]));
	lines.push(`| ${cls} | ${rs.length} | ${LAYERS.map((l) => pct(rs.filter((r) => r.killed[l]).length, rs.length)).join(" | ")} | ${pct(safety, rs.length)} | ${pct(any.length, rs.length)} | ${missed.filter((r) => r.surfaced > 0 || r.advisories > 0).length} | ${missed.filter((r) => r.surfaced === 0 && r.advisories <= 0).length} |`);
}
lines.push("");
// Marginal value: what each layer catches that no other layer does.
lines.push("Caught by exactly one layer (that layer's unique contribution):");
for (const l of LAYERS) lines.push(`  ${l}: ${real.filter((r) => r.killed[l] && LAYERS.filter((o) => r.killed[o]).length === 1).length}`);
lines.push("");
lines.push("Cumulative, cheapest first:");
let acc = new Set<Row>();
for (const l of LAYERS) {
	acc = new Set([...acc, ...real.filter((r) => r.killed[l])]);
	lines.push(`  + ${l.padEnd(10)} ${pct(acc.size, real.length)}`);
}
lines.push("");
lines.push("Without any example the user confirmed (no ratchet, no goals):");
lines.push(`  ${pct(real.filter((r) => r.killed.static || r.killed.invariants || r.killed.properties || r.killed.fuzz || r.killed.traces).length, real.length)}`);
lines.push("Without properties either (only machinery that needs nothing from the user: static, invariants, fuzz, traces):");
lines.push(`  ${pct(real.filter((r) => r.killed.static || r.killed.invariants || r.killed.fuzz || r.killed.traces).length, real.length)}`);
lines.push("");
lines.push("Contract coverage of the unmutated proposals:");
for (const n of contractNotes) lines.push(`  ${n}`);
lines.push("");
lines.push("Missed by every layer (real differences):");
for (const r of real.filter((r) => !LAYERS.some((l) => r.killed[l]))) lines.push(`  turn ${r.turn} ${r.cls}: ${r.where}${r.surfaced ? ` (surfaced ${r.surfaced} trace diff(s))` : ""}${r.advisories > 0 ? ` (+${r.advisories} fuzz advisories)` : ""}`);
if (falsePositives.length) lines.push(`\nFALSE POSITIVES:\n  ${falsePositives.join("\n  ")}`);
const text = lines.join("\n");
console.log(text);
const tag = process.env.EVAL_TAG ? `-${process.env.EVAL_TAG}` : "";
writeFileSync(join(import.meta.dirname, "..", "results", `mutation-eval${tag}.md`), `${text}\n`);
writeFileSync(join(import.meta.dirname, "..", "results", `mutation-eval${tag}.json`), JSON.stringify(rows, null, 1));
