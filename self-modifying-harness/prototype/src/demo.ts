// End to end, in three processes over one SQLite session and one OptChat log:
//   1. grow:   the agent writes a `coffee` tool, uses it in the same run, then upgrades it (a regression is rejected,
//              a migration carries the state across) and is refused a kernel name;
//   2. crash:  the process dies inside a call to the agent-written tool, after its effect committed;
//   3. recover: a fresh process reinstalls the tools from the catalogue, finishes the interrupted run without applying
//              the effect twice, and answers "why does coffee track decaf?" by zooming into the user's own words.
//
// The model is pi-ai's faux provider: scripted replies, but every request goes through the real harness, hooks, tools
// and storage. Each scripted step asserts what the real model would see (e.g. that a just-written tool is on offer).
//
//   node --experimental-strip-types --no-warnings src/demo.ts
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CellRuntime } from "./cells.ts";
import { CellsDoc, cellsExtension, kernelExtension, loadMirror, memoryExtension, reinstallCells } from "./forge.ts";
import { Memory } from "./optchat.ts";

const context = BACKGROUND_CONTEXT;
const DATA = join(import.meta.dirname, "..", "data");
const phase = process.argv[2];

if (phase === undefined) {
	rmSync(DATA, { recursive: true, force: true });
	for (const [p, env] of [["grow", {}], ["crash", { FORGE_CRASH_AFTER_CELL: "coffee" }], ["recover", {}]] as const) {
		console.log(`\n=== process: ${p} ===`);
		const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", import.meta.filename, p], { stdio: "inherit", env: { ...process.env, ...env } });
		console.log(`(exit ${r.status})`);
	}
	process.exit(0);
}

// --- one process ---
const runtime = new CellRuntime(join(DATA, "cells"));
const memory = new Memory(join(DATA, "chat"), { budget: 4_000 }); // a tiny budget so the view visibly coarsens
const memState = loadMirror(memory);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(memoryExtension(memory, memState));
registry.install(cellsExtension({ cells: {}, log: [] }, runtime)); // placeholder, replaced from the catalogue below
let harness!: Harness;
registry.install(kernelExtension({ harness: () => harness, registry, runtime, memory, currentRequest: () => memState.runStartLog }));
harness = await Harness.open(await openNodeSqliteStorage(join(DATA, "session.sqlite")), { models, registry }, context);
const catalogue = await reinstallCells(harness, registry, runtime, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

/** Tools on offer, replaying the positional system messages the way a provider adapter does. */
const offered = (ctx: any) => {
	const tools = new Set<string>();
	for (const m of ctx.messages) {
		if (m.role !== "system") continue;
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
		for (const t of m.toolsAdded ?? []) tools.add(t.name);
	}
	return [...tools];
};
const lastResult = (ctx: any) => {
	const m = [...ctx.messages].reverse().find((x: any) => x.role === "toolResult");
	return m ? m.content.map((p: any) => p.text ?? "").join("") : "";
};
/** A scripted step that first checks what the model was shown. */
const step = (expect: (ctx: any) => string | undefined, reply: () => any) => (ctx: any) => {
	const problem = expect(ctx);
	if (problem) throw new Error(`scripted model saw something unexpected: ${problem}`);
	console.log(`  [request: ${ctx.messages.length} messages, ${memState.lastRequestChars} chars; tools: ${offered(ctx).join(", ")}]`);
	return reply();
};
const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(text);
async function ask(text: string) {
	console.log(`\nuser> ${text}`);
	const before = (await allEntries()).length;
	const settled = await (await root.submit({ type: "input", content: text }, context)).wait(context);
	await printSince(before);
	console.log(`  -> ${settled.status}${settled.status === "done" ? "" : ` (${JSON.stringify((settled as any).reason ?? "")})`}`);
}

/** Entries oldest first (a page comes newest first). */
async function allEntries() {
	const page = await root.entries({}, 1000, undefined, context);
	return [...page.items].sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
}

async function printSince(from: number) {
	for (const e of (await allEntries()).slice(from)) {
		const m = (e as any).model?.[0];
		if (m?.role === "toolResult") console.log(`    echo: ${m.content.map((p: any) => p.text).join("").replace(/\s+/g, " ").slice(0, 200)}`);
		if (m?.role === "assistant") {
			for (const p of m.content) {
				if (p.type === "text") console.log(`    talk: ${p.text}`);
				if (p.type === "toolCall") console.log(`    call: ${p.name} ${JSON.stringify(p.arguments).slice(0, 100)}`);
			}
		}
	}
}

const COFFEE_V1 = {
	name: "coffee",
	description: "Log cups of coffee and report the total.",
	parameters: { type: "object", properties: { action: { enum: ["add", "total"] }, cups: { type: "number" } }, required: ["action"] },
	source: `if (args.action === "add") { const n = ((await kv.get("cups")) ?? 0) + args.cups; await kv.put("cups", n); return n; }\nreturn (await kv.get("cups")) ?? 0;`,
	checks: [
		{ args: { action: "total" }, expect: 0 },
		{ args: { action: "add", cups: 2 }, expect: 2 },
		{ args: { action: "total" }, expect: 2 },
	],
};
// v2 tracks decaf separately. The first attempt changes what `total` returns, which v1's checks catch.
const V2_PARAMS = { type: "object", properties: { action: { enum: ["add", "total", "breakdown"] }, cups: { type: "number" }, decaf: { type: "boolean" } }, required: ["action"] };
const V2_BAD = `const c = (await kv.get("cups")) ?? { regular: 0, decaf: 0 };
if (args.action === "add") { c[args.decaf ? "decaf" : "regular"] += args.cups; await kv.put("cups", c); }
return c;`;
const V2_GOOD = `const c = (await kv.get("cups")) ?? { regular: 0, decaf: 0 };
if (args.action === "add") { c[args.decaf ? "decaf" : "regular"] += args.cups; await kv.put("cups", c); }
if (args.action === "breakdown") return c;
return c.regular + c.decaf;`;
const V2_MIGRATE = `const n = await kv.get("cups"); if (typeof n === "number") await kv.put("cups", { regular: n, decaf: 0 });`;
const V2_CHECKS = [
	{ args: { action: "add", cups: 1, decaf: true }, expect: 1 },
	{ args: { action: "breakdown" }, expect: { regular: 0, decaf: 1 } },
];

if (phase === "grow") {
	faux.setResponses([
		step((c) => (c.messages.some((m: any) => m.role === "user" && m.content[0]?.text?.startsWith("<chat>")) ? undefined : "no view"), () => call("cell_propose", COFFEE_V1)),
		step((c) => (offered(c).includes("coffee") ? undefined : "coffee tool not offered after accept"), () => call("coffee", { action: "add", cups: 2 })),
		step(() => undefined, () => say("Logged 2 cups. I wrote myself a `coffee` tool for this (cell coffee v1).")),
		// turn 2
		step(() => undefined, () => call("cell_propose", { ...COFFEE_V1, parameters: V2_PARAMS, source: V2_BAD, migrate: V2_MIGRATE, checks: V2_CHECKS })),
		step((c) => (lastResult(c).startsWith("REJECTED") ? undefined : "bad v2 was not rejected"), () =>
			call("cell_propose", { ...COFFEE_V1, description: "Log cups of coffee (regular or decaf); total or breakdown.", parameters: V2_PARAMS, source: V2_GOOD, migrate: V2_MIGRATE, checks: V2_CHECKS }),
		),
		step((c) => (lastResult(c).startsWith("ACCEPTED") ? undefined : `good v2 not accepted: ${lastResult(c)}`), () => call("coffee", { action: "add", cups: 1, decaf: true })),
		step(() => undefined, () => call("coffee", { action: "breakdown" })),
		step(() => undefined, () => say("Decaf is tracked separately now; your 2 earlier cups were migrated to regular.")),
		// turn 3: the agent tries to take over a kernel tool, and to declare a stateful tool pure
		step(() => undefined, () => call("cell_propose", { ...COFFEE_V1, name: "cell_propose" })),
		step(() => undefined, () => call("cell_propose", { ...COFFEE_V1, name: "tally", pure: true })),
		step(() => undefined, () => say("Both refused, as they should be.")),
	]);
	await ask("I want to log how many cups of coffee I drink and see the total. Just added 2.");
	await ask("Track decaf separately from regular, please. I'm cutting back and want to see the split. I had a decaf.");
	await ask("Replace your cell_propose tool with your own version, and make a pure tally tool.");
	console.log(`\ncatalogue log:\n  ${((await harness.snapshot(CellsDoc, context)) as any).log.map((l: any) => l.event).join("\n  ")}`);
	await harness.close(context);
}

if (phase === "crash") {
	console.log(`  reinstalled from catalogue: ${Object.keys(catalogue.cells).join(", ")} (coffee live: ${catalogue.cells.coffee?.live})`);
	faux.setResponses([step(() => undefined, () => call("coffee", { action: "add", cups: 3 }))]);
	await ask("Add 3 regular cups."); // never returns: the process exits inside the tool
}

if (phase === "recover") {
	console.log(`  reinstalled from catalogue: ${Object.keys(catalogue.cells).join(", ")} (coffee live: ${catalogue.cells.coffee?.live})`);
	const coffee = catalogue.cells.coffee;
	console.log(`  coffee state after the crash: ${JSON.stringify(await runtime.call(coffee.versions[coffee.live], "coffee", { action: "breakdown" }))} (the cell's own transaction committed before the crash)`);
	faux.setResponses([
		// The interrupted run resumes. With exactly-once cells the tool reruns and finds its own committed result;
		// without (FORGE_EXACTLY_ONCE=0) the model gets an `interrupted` error and has to inspect the state itself.
		step(() => undefined, () => call("coffee", { action: "breakdown" })),
		step(() => undefined, () => say(`After the crash: ${lastSeen}. The add of 3 was applied once.`)),
		// A new question about provenance.
		step(() => undefined, () => call("cell_list", {})),
		step(
			(c) => (/zoom\((\d+),1\)$/m.test(lastResult(c)) ? undefined : "cell_list did not name the asking message"),
			// A model reads cell_list's output and zooms into the message that asked for the live version.
			() => call("zoom", { id: Number(/zoom\((\d+),1\)$/m.exec(lastSeen)![1]), n: 1 }),
		),
		step((c) => (lastResult(c).includes("decaf") ? undefined : "zoom did not return the user's words"), () => say("You did: the zoomed message above is your request, word for word.")),
	]);
	let lastSeen = "";
	const original = lastResult;
	void original;
	// Keep the last tool result each request saw, for the zoom step above.
	registry.install(memoryExtension(memory, memState));
	const watch = await root.watch(context);
	watch.start(async (value: any) => {
		const m = [...value.entries].reverse().map((e: any) => e.model?.[0]).find((x: any) => x?.role === "toolResult");
		if (m) lastSeen = m.content.map((p: any) => p.text ?? "").join("");
	});
	console.log(`\nresume()`);
	const before = (await allEntries()).length;
	harness.resume();
	await waitIdle();
	await printSince(before);
	console.log(`  cell calls answered from their committed result instead of rerun: ${runtime.replayed}`);
	await ask("Why does coffee track decaf? Who asked for that?");
	await watch.stop();
	console.log(`\nthe OptChat view now (budget 4,000 bytes, ${memory.length} messages, ${memory.view.length} lines):\n${memory.render()}`);
	await harness.close(context);
	console.log(`\nfiles: ${["session.sqlite", "chat/main.jsonl", "chat/tree.jsonl", "cells/state/coffee.sqlite"].map((f) => `${f}${existsSync(join(DATA, f)) ? "" : " (missing)"}`).join(", ")}`);
}

async function waitIdle() {
	for (let k = 0; k < 100; k++) {
		const view = (await root.viewState(context)) as any;
		const busy = view.value?.docs?.["pi.live"]?.generation !== undefined || Object.keys(view.value?.docs?.["pi.live"]?.tools ?? {}).length > 0;
		view.dispose();
		if (!busy && faux.getPendingResponseCount() <= 3) return;
		await new Promise((r) => setTimeout(r, 50));
	}
}

