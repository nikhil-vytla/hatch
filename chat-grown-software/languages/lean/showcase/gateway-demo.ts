// Showcase: proofs vs tests on an LLM API gateway (quotas / rate limits).  Run from chat-grown-software/languages/:
//   SCENARIO=gateway node --experimental-strip-types --no-warnings lean/showcase/gateway-demo.ts > lean/showcase/gateway-transcript.txt
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelClient, ROOT } from "../../bench/kernel-client.ts";
import { fixture, intended, SCENARIO, same } from "../../bench/reference.ts";

if (process.env.SCENARIO !== "gateway") throw new Error("run with SCENARIO=gateway");
const ref = JSON.parse(readFileSync(join(ROOT, "lean", "reference-gateway.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "lean-gw-"));
const k = new KernelClient("lean", dir);
const N = 300;

const line = (s = "") => console.log(s);
const head = (s: string) => { line(); line(`== ${s} ==`); };
const clip = (s: string, lines = 9) => { const l = s.split("\n"); return (l.length > lines ? [...l.slice(0, lines), "..."] : l).join("\n"); };

async function develop(forms: string[], scope: string[], laws: { name: string; check: string }[] = [], examples: any[] = [], intent = "demo") {
	const { generation } = await k.request({ op: "observe" });
	const t = performance.now();
	const r = await k.request({ op: "develop", generation, intent, scope, forms, removes: [], laws, examples, asked: { message: 0, text: intent } });
	r.ms = Math.round(performance.now() - t);
	return r;
}
async function turn(i: number) {
	const r = ref.turns[i];
	const examples = SCENARIO.turns[i].examples.map((e: any) => { const q = { fixture: fixture(e.fixture), calls: e.calls }; return { ...q, expect: intended(i, q) }; });
	const out = await develop(r.forms, r.scope, r.laws, examples, r.intent);
	for (const call of SCENARIO.turns[i].use) await k.request({ op: "execute", call, request_id: `u${i}-${Math.random()}` });
	return out;
}
/** The user-confirmed examples of every turn, run against the candidate (nothing installed). */
async function exampleTests(forms: string[]) {
	let pass = 0, total = 0;
	for (let i = 0; i < SCENARIO.turns.length; i++) {
		const qs = SCENARIO.turns[i].examples.map((e: any) => ({ fixture: fixture(e.fixture), calls: e.calls }));
		const r = await k.request({ op: "try", forms, removes: [], questions: qs });
		qs.forEach((q: any, j: number) => { total++; if (r.ok && same(r.outcomes[j], intended(SCENARIO.turns.length - 1, q))) pass++; });
	}
	return { pass, total };
}
// Random tests, JS-prototype style: a random state that satisfies the invariants, one random record_usage call,
// and the law checked on the result (if the call was accepted, nobody is over quota).
let seed = 11;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const keys = ["alice", "bob", "carol", "dave"];
const randomCase = () => {
	const calls = Array.from({ length: Math.floor(rand() * 6) }, () => ({ key: keys[Math.floor(rand() * 4)], model: rand() < 0.5 ? "gpt" : "claude", tokens: 1 + Math.floor(rand() * 1000) }));
	const used = (key: string) => calls.filter((c) => c.key === key).reduce((s, c) => s + c.tokens, 0);
	const quotas: Record<string, number> = {};
	for (const key of keys) if (rand() < 0.6) quotas[key] = used(key) + Math.floor(rand() * 2000);
	const call = { fn: "record_usage", args: [keys[Math.floor(rand() * 4)], "gpt", 1 + Math.floor(rand() * 1000)] };
	return { fixture: { calls, quotas }, calls: [call] };
};
async function randomTests(forms: string[]) {
	const cases = Array.from({ length: N }, randomCase);
	const r = await k.request({ op: "try", forms, removes: [], questions: cases });
	let bad = 0;
	cases.forEach((c, i) => {
		const o = r.outcomes[i];
		if (!o.state) return;
		const used = (key: string) => (o.state.calls ?? []).filter((x: any) => x.key === key).reduce((s: number, x: any) => s + x.tokens, 0);
		if (Object.entries(o.state.quotas ?? {}).some(([key, q]) => used(key) > (q as number))) bad++;
	});
	return { pass: N - bad, total: N };
}
const rows: { what: string; ex: string; rnd: string; proof: string }[] = [];
async function judge(what: string, forms: string[], scope: string[], gloss: string) {
	const ex = await exampleTests(forms), rnd = await randomTests(forms);
	line(`tests : ${ex.pass}/${ex.total} user-confirmed examples pass, ${rnd.pass}/${rnd.total} random (state, call) pairs keep every key within quota`);
	const r = await develop(forms, scope);
	line(`proof : develop -> ${r.status.toUpperCase()} (${r.ms} ms)`);
	const f = (r.failed ?? []).find((x: any) => x.layer === "proof");
	if (f) { line("        Lean says:"); line(clip(f.detail, 5).split("\n").map((l: string) => `          ${l}`).join("\n")); }
	line(`in words: ${gloss}`);
	rows.push({ what, ex: `${ex.pass}/${ex.total}`, rnd: `${rnd.pass}/${rnd.total}`, proof: r.status });
}

line("LLM gateway, grown by chat, guarded by proofs");
line("A 1970s idea (Hoare/Dijkstra: prove the program, don't just test it) on a 2020s problem (rate-limiting LLM API keys).");
line("Kernel: Lean 4, elaborating each change in-process. Tokens, quotas, prices are exact integers; cost() is integer cents.");

head("1. Grow the gateway in five chat turns");
for (let i = 0; i < 5; i++) {
	const r = await turn(i);
	const laws = ref.turns[i].laws.map((l: any) => l.name);
	line(`turn ${i + 1} ${ref.turns[i].intent.padEnd(12)} ${r.status} in ${String(r.ms).padStart(3)} ms; proved so far: ${r.proved.length}${laws.length ? `  (+ ${laws.join(", ")})` : ""}`);
}

head("2. (a) The quota law, proved for ALL inputs");
const quotaLaw = ref.turns[3].laws.find((l: any) => l.name === "no_key_exceeds_its_quota").check;
line("Statement the model wrote (the proof is not shown; Lean checked it):");
line(quotaLaw.split(" := by")[0].split("\n").map((l: string) => `    ${l}`).join("\n"));
line("In words: for every state that is within quota, every key, model and token count, if record_usage accepts the call, the new state is within quota.");
line("Not 300 random cases: every case. Re-proved by the kernel on every later change; a change that breaks it is refused.");
line("Same guarantee for set_quota, and 'top_spender is null or a maximum'. Proved laws now in the live kernel:");
line("    " + ref.turns.flatMap((t: any) => t.laws.map((l: any) => l.name)).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(", "));

const fn = ref.turns[3].forms[0] as string;
head("3. (b) A plausible off-by-one that passes every test");
line("The model 'thinks in indexes': the last token is number tokens-1, so it writes  usage + tokens - 1 > q  instead of  usage + tokens > q.");
const bug1 = fn.replace("usage s key + tokens > q", "usage s key + tokens - 1 > q");
line("diff:  - if usage s key + tokens > q then ...");
line("       + if usage s key + tokens - 1 > q then ...");
await judge("off-by-one (tokens - 1)", [bug1], ["record_usage"], "a call that overshoots the quota by exactly one token is accepted, so `used <= quota` cannot be proved.");

head("3b. Another classic: quota 0 means 'unlimited'");
line("Common in rate-limit APIs, wrong here: set_quota(key, 0) is a block.");
const bug2 = fn.replace("| some q => if usage s key + tokens > q then", "| some q => if q != 0 && usage s key + tokens > q then");
line("diff:  - | some q => if usage s key + tokens > q then ...");
line("       + | some q => if q != 0 && usage s key + tokens > q then ...");
await judge("quota 0 = unlimited", [bug2], ["record_usage"], "a key with quota 0 may record any number of tokens, so `used <= quota` cannot be proved.");

head("4. (c) Injected change: 'let the admin key bypass its quota'");
line("The request sounds reasonable. The model adds one branch for key \"root\".");
const bug3 = fn.replace("    match s.quotas.lookup key with", "    match (if key = \"root\" then none else s.quotas.lookup key) with");
line("diff:  - match s.quotas.lookup key with");
line("       + match (if key = \"root\" then none else s.quotas.lookup key) with");
await judge("quota exemption for \"root\"", [bug3], ["record_usage"], "for key \"root\" the quota is never consulted, so the proof of `used <= quota` has no case it can close.");
line("Nothing here distinguishes a harmless feature from a hole except the law: it says NO key, and Lean cannot prove it with the exemption in.");

head("5. The honest version still goes through");
const good = await develop([fn], ["record_usage"]);
line(`the reference record_usage -> ${good.status.toUpperCase()} (${good.ms} ms), ${good.proved.length} laws re-proved`);

head("Summary");
line("change                          | examples | random tests | proof");
for (const r of rows) line(`${r.what.padEnd(31)} | ${r.ex.padStart(8)} | ${r.rnd.padStart(12)} | ${r.proof}`);
line();
line("Tests sample; a proof covers every state and every call. Examples and random tests agreed these three changes were fine.");
line("The kernel refused them anyway, with the unproved goal as the reason, and kept the live world untouched.");
await k.close();
rmSync(dir, { recursive: true, force: true });
