// End to end, in three processes over one SQLite session and one OptChat log:
//   1. grow:   the agent writes a `coffee` tool, uses it in the same run, then upgrades it. Along the way the gate refuses
//              a stale proposal, checks that skip an action, a regression of an earlier check, a drive-by behaviour change
//              (caught by replaying real calls), a kernel name, a false purity claim, and a hang (caught by schema fuzz);
//              a migration carries the state across; a caller-owned invariant guards the state throughout;
//   2. crash:  the process dies inside a call to the agent-written tool, after its effect committed;
//   3. recover: a fresh process reinstalls the tools from the catalogue, finishes the interrupted run without applying
//              the effect twice, and answers "why does coffee track decaf?" by zooming into the user's own words.
//
// The model is pi-ai's faux provider: scripted replies, but every request goes through the real harness, hooks, tools
// and storage. Each scripted step asserts what the real model would see (e.g. that a just-written tool is on offer).
//
// The crash between a migration and the catalogue commit (FORGE_CRASH_AFTER_MIGRATION=<cell>) is exercised by
// test/crash-migration.test.ts, which spawns a child process that dies there.
//
//   node --experimental-strip-types --no-warnings src/demo.ts
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { AssistantMessage, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type CallerInvariants, reinstallCells, reserveCellsSlot } from "./catalogue.ts";
import { entryOf } from "./catalogue-doc.ts";
import { CellRuntime } from "./cells.ts";
import { kernelExtension, loadMirror, memoryExtension } from "./forge.ts";
import { Memory } from "./optchat.ts";
import { withCommittedCatalogue } from "./proofs/catalogue-committed.ts";

const context = BACKGROUND_CONTEXT;

const DATA = join(import.meta.dirname, "..", "data");

const phase = process.argv[2];

// The caller's invariants, which the model cannot propose, change or drop: whatever shape the coffee state takes (a number
// in v1, {regular, decaf} later), every count in it is a non-negative integer.
const OWNED: CallerInvariants = {
	coffee: [
		{
			name: "counts are non-negative integers",
			source: `const c = await kv.get("cups");
if (c === null) return true;
const ok = (n) => Number.isInteger(n) && n >= 0;
return typeof c === "number" ? ok(c) : ok(c.regular) && ok(c.decaf);`,
		},
	],
};

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

reserveCellsSlot(registry); // keeps "cells" before "kernel" in the install order; the real tools come from the catalogue below

let harness!: Harness;

registry.install(kernelExtension({ harness: () => harness, registry, runtime, memory, currentRequest: () => memState.runStartLog, invariants: OWNED }));

harness = await Harness.open(await openNodeSqliteStorage(join(DATA, "session.sqlite")), { models, registry }, context);

const catalogue = await reinstallCells(harness, registry, runtime, context, OWNED);

const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

/** Tools on offer, replaying the positional system messages the way a provider adapter does. */
const offered = (ctx: TranscriptContext): string[] => {
	const tools = new Set<string>();

	for (const m of ctx.messages) {
		if (m.role !== "system") continue;

		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);

		for (const t of m.toolsAdded ?? []) tools.add(t.name);
	}

	return [...tools];
};

const resultText = (m: ToolResultMessage): string => m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

const lastResult = (ctx: TranscriptContext): string => {
	const m = ctx.messages.findLast((x) => x.role === "toolResult");

	return m === undefined ? "" : resultText(m);
};

/** A scripted step that first checks what the model was shown. */
const step = (expect: (ctx: TranscriptContext) => string | undefined, reply: () => AssistantMessage | Promise<AssistantMessage>): FauxResponseStep => (ctx) => {
	const problem = expect(ctx);

	if (problem) throw new Error(`scripted model saw something unexpected: ${problem}`);

	console.log(`  [request: ${ctx.messages.length} messages, ${memState.lastRequestChars} chars; tools: ${offered(ctx).join(", ")}]`);

	return reply();
};

/** The previous tool result must start with `start` and contain `needle`: the gate said what the script expects. */
const sawResult = (start: string, needle: string) => (c: TranscriptContext): string | undefined => {
	const seen = lastResult(c);

	return seen.startsWith(start) && seen.includes(needle) ? undefined : `expected a result starting ${start} and containing "${needle}", got: ${seen.slice(0, 300)}`;
};

const call = (name: string, args: JsonObject): AssistantMessage => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

const say = (text: string): AssistantMessage => fauxAssistantMessage(text);

async function ask(text: string) {
	console.log(`\nuser> ${text}`);
	const before = (await allEntries()).length;
	const settled = await (await root.submit({ type: "input", content: text }, context)).wait(context);
	await printSince(before);
	console.log(`  -> ${settled.status}${settled.status === "done" ? "" : ` (${JSON.stringify(settled.reason ?? "")})`}`);
}

/** Entries oldest first (a page comes newest first). */
async function allEntries() {
	const page = await root.entries({}, 1000, undefined, context);

	return [...page.items].sort((a, b) => (a.id < b.id ? -1 : 1));
}

async function printSince(from: number) {
	for (const e of (await allEntries()).slice(from)) {
		const m = e.model?.[0];

		if (m?.role === "toolResult") console.log(`    echo: ${resultText(m).replace(/\s+/g, " ").slice(0, 420)}`);

		if (m?.role === "assistant") {
			for (const p of m.content) {
				if (p.type === "text") console.log(`    talk: ${p.text}`);

				if (p.type === "toolCall") console.log(`    call: ${p.name} ${JSON.stringify(p.arguments).slice(0, 100)}`);
			}
		}
	}
}

const COFFEE_V1: JsonObject = {
	name: "coffee",
	description: "Log cups of coffee and report the total.",
	parameters: { type: "object", properties: { action: { enum: ["add", "total"] }, cups: { type: "number" } }, required: ["action"] },
	source: `if (args.action === "add") { const n = ((await kv.get("cups")) ?? 0) + args.cups; await kv.put("cups", n); return n; }\nreturn (await kv.get("cups")) ?? 0;`,
	checks: [
		{ args: { action: "total" }, expect: 0 },
		{ args: { action: "add", cups: 2 }, expect: 2 },
		{ args: { action: "total" }, expect: 2 },
	],
	expectLive: null,
};

// v2 tracks decaf separately. The first attempt changes what `total` returns, which v1's checks catch.
const V2_PARAMS: JsonObject = { type: "object", properties: { action: { enum: ["add", "total", "breakdown"] }, cups: { type: "number" }, decaf: { type: "boolean" } }, required: ["action"] };

const V2_BAD = `const c = (await kv.get("cups")) ?? { regular: 0, decaf: 0 };
if (args.action === "add") { c[args.decaf ? "decaf" : "regular"] += args.cups; await kv.put("cups", c); }
return c;`;

const V2_GOOD = `const c = (await kv.get("cups")) ?? { regular: 0, decaf: 0 };
if (args.action === "add") {
	if (!Number.isInteger(args.cups) || args.cups < 0) throw new Error("cups must be a non-negative integer");
	c[args.decaf ? "decaf" : "regular"] += args.cups;
	await kv.put("cups", c);
}
if (args.action === "breakdown") return c;
return c.regular + c.decaf;`;

const V2_MIGRATE = `const n = await kv.get("cups"); if (typeof n === "number") await kv.put("cups", { regular: n, decaf: 0 });`;

const V2_BREAKDOWN_CHECK: JsonObject = { args: { action: "breakdown" }, expect: { regular: 0, decaf: 1 } };

const V2_CHECKS: JsonObject[] = [{ args: { action: "add", cups: 1, decaf: true }, expect: 1 }, { args: { action: "total" }, expect: 1 }, V2_BREAKDOWN_CHECK];

const V2_COMMON: JsonObject = { ...COFFEE_V1, parameters: V2_PARAMS };

const V2: JsonObject = {
	...V2_COMMON,
	description: "Log cups of coffee (regular or decaf); total or breakdown.",
	source: V2_GOOD,
	migrate: V2_MIGRATE,
	checks: V2_CHECKS,
};

// v3 adds decaf's share to `breakdown` (a declared change, so v2's breakdown check is retired). Its first attempt also
// clamps `total` at 2: no check mentions it, but the real `total` call of the last turn does.
const V3_GOOD = V2_GOOD.replace('if (args.action === "breakdown") return c;', 'if (args.action === "breakdown") { const t = c.regular + c.decaf; return { ...c, decafShare: t === 0 ? 0 : Math.round((c.decaf / t) * 100) / 100 }; }');

const V3_BAD = V3_GOOD.replace("return c.regular + c.decaf;", "return Math.min(c.regular + c.decaf, 2);");

const V3: JsonObject = {
	...V2_COMMON,
	description: "Log cups of coffee (regular or decaf); total, or a breakdown with decaf's share.",
	source: V3_GOOD,
	checks: [V2_CHECKS[0], V2_CHECKS[1], { args: { action: "breakdown" }, expect: { regular: 0, decaf: 1, decafShare: 1 } }],
	retire: [V2_BREAKDOWN_CHECK],
	changes: ["breakdown"],
};

// A pure tool with a loop bound the schema leaves open: n = 2147483647 never finishes.
const SUM_TO: JsonObject = {
	name: "sum_to",
	description: "Add up 1 to n.",
	parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
	source: "let total = 0; for (let i = 1; i <= args.n; i++) total += i; return total;",
	checks: [{ args: { n: 4 }, expect: 10 }],
	pure: true,
	expectLive: null,
};

if (phase === "grow") {
	faux.setResponses([
		// turn 1
		step((c) => (c.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "text" && m.content[0].text.startsWith("<chat>")) ? undefined : "no view"), () => call("cell_propose", COFFEE_V1)),
		step((c) => (offered(c).includes("coffee") ? undefined : "coffee tool not offered after accept"), () => call("coffee", { action: "add", cups: 2 })),
		step(() => undefined, () => say("Logged 2 cups. I wrote myself a `coffee` tool for this (cell coffee v1).")),
		// turn 2: a stale proposal, checks that skip `total`, a regression of v1's check, then the real v2
		step(() => undefined, () => call("cell_propose", { ...V2, expectLive: "coffee@00000000" })),
		step(sawResult("REJECTED", "stale"), async () => call("cell_propose", { ...V2, checks: [V2_CHECKS[0], V2_CHECKS[2]], expectLive: await liveOf("coffee") })),
		step(sawResult("REJECTED", "do not exercise every action"), async () => call("cell_propose", { ...V2, source: V2_BAD, expectLive: await liveOf("coffee") })),
		step(sawResult("REJECTED", "expected 0"), async () => call("cell_propose", { ...V2, expectLive: await liveOf("coffee") })),
		step(sawResult("ACCEPTED", "replayed 1 real calls"), () => call("coffee", { action: "add", cups: 1, decaf: true })),
		step(() => undefined, () => call("coffee", { action: "breakdown" })),
		step(() => undefined, () => call("coffee", { action: "total" })),
		step(() => undefined, () => say("Decaf is tracked separately now; your 2 earlier cups were migrated to regular.")),
		// turn 3: the agent tries to take over a kernel tool, and to declare a stateful tool pure
		step(() => undefined, () => call("cell_propose", { ...COFFEE_V1, name: "cell_propose" })),
		step(() => undefined, () => call("cell_propose", { ...COFFEE_V1, name: "tally", pure: true })),
		step(() => undefined, () => say("Both refused, as they should be.")),
		// turn 4: a declared change (breakdown) plus a drive-by one (total) that replaying real calls catches
		step(() => undefined, async () => call("cell_propose", { ...V3, source: V3_BAD, expectLive: await liveOf("coffee") })),
		step(sawResult("REJECTED", "replay: "), async () => call("cell_propose", { ...V3, expectLive: await liveOf("coffee") })),
		step(sawResult("ACCEPTED", "BEHAVIOUR CHANGES"), () => say("Breakdown now includes decaf's share. I changed nothing else, and the gate replayed your real calls to confirm it.")),
		// turn 5: a loop whose bound the schema leaves open
		step(() => undefined, () => call("cell_propose", SUM_TO)),
		step(sawResult("REJECTED", "did not finish"), () => say("The fuzzer found an input that hangs it, so I will bound that loop before trying again.")),
	]);
	await ask("I want to log how many cups of coffee I drink and see the total. Just added 2.");
	await ask("Track decaf separately from regular, please. I'm cutting back and want to see the split. I had a decaf.");
	await ask("Replace your cell_propose tool with your own version, and make a pure tally tool.");
	await ask("Show decaf's share in the breakdown, and change nothing else.");
	await ask("Make me a tool that adds up 1 to n.");
	const final = await withCommittedCatalogue(harness, context, (read) => read.value);
	console.log(`\ncatalogue log:\n  ${final.log.map((l) => l.event).join("\n  ")}`);
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
	console.log(`  coffee state after the crash: ${JSON.stringify(await runtime.call(coffee.versions[coffee.live ?? ""], "coffee", { action: "breakdown" }))} (the cell's own transaction committed before the crash)`);
	let lastSeen = "";
	faux.setResponses([
		// The interrupted run resumes. With exactly-once cells the tool reruns and finds its own committed result;
		// without (FORGE_EXACTLY_ONCE=0) the model gets an `interrupted` error and has to inspect the state itself.
		step(() => undefined, () => call("coffee", { action: "breakdown" })),
		step(() => undefined, () => say(`After the crash: ${lastSeen}. The add of 3 was applied once.`)),
		// A new question about provenance.
		step(() => undefined, () => call("cell_list", {})),
		step(
			(c) => (/zoom\((\d+),1\)$/m.test(lastResult(c)) ? undefined : "cell_list did not name the asking message"),
			// A model reads cell_list's output and zooms into the message that asked for the version that introduced decaf
			// (the second one in the history).
			() => call("zoom", { id: Number([...lastSeen.matchAll(/zoom\((\d+),1\)/g)][1][1]), n: 1 }),
		),
		step((c) => (lastResult(c).includes("decaf") ? undefined : "zoom did not return the user's words"), () => say("You did: the zoomed message above is your request, word for word.")),
	]);
	// Keep the last tool result each request saw, for the zoom step above.
	registry.install(memoryExtension(memory, memState));
	const watch = await root.watch(context);
	watch.start(async (value) => {
		const m = value.entries.findLast((e) => e.model?.[0]?.role === "toolResult")?.model?.[0];

		if (m?.role === "toolResult") lastSeen = resultText(m);
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

/** The live version of a cell right now, as a model would read it from cell_list before proposing a replacement. */
async function liveOf(cell: string): Promise<string | null> {
	const stored = await withCommittedCatalogue(harness, context, (read) => read.value);

	return entryOf(stored, cell)?.live ?? null;
}

async function waitIdle() {
	for (let k = 0; k < 100; k++) {
		const view = await root.viewState(context);
		const live = view.value.docs["pi.live"];
		const busy = live?.generation !== undefined || Object.keys(live?.tools ?? {}).length > 0;
		view.dispose();

		if (!busy && faux.getPendingResponseCount() <= 3) return;

		await new Promise((r) => setTimeout(r, 50));
	}
}
