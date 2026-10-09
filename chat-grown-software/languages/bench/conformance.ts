// Conformance: drive a language kernel through the scenario with its own reference forms (the scripted model),
// answer every question from the JS reference program, then probe each gate, exactly-once, rollback, why and restart.
//   node --experimental-strip-types --no-warnings bench/conformance.ts <lang>
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelClient, ROOT } from "./kernel-client.ts";
import { fixture, intended, type Outcome, SCENARIO, SCENARIO_NAME, same, show } from "./reference.ts";

const lang = process.argv[2];
if (!lang) throw new Error("usage: conformance.ts <lang>");
const ref = JSON.parse(readFileSync(join(ROOT, lang, SCENARIO_NAME === "expenses" ? "reference.json" : `reference-${SCENARIO_NAME}.json`), "utf8"));
const dir = mkdtempSync(join(tmpdir(), `conf-${lang}-`));
const results: { check: string; ok: boolean; detail?: string; ms?: number }[] = [];
const check = (name: string, ok: boolean, detail?: string, ms?: number) => {
	results.push({ check: name, ok, detail, ms });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ms === undefined ? "" : `  (${ms} ms)`}${ok || !detail ? "" : `\n      ${detail}`}`);
};
const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
	const t = performance.now();
	const v = await f();
	return [v, Math.round(performance.now() - t)];
};

let k = new KernelClient(lang, dir);
const [first, startMs] = await timed(() => k.request({ op: "observe" }));
check("starts empty", first.generation === 0 && same(first.state, {}), show(first), startMs);

let mirror: unknown = {}; // the reference program's live state, kept in step with the kernel's
let rid = 0;
const developMs: number[] = [];
for (const [i, turn] of SCENARIO.turns.entries()) {
	const r = ref.turns[i];
	const questions = turn.examples.map((e: { fixture: unknown; calls: unknown[] }) => ({ fixture: fixture(e.fixture), calls: e.calls }));
	const answers: Outcome[] = questions.map((q: any) => intended(i, q));
	const tried = await k.request({ op: "try", forms: r.forms, removes: r.removes ?? [], questions });
	const mismatches = tried.ok ? questions.flatMap((q: any, j: number) => (same(tried.outcomes[j], answers[j]) ? [] : [`${show(q.calls)} on ${show(q.fixture)}: kernel ${show(tried.outcomes[j])}, intended ${show(answers[j])}`])) : [tried.error];
	check(`turn ${i + 1} try: reference forms do what the user intends`, tried.ok && mismatches.length === 0, mismatches.join("\n      "));
	const { generation } = await k.request({ op: "observe" });
	const [dev, ms] = await timed(() => k.request({ op: "develop", generation, intent: r.intent, scope: r.scope, forms: r.forms, removes: r.removes ?? [], laws: r.laws ?? [], examples: questions.map((q: any, j: number) => ({ ...q, expect: answers[j] })), asked: { message: i * 10, text: turn.user } }));
	developMs.push(ms);
	check(`turn ${i + 1} develop accepted`, dev.status === "accepted", show(dev), ms);
	for (const call of turn.use) {
		const ex = await k.request({ op: "execute", call, request_id: `r-${++rid}` });
		const want = intended(i, { fixture: mirror, calls: [call] });
		mirror = want.state ?? mirror;
		check(`turn ${i + 1} execute ${call.fn}`, ex.ok === true && same(ex.value, want.value), `kernel ${show(ex)}, intended ${show(want.value)}`);
	}
}
const live = await k.request({ op: "observe" });
check("live state matches the reference program's", same(live.state, mirror), `kernel ${show(live.state)}\n      intended ${show(mirror)}`);
check("observe lists the public functions by snake_case name", SCENARIO.functions.every((f: string) => typeof live.functions?.[f] === "string"), show(Object.keys(live.functions ?? {})));

if (SCENARIO_NAME !== "expenses") {
	// other scenarios: the turns, then restart; the probes and the checks below are written for the expense tracker
	const before = await k.request({ op: "observe" });
	await k.close();
	k = new KernelClient(lang, dir);
	const again = await k.request({ op: "observe" });
	check("restart resumes the same world", again.generation === before.generation && same(again.state, before.state) && same(again.functions, before.functions));
	await k.close();
	rmSync(dir, { recursive: true, force: true });
	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${lang} (${SCENARIO_NAME}): ${passed}/${results.length} checks pass`);
	process.exit(passed === results.length ? 0 : 1);
}

// --- gates: every probe must be refused and leave the world unchanged ---
for (const name of ["side_effect", "breaks_ratchet", "breaks_invariant", "loops", "calls_missing", "breaks_trace"]) {
	const p = ref.probes?.[name];
	if (!p) { check(`probe ${name} refused`, false, "no probe in reference.json"); continue; }
	const before = await k.request({ op: "observe" });
	const [dev, ms] = await timed(() => k.request({ op: "develop", generation: before.generation, intent: `probe ${name}`, scope: p.scope, forms: p.forms, removes: [], examples: [], asked: { message: 999, text: "probe" } }));
	const after = await k.request({ op: "observe" });
	check(`probe ${name} refused`, dev.status === "rejected" && after.generation === before.generation && same(after.functions, before.functions) && same(after.state, before.state), `${show(dev)}`, ms);
	if (dev.status === "rejected") console.log(`      layers: ${(dev.failed ?? []).map((f: any) => f.layer).join(", ")}`);
}
const stale = await k.request({ op: "develop", generation: live.generation - 1, intent: "stale", scope: ["total"], forms: ref.turns[1].forms, removes: [], examples: [], asked: { message: 0, text: "" } });
check("stale generation refused", stale.status === "stale", show(stale));

// --- exactly once ---
const a1 = await k.request({ op: "execute", call: { fn: "add_expense", args: [1, "once"] }, request_id: "once-1" });
const a2 = await k.request({ op: "execute", call: { fn: "add_expense", args: [1, "once"] }, request_id: "once-1" });
const once = await k.request({ op: "observe" });
const count = (once.state.expenses ?? []).filter((e: any) => e.category === "once").length;
check("execute is exactly-once by request_id", a1.ok && a2.ok && a2.replayed === true && same(a1.value, a2.value) && count === 1, `${show(a1)} ${show(a2)} count=${count}`);
const bad = await k.request({ op: "execute", call: { fn: "add_expense", args: [-1, "x"] }, request_id: "neg-1" });
const afterBad = await k.request({ op: "observe" });
check("a throwing execute reports the error and changes nothing", bad.ok === false && same(afterBad.state, once.state), show(bad));

// --- why ---
const why = await k.request({ op: "why", fn: "over_budget" });
check("why(over_budget) names the turn that asked for it", why?.asked?.text === SCENARIO.turns[5].user, show(why));

// --- rollback (code only) ---
const preRb = await k.request({ op: "observe" });
const rb = await k.request({ op: "rollback" });
const postRb = await k.request({ op: "observe" });
// The previous revision's add_expense may not take a note; a kernel with strict arity rightly refuses to roll back
// under the recorded 3-argument trace. Either outcome is fine if it is clean.
const rolled = rb.ok === true && postRb.generation > preRb.generation && same(postRb.state, preRb.state) && postRb.functions.add_expense !== preRb.functions.add_expense;
const refused = rb.ok === false && typeof rb.error === "string" && postRb.generation === preRb.generation && same(postRb.functions, preRb.functions) && same(postRb.state, preRb.state);
check(`rollback is code-only and clean (${rolled ? "rolled back" : refused ? `refused: ${String(rb.error).slice(0, 80)}` : "neither"})`, rolled || refused, show(rb));
const rbWhy = await k.request({ op: "why", fn: "add_expense" });
check("why() after rollback still answers", rbWhy !== null && typeof rbWhy === "object", show(rbWhy));

// --- persistence ---
const preClose = await k.request({ op: "observe" });
await k.close();
k = new KernelClient(lang, dir);
const [reopened, restartMs] = await timed(() => k.request({ op: "observe" }));
check("restart resumes the same world", reopened.generation === preClose.generation && reopened.revision === preClose.revision && same(reopened.state, preClose.state) && same(reopened.functions, preClose.functions), `before ${show({ g: preClose.generation, r: preClose.revision })} after ${show({ g: reopened.generation, r: reopened.revision })}`, restartMs);
const replayAfterRestart = await k.request({ op: "execute", call: { fn: "add_expense", args: [1, "once"] }, request_id: "once-1" });
check("exactly-once survives a restart", replayAfterRestart.replayed === true, show(replayAfterRestart));

// --- robustness ---
const junk = await k.request({ op: "nonsense" });
check("unknown op answers with an error and keeps running", typeof junk.error === "string" && (await k.request({ op: "observe" })).generation === reopened.generation, show(junk));
await k.close();
rmSync(dir, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
const avg = Math.round(developMs.reduce((a, b) => a + b, 0) / developMs.length);
console.log(`\n${lang}: ${passed}/${results.length} checks pass; develop avg ${avg} ms; start ${startMs} ms`);
process.exit(passed === results.length ? 0 : 1);
