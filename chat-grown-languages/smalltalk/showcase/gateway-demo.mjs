// Showcase: the live image as an operations console for an LLM gateway (SCENARIO=gateway).
// Run: node showcase/gateway-demo.mjs   (from smalltalk/; transcript: showcase/gateway-transcript.txt via gateway-demo.sh)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HERE = import.meta.dirname;
const dir = process.env.DEMO_DIR ?? mkdtempSync(join(tmpdir(), "st-gw-"));
const turns = JSON.parse(readFileSync(join(HERE, "..", "reference-gateway.json"), "utf8")).turns;
const scenario = JSON.parse(readFileSync(join(HERE, "..", "..", "scenario", "gateway.json"), "utf8"));

class Kernel {
	constructor() {
		this.proc = spawn(join(HERE, "..", "run.sh"), [dir], { env: { ...process.env, SCENARIO: "gateway" } });
		this.q = []; this.w = [];
		createInterface({ input: this.proc.stdout }).on("line", (l) => { const w = this.w.shift(); w ? w(l) : this.q.push(l); });
	}
	ask(req) {
		return new Promise((res) => {
			this.proc.stdin.write(`${JSON.stringify(req)}\n`);
			const l = this.q.shift();
			l !== undefined ? res(JSON.parse(l)) : this.w.push((x) => res(JSON.parse(x)));
		});
	}
	async close() { this.proc.stdin.end(); await new Promise((r) => this.proc.on("exit", r)); }
}

const say = (s = "") => console.log(s);
const h = (s) => say(`\n=== ${s} ===`);
const ev = (s) => say(`  * ${s}`);
const call = (fn, ...args) => ({ fn, args });
let rid = 0;
let k = new Kernel();
const exec = (c) => k.ask({ op: "execute", call: c, request_id: `t-${++rid}` });
const gen = async () => (await k.ask({ op: "observe" })).generation;
const develop = async (intent, scope, forms, examples, message, text) =>
	k.ask({ op: "develop", generation: await gen(), intent, scope, forms, removes: [], examples, asked: { message, text } });

// deterministic traffic: a loop of executes through the live gateway
let tick = 0;
async function traffic(n, label) {
	const keys = ["alice", "bob", "carol", "scraper"];
	let ok = 0; const refused = {};
	for (let i = 0; i < n; i++, tick++) {
		const key = keys[tick % 4];
		let c;
		if (tick % 13 === 12) c = call("record_usage", key, "gpt", 0);                       // bad input
		else if (key === "scraper") c = call("record_usage", key, "gpt", 9);                // many tiny calls
		else c = call("record_usage", key, tick % 3 === 0 ? "claude" : "gpt", 100 + (tick % 5) * 40);
		const r = await exec(c);
		if (r.ok) ok++; else refused[r.error] = (refused[r.error] ?? 0) + 1;
	}
	const bad = Object.entries(refused).map(([e, c]) => `${c}x "${e}"`).join(", ");
	ev(`traffic ${label}: ${n} calls -> ${ok} recorded${bad ? `, refused: ${bad}` : ""}`);
}
const insp = (what, arg) => k.ask({ op: "inspect", what, arg });
const costOf = async (key) => (await exec(call("cost", key))).value;
const preview = async (fn, args = []) => (await k.ask({ op: "try", forms: [], removes: [], questions: [{ fixture: (await k.ask({ op: "observe" })).state, calls: [call(fn, ...args)] }] })).outcomes[0].value;

h("1. BOOT: an empty image grows the gateway, one chat turn at a time");
const asked = [10, 20, 30, 40, 50];
for (const [i, t] of turns.entries()) {
	const examples = i === 1 ? [
		{ fixture: { calls: [{ key: "alice", model: "gpt", tokens: 1200 }, { key: "alice", model: "claude", tokens: 300 }], prices: { gpt: 50, claude: 300 } }, calls: [call("cost", "alice")], expect: { value: 1.5, state: { calls: [{ key: "alice", model: "gpt", tokens: 1200 }, { key: "alice", model: "claude", tokens: 300 }], prices: { gpt: 50, claude: 300 } } } },
		{ fixture: { calls: [{ key: "bob", model: "claude", tokens: 500 }], prices: { claude: 300 } }, calls: [call("cost", "bob")], expect: { value: 1.5, state: { calls: [{ key: "bob", model: "claude", tokens: 500 }], prices: { claude: 300 } } } },
	] : [];
	const r = await develop(t.intent, t.scope, t.forms, examples, asked[i], scenario.turns[i].user);
	ev(`turn ${i + 1} "${t.intent}": ${r.status} as ${r.revision}  (methods: ${t.scope.join(", ")})`);
}
await exec(call("set_price", "gpt", 50)); await exec(call("set_price", "claude", 300));
await exec(call("set_quota", "carol", 4000));
ev("prices gpt=50c/1k, claude=300c/1k; carol has a quota of 4000 tokens");

h("2. TRAFFIC FLOWS");
await traffic(40, "burst 1");

h("3. A MODEL CHANGE SHIPS WHILE TRAFFIC KEEPS FLOWING");
const buggyCost = "cost: key\n\t| prices cents |\n\tprices := state at: 'prices' ifAbsent: [ Dictionary new ].\n\tcents := (state at: 'calls' ifAbsent: [ #() ]) inject: 0 into: [ :sum :c |\n\t\t(c at: 'key') = key\n\t\t\tifTrue: [ sum + ((c at: 'tokens') / 1000.0 * (prices at: (c at: 'model') ifAbsent: [ 0 ])) rounded ]\n\t\t\tifFalse: [ sum ] ].\n\t^ cents / 100.0";
const ex = turns[1].forms; // keep examples of turn 2 in the ratchet: they pass for the buggy version too
let r = await develop("invoice per call", ["cost"], [buggyCost], [], 60, "Invoices must add up: bill every call in whole cents.");
ev(`user: "Invoices must add up: bill every call in whole cents."  -> ${r.status} as ${r.revision}`);
ev("ratchet, invariants and trace replay all pass: the confirmed examples have whole-cent calls, so they cannot see the bug");
const setPrice2 = "set_price: model cents: cents\n\t(cents isNumber and: [ cents >= 0 ]) ifFalse: [ ^ self error: 'price must be >= 0' ].\n\t(state at: 'prices' ifAbsentPut: [ Dictionary new ]) at: model put: cents.\n\t^ cents";
r = await develop("price validation", ["set_price"], [setPrice2], [], 70, "Refuse negative prices.");
ev(`user: "Refuse negative prices."  -> ${r.status} as ${r.revision}`);
await traffic(60, "burst 2");

h("4. THE OPERATOR OPENS THE LIVE IMAGE (read-only console: inspect, changes, try)");
let o = await insp("object");
ev(`the app is an object: ${o.object}, a ${o.class} (superclass ${o.superclass}), instance variables ${JSON.stringify(o.instVars)}`);
ev(`its state keys ${JSON.stringify(o["state keys"])}; ${o["calls recorded"]} calls recorded; methods: ${o.methods.join("  ")}`);
say("  who sent what (live, from the object):");
const who = (await insp("who")).keys;
for (const [key, row] of Object.entries(who).sort()) say(`    ${key.padEnd(8)} ${String(row.calls).padStart(3)} calls  ${String(row.tokens).padStart(5)} tokens  models ${row.models.join("/")}`);
ev(`senders of #cost: -> ${JSON.stringify((await insp("senders", "cost:")).senders)}`);
const ch = await k.ask({ op: "changes", limit: 6 });
say(`  the image's own change log (Epicea), last ${ch.entries.length} of ${ch.total} method changes to ExpenseApp:`);
for (const e of ch.entries) say(`    ${e.kind.padEnd(18)} ExpenseApp>>${e.selector}`);

h("5. SOMETHING LOOKS WRONG");
const scraperTokens = who.scraper.tokens;
const scraperCost = await costOf("scraper");
ev(`scraper sent ${who.scraper.calls} calls = ${scraperTokens} tokens of gpt at 50c/1k, so it should owe about $${(scraperTokens * 50 / 100000).toFixed(2)}`);
ev(`cost("scraper") says $${scraperCost}  <-- free traffic`);
ev(`top_spender() right now (preview, nothing recorded): ${JSON.stringify(await preview("top_spender"))}`);

h("6. HOT-FIX IN ONE METHOD, NO RESTART");
const hot = buggyCost.replace(" rounded ]", " ]").replace("^ cents / 100.0", "^ cents / 100.0");
r = await develop("hotfix cost", ["cost"], [hot], [], 80, "operator: stop under-billing tiny calls (hotfix)");
ev(`recompile ExpenseApp>>cost: -> ${r.status} as ${r.revision}; nobody was disconnected`);
ev(`cost("scraper") now $${await costOf("scraper")}`);
ev(`top_spender() (a caller of cost:, untouched) now answers ${JSON.stringify(await preview("top_spender"))}: it saw the new method on its next send`);
await traffic(20, "burst 3, on the patched method");

h("7. WHICH REVISION INTRODUCED THE BUG, AND WHO ASKED FOR IT?");
const hist = (await insp("history")).history;
say("  revision history of this world (kept with the image):");
for (const l of hist) say(`    ${l}`);
const rb = hist.find((l) => l.includes("invoice per call"));
ev(`suspect: ${rb?.split("  ")[0]} "invoice per call", chat message #60 "Invoices must add up: bill every call in whole cents."`);
ev("that revision rounded each call separately: 9 tokens at 50c/1k is 0.45c, which rounds to 0");
const ch2 = await k.ask({ op: "changes", limit: 4 });
say("  Epicea agrees, newest last:");
for (const e of ch2.entries) say(`    ${e.kind.padEnd(18)} ExpenseApp>>${e.selector}`);

h("8. ROLL BACK ONE METHOD (set_price's validation from rev-0007 stays)");
r = await k.ask({ op: "rollback", fn: "cost", revision: "rev-0005" });
ev(`rollback of cost to rev-0005 -> ${JSON.stringify(r)}`);
const m = await insp("method", "cost");
ev(`ExpenseApp>>${m.selector} is the original again (stamp ${m.stamp}); its source:`);
for (const l of m.source.split("\n")) say(`      ${l}`);
ev(`cost("scraper") = $${await costOf("scraper")} (rounded once, on the total)`);
ev(`set_price("x", -1) -> ${JSON.stringify(await exec(call("set_price", "x", -1)))} (rev-0007 survived)`);
await traffic(20, "burst 4");

h("9. SAVE THE IMAGE, RESTART, THE WHOLE WORLD COMES BACK");
const before = await k.ask({ op: "observe" });
const beforeObj = await insp("object");
const t0 = performance.now();
await k.close();
ev(`stdin closed: the kernel saved world.image (${(statSync(join(dir, "world.image")).size / 1e6).toFixed(0)} MB) and world.json (${(statSync(join(dir, "world.json")).size / 1e3).toFixed(0)} KB) in ${Math.round(performance.now() - t0)} ms`);
k = new Kernel();
const t1 = performance.now();
const after = await k.ask({ op: "observe" });
ev(`new VM, first answer after ${Math.round(performance.now() - t1)} ms: generation ${after.generation} (was ${before.generation}), revision ${after.revision}`);
const afterObj = await insp("object");
ev(`data: ${afterObj["calls recorded"]} calls recorded (was ${beforeObj["calls recorded"]}), state identical: ${JSON.stringify(after.state) === JSON.stringify(before.state)}`);
ev(`code: ${afterObj.methods.length} methods, sources identical: ${JSON.stringify(after.functions) === JSON.stringify(before.functions)}`);
const hist2 = (await insp("history")).history;
ev(`history: ${hist2.length} revisions, identical: ${JSON.stringify(hist2) === JSON.stringify(hist)} ...except the rollback entry that came after: ${hist2[hist2.length - 1].split("  ").slice(0, 3).join("  ")}`);
const w = await k.ask({ op: "why", fn: "cost" });
ev(`why cost -> ${w.revision} "${w.intent}", asked by message #${w.asked.message}: "${w.asked.text}"`);
const again = await k.ask({ op: "execute", call: call("record_usage", "alice", "gpt", 100), request_id: "t-1" });
ev(`exactly-once survives: replaying request t-1 -> replayed=${again.replayed}`);
await traffic(10, "burst 5, on the restarted image");
await k.close();

h("SUMMARY");
say("  - 5 chat turns grew the gateway as methods of one live class; 2 later changes shipped under traffic");
say("  - a bad revision (per-call rounding) passed every gate: the examples could not see it");
say("  - the operator found it from the live object, hot-fixed one method with no restart; callers saw it at once");
say("  - revision history + Epicea named the revision and the chat message; one method was rolled back, the rest kept");
say("  - the saved image plus world.json restored code, data and history in a new VM");
