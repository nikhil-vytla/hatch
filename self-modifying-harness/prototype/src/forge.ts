// The forge: a pi-durable harness whose agent can write, verify, hot-install and roll back its own tools.
//
// Three pieces, one per source:
//   - pi-durable: the cell catalogue is a Session document, committed in the same atomic line as the transcript;
//     `registry.install()` swaps the "cells" extension in place, so the next request offers the new tools while a running
//     call finishes on the code it started with. After a crash the catalogue is reinstalled from the document.
//   - celld: each tool is a cell (cells.ts): immutable versioned code plus state that outlives code versions.
//   - OptChat: each turn starts fresh from a view of the whole chat (optchat.ts), and every cell version records the
//     log index of the user words that asked for it, so "why does this tool exist?" is always one zoom away.
//
// The kernel (this file's `kernel` extension) is the part the agent cannot rewrite. It is installed after the cells
// extension so that a cell named like a kernel tool can never replace it (pi-durable: a later extension's tool with the
// same name wins), and the gate also refuses such names outright.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	type Harness,
	type Registry,
	section,
} from "@earendil-works/pi-durable";
import { type CellRuntime, type CellVersion, type Check, deepEqual, versionId } from "./cells.ts";
import type { Memory } from "./optchat.ts";

export type Catalogue = {
	cells: Record<string, { live: string; versions: Record<string, CellVersion>; history: string[] }>;
	log: { at: string; event: string }[];
};

export const CellsDoc = defineDoc<Catalogue>({
	kind: "app.cells",
	version: 1,
	scope: "session",
	initial: () => ({ cells: {}, log: [] }),
});

const KERNEL_TOOLS = new Set(["cell_propose", "cell_rollback", "cell_list", "cell_source", "zoom"]);
const NAME = /^[a-z][a-z0-9_]{1,40}$/;

/** The agent-written tools: one per live cell, rebuilt from the catalogue on every change. */
const exactlyOnce = process.env.FORGE_EXACTLY_ONCE !== "0";

export function cellsExtension(catalogue: Catalogue, runtime: CellRuntime) {
	const tools = Object.entries(catalogue.cells).map(([name, entry]) => {
		const cell = entry.versions[entry.live];
		return defineTool({
			name,
			description: `${cell.description} (cell ${cell.version})`,
			parameters: Type.Unsafe<Record<string, unknown>>(cell.parameters),
			// Every cell is replay-safe when calls are exactly-once (cells.ts records the call id with the effects).
			replay: exactlyOnce ? "safe" : cell.replay,
			execute: async (args, api) => {
				const value = await runtime.call(cell, name, args, exactlyOnce ? `${api.taskId}:${api.callId}` : undefined);
				// Demo only: die after the cell's own SQLite transaction committed but before pi-durable stored the result,
				// the window in which a rerun would apply the effect twice.
				if (process.env.FORGE_CRASH_AFTER_CELL === name) process.exit(137);
				return { content: [{ type: "text", text: JSON.stringify(value) }], details: { version: cell.version } };
			},
		});
	});
	return defineExtension({ name: "cells", tools });
}

export async function reinstallCells(harness: Harness, registry: Registry, runtime: CellRuntime, context: any): Promise<Catalogue> {
	const catalogue = ((await harness.snapshot(CellsDoc, context)) ?? { cells: {}, log: [] }) as Catalogue;
	registry.install(cellsExtension(catalogue, runtime));
	return catalogue;
}

/**
 * The checks a candidate owes: every accepted version's own checks along the live lineage (a ratchet), minus any the
 * candidate explicitly retires. Retiring is allowed, but it is recorded, with the candidate's `why`.
 */
function owed(entry: Catalogue["cells"][string] | undefined, candidate: CellVersion): Check[][] {
	const groups: Check[][] = [];
	for (let v = entry?.live; v !== undefined; v = entry!.versions[v].parent) {
		const kept = entry!.versions[v].checks.filter((c) => !candidate.retired.some((r) => deepEqual(r, c)));
		if (kept.length > 0) groups.unshift(kept);
	}
	groups.push(candidate.checks);
	return groups;
}

export function kernelExtension(options: { harness: () => Harness; registry: Registry; runtime: CellRuntime; memory: Memory; currentRequest: () => number | undefined }) {
	const { registry, runtime, memory } = options;

	const propose = defineTool({
		name: "cell_propose",
		description:
			"Create or replace one of your own tools. `source` is the body of an async JS function with `args` and a `kv` store " +
			"(kv.get/put/delete/keys) in scope; return the result. `checks` are examples ({args, expect}) run in order from an " +
			"empty state. Every check of the tool's earlier accepted versions must still pass unless listed in `retire`. " +
			"`migrate` (optional) runs once against the tool's existing state when the version is accepted.",
		parameters: Type.Object({
			name: Type.String(),
			description: Type.String(),
			parameters: Type.Any(),
			source: Type.String(),
			checks: Type.Array(Type.Object({ args: Type.Any(), expect: Type.Any() })),
			retire: Type.Optional(Type.Array(Type.Object({ args: Type.Any(), expect: Type.Any() }))),
			migrate: Type.Optional(Type.String()),
			pure: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		execute: async (args, api, context) => {
			if (!NAME.test(args.name) || KERNEL_TOOLS.has(args.name)) throw new Error(`refused: "${args.name}" is not a name a cell may take`);
			if (args.checks.length === 0) throw new Error("refused: a cell needs at least one check");
			const catalogue = (await api.snapshot(CellsDoc, context)) as Catalogue | undefined;
			const entry = catalogue?.cells[args.name];
			const candidate: CellVersion = {
				version: versionId(args.name, args.source, args.migrate),
				description: args.description,
				parameters: args.parameters ?? { type: "object" },
				source: args.source,
				migrate: args.migrate,
				checks: args.checks,
				retired: args.retire ?? [],
				parent: entry?.live,
				why: options.currentRequest(),
				replay: args.pure ? "safe" : "unsafe",
			};
			if (entry?.live === candidate.version) return { content: [{ type: "text", text: `unchanged: ${candidate.version} is already live` }] };
			const verdict = await runtime.verify(args.name, candidate, owed(entry, candidate));
			if (!verdict.ok) {
				await api.commit(async (tx) => {
					(await tx.doc(CellsDoc)).log.push({ at: new Date().toISOString(), event: `rejected ${candidate.version}: ${verdict.reason}` });
				}, context);
				return { content: [{ type: "text", text: `REJECTED ${candidate.version}: ${verdict.reason}. The live version is unchanged.` }] };
			}
			// Accept: migrate the real state, commit the catalogue, then hot-swap the tools. The migration is the one step
			// outside the commit; a crash between the two leaves migrated state under the old code (see README, gaps).
			await runtime.migrate(args.name, candidate);
			const next = await api.commit(async (tx) => {
				const doc = await tx.doc(CellsDoc);
				// Assign first, then edit through the draft: a plain object kept from before the assignment is not the draft.
				if (doc.cells[args.name] === undefined) doc.cells[args.name] = { live: candidate.version, versions: {}, history: [] };
				const e = doc.cells[args.name];
				e.versions[candidate.version] = JSON.parse(JSON.stringify(candidate)); // documents hold strict JSON: no undefined
				e.live = candidate.version;
				e.history.push(candidate.version);
				doc.log.push({ at: new Date().toISOString(), event: `accepted ${candidate.version}${candidate.retired.length ? `, retiring ${candidate.retired.length} check(s)` : ""}` });
				return JSON.parse(JSON.stringify(doc)) as Catalogue;
			}, context);
			registry.install(cellsExtension(next, runtime));
			return { content: [{ type: "text", text: `ACCEPTED ${candidate.version} (passed ${owed(entry, candidate).flat().length} checks). The tool "${args.name}" is available from your next step.` }] };
		},
	});

	const rollback = defineTool({
		name: "cell_rollback",
		description: "Make an earlier accepted version of a tool live again. Its state is not rolled back.",
		parameters: Type.Object({ name: Type.String(), version: Type.String() }),
		executionMode: "sequential",
		execute: async (args, api, context) => {
			const next = await api.commit(async (tx) => {
				const doc = await tx.doc(CellsDoc);
				const entry = doc.cells[args.name];
				if (entry?.versions[args.version] === undefined) throw new Error(`no version ${args.version} of ${args.name}`);
				entry.live = args.version;
				entry.history.push(args.version);
				doc.log.push({ at: new Date().toISOString(), event: `rolled ${args.name} back to ${args.version}` });
				return JSON.parse(JSON.stringify(doc)) as Catalogue;
			}, context);
			registry.install(cellsExtension(next, runtime));
			return { content: [{ type: "text", text: `${args.name} is now ${args.version}` }] };
		},
	});

	const list = defineTool({
		name: "cell_list",
		description: "List your tools, their versions, and the chat message that asked for each version.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const catalogue = (await api.snapshot(CellsDoc, context)) as Catalogue | undefined;
			const rows = Object.entries(catalogue?.cells ?? {}).map(([name, e]) =>
				`${name}: live ${e.live}; history ${e.history.join(" -> ")}; asked for by ${e.history.map((v) => `zoom(${e.versions[v].why},1)`).join(", ")}`,
			);
			return { content: [{ type: "text", text: rows.join("\n") || "(no cells)" }] };
		},
	});

	const source = defineTool({
		name: "cell_source",
		description: "Read the source and checks of one version of a tool (default: live).",
		parameters: Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const entry = ((await api.snapshot(CellsDoc, context)) as Catalogue | undefined)?.cells[args.name];
			const cell = entry?.versions[args.version ?? entry.live];
			if (cell === undefined) throw new Error(`no such cell`);
			return { content: [{ type: "text", text: JSON.stringify(cell, null, 2) }] };
		},
	});

	const zoom = defineTool({
		name: "zoom",
		description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
		parameters: Type.Object({ id: Type.Number(), n: Type.Number() }),
		replay: "safe",
		execute: async (args) => ({ content: [{ type: "text", text: memory.zoom(args.id, args.n) }] }),
	});

	return defineExtension({
		name: "kernel",
		tools: [propose, rollback, list, source, zoom],
		sections: [
			section("preamble", () => "You are an agent that grows its own tools. When the user needs something you cannot do, write a tool for it with cell_propose, with checks. Say in your reply what you learned that will matter later.", { tag: false }),
		],
	});
}

/**
 * OptChat's turn shape on pi-durable: a `beforeRequest` hook that mirrors the transcript into the memory log and
 * replaces everything before the current run with the rendered view. The current run (its user message and tool rounds)
 * stays verbatim, as in the spec ("each user message starts a fresh model call"; steps within the call are kept).
 */
export type MirrorState = { logged: number; runStartLog?: number; lastRequestChars?: number };

/** How far the transcript is mirrored into the log survives restarts in the memory's own directory. */
export function loadMirror(memory: Memory): MirrorState {
	const path = join(memory.dir, "mirror.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { logged: 0 };
}

export function memoryExtension(memory: Memory, state: MirrorState) {
	return defineExtension({
		name: "memory",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: (request) => {
					const messages = request.messages;
					let cut = messages.length;
					while (cut > 0) {
						const prev = messages[cut - 1] as any;
						if (prev.role === "assistant" && prev.stopReason !== "toolUse") break;
						cut--;
					}
					// Mirror every message not yet logged (the transcript is immutable, so a count is enough).
					for (let k = state.logged; k < messages.length; k++) {
						const m = messages[k] as any;
						if (k === cut) state.runStartLog = memory.length;
						for (const [kind, text] of toLog(m)) memory.log(kind, text);
					}
					if (state.logged <= cut && cut === messages.length) state.runStartLog = memory.length;
					state.logged = messages.length;
					writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));
					const viewUpTo = state.runStartLog ?? memory.length;
					const view: Message = { role: "user", content: [{ type: "text", text: memory.render(viewUpTo) }], timestamp: 0 } as Message;
					// pi-durable announces prompt sections and tools as positional system messages. The leading one stays first
					// (constant, cacheable); later ones before the cut are folded into one delta placed after the view, so a
					// self-written tool stays on offer without rewriting the head of every cached prefix.
					const head = messages[0]?.role === "system" ? [messages[0]] : [];
					const delta = foldSystem(messages.slice(head.length, cut).filter((m) => m.role === "system") as any[]);
					const out = [...head, view, ...(delta ? [delta] : []), ...messages.slice(cut)];
					state.lastRequestChars = JSON.stringify(out).length;
					return { messages: out };
				},
				// A final answer is logged as it happens (the spec logs everything as it happens); the next request's
				// transcript will hold it as one more message, already mirrored.
				onYield: (answer) => {
					for (const [kind, text] of toLog(answer)) memory.log(kind, text);
					state.logged += 1;
					writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));
					return undefined;
				},
			}),
		],
	});
}

function foldSystem(systems: any[]): Message | undefined {
	if (systems.length === 0) return undefined;
	const sections: Record<string, string | null> = {};
	const tools = new Map<string, any>();
	const removed = new Set<string>();
	const content: string[] = [];
	for (const m of systems) {
		const text = typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text).join("");
		if (text) content.push(text);
		Object.assign(sections, m.sections ?? {});
		for (const t of m.toolsRemoved ?? []) {
			tools.delete(t.name);
			removed.add(t.name);
		}
		for (const t of m.toolsAdded ?? []) {
			tools.set(t.name, t);
			removed.delete(t.name);
		}
	}
	return {
		role: "system",
		content: content.join("\n"),
		...(Object.keys(sections).length ? { sections } : {}),
		...(tools.size ? { toolsAdded: [...tools.values()] } : {}),
		...(removed.size ? { toolsRemoved: [...removed].map((name) => ({ name })) } : {}),
		timestamp: systems.at(-1).timestamp,
	} as Message;
}

function toLog(m: any): [import("./optchat.ts").Kind, string][] {
	const text = (parts: any) => (typeof parts === "string" ? parts : parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
	if (m.role === "system") return [];
	if (m.role === "user") return [["user", text(m.content)]];
	if (m.role === "toolResult") return [["echo", text(m.content).slice(0, 30_000)]];
	const out: [import("./optchat.ts").Kind, string][] = [];
	const talk = text(m.content);
	if (talk) out.push(["talk", talk]);
	for (const p of m.content) if (p.type === "toolCall") out.push(["tool", `${p.name} ${JSON.stringify(p.arguments)}`]);
	return out;
}
