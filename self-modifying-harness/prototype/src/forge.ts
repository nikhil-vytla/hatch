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
//
// The two places where unverified code could reach the live system are behind gdp-ts proofs (src/proofs/): a version
// enters the catalogue only through `acceptVersion` (needs `CellVerified`), and code enters the registry only through
// `installCells` (needs `CatalogueCommitted`). The kernel tools below are the callers; they cannot skip either.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type Message,
	type SystemMessage,
	type TextContent,
	type Tool,
	Type,
} from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	type Harness,
	type Registry,
	section,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { name, type Named } from "@gdp-ts/core";
import {
	type CallerInvariants,
	commitVerified,
	ownedInvariants,
	recordRejection,
	refreshCells,
	rollbackVersion,
	StaleError,
} from "./catalogue.ts";
import { type Catalogue, entryOf, staleReason } from "./catalogue-doc.ts";
import type { CellRuntime, CellVersion } from "./cells.ts";
import type { GateReport } from "./gate.ts";
import type { Kind, Memory } from "./optchat.ts";
import { type CatalogueCommitted, withCommittedCatalogue } from "./proofs/catalogue-committed.ts";
import { withAcceptedVersion } from "./proofs/cell-accepted.ts";
import { verifyCell } from "./proofs/cell-verified.ts";
import { candidateOf, ExpectLive, type Proposal, parseProposal, ProposeParameters } from "./proposal.ts";

export type KernelOptions = {
	harness: () => Harness;
	registry: Registry;
	runtime: CellRuntime;
	memory: Memory;
	currentRequest: () => number | undefined;
	invariants: CallerInvariants; // caller-owned invariants by cell name: the model cannot propose, change or drop them
};

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

function acceptedText(version: string, cell: string, report: GateReport): string {
	const lines = [
		`ACCEPTED ${version} (passed ${report.checks} checks; replayed ${report.replayed} real calls${report.replaySkipped > 0 ? `, ${report.replaySkipped} skipped through the migration` : ""}; fuzzed ${report.fuzz.ran} of ${report.fuzz.generated} generated inputs in ${report.fuzz.executions} of a budget of ${report.fuzz.budget} sandbox executions). The tool "${cell}" is available from your next step.`,
	];

	if (report.behaviourDiffs.length > 0) {
		lines.push(`BEHAVIOUR CHANGES you declared, which the user should hear about: ${report.behaviourDiffs.map((d) => `${JSON.stringify(d.args)}: ${d.summary}`).join("; ")}`);
	}

	for (const advisory of report.advisories) lines.push(`ADVISORY ${advisory}`);

	return lines.join(" ");
}

export function kernelExtension(options: KernelOptions) {
	const { registry, runtime, memory } = options;

	// Everything that follows a parsed proposal and its named candidate: gate, then the three-step commit, then install.
	const decide = async <C, K>(
		candidate: Named<C, CellVersion>,
		catalogue: Named<K, Catalogue>,
		committed: CatalogueCommitted<K>,
		proposal: Proposal,
		api: ToolExecutionApi,
		context: Context,
	): Promise<string> => {
		const version = candidate.value.version;
		const live = entryOf(catalogue.value, proposal.cell)?.live ?? null;

		if (live === version && proposal.expectLive === live) return `unchanged: ${version} is already live`;

		const owned = ownedInvariants(options.invariants, proposal.cell);
		const verdict = await verifyCell(candidate, catalogue, committed, runtime, { expectLive: proposal.expectLive, owned, changes: proposal.changes });

		const reject = async (reason: string) => {
			await api.commit((tx) => recordRejection(tx, version, reason), context);

			return `REJECTED ${version}: ${reason}. The live version is unchanged.`;
		};

		if (!verdict.ok) return reject(verdict.reason);

		const done = await commitVerified(api, context, runtime, candidate, verdict.proof, proposal.expectLive, owned);

		if (!done.ok) return reject(done.reason);

		await refreshCells(api, context, registry, runtime, options.invariants);

		return acceptedText(version, proposal.cell, verdict.report);
	};

	const propose = defineTool({
		name: "cell_propose",
		description:
			"Create or replace one of your own tools. `source` is the body of an async JS function with `args` and a `kv` store " +
			"(kv.get/put/delete/keys) in scope; return the result. `expectLive` is REQUIRED: the live version id you read (cell_list or " +
			"cell_source) and are replacing, or null if you expect the tool not to exist; a stale value is rejected. `checks` are examples " +
			"({args, expect}) run in order from an empty state; between them they must pass every value of every enum parameter. Every " +
			"check of the tool's earlier accepted versions must still pass unless listed in `retire`. `invariants` ({name, source}) are " +
			"function bodies over a read-only `kv` that must return true after every call; once proposed they can never be dropped, so " +
			"send every earlier one again. `changes` lists the values of the action (enum) parameter whose behaviour this version " +
			"intends to change (or [\"*\"]): your recent real calls are replayed, and a differing one outside `changes` is rejected. " +
			"`migrate` (optional) runs once against the tool's existing state when the version is accepted.",
		parameters: ProposeParameters,
		executionMode: "sequential",
		execute: async (args, api, context) => {
			const proposal = parseProposal(args);

			const reply = await withCommittedCatalogue(api, context, (catalogue, committed) =>
				name(candidateOf(proposal, catalogue.value, options.currentRequest()), (candidate) => decide(candidate, catalogue, committed, proposal, api, context)),
			);

			return text(reply);
		},
	});

	const rollback = defineTool({
		name: "cell_rollback",
		description:
			"Make an earlier accepted version of a tool live again. Its state is not rolled back. `expectLive` is REQUIRED: the live " +
			"version id you read and are replacing; a stale value is rejected.",
		parameters: Type.Object({ name: Type.String(), version: Type.String(), expectLive: ExpectLive }),
		executionMode: "sequential",
		execute: async (args, api, context) => {
			const outcome = await withCommittedCatalogue(api, context, async (catalogue, committed) => {
				const stale = staleReason(entryOf(catalogue.value, args.name), args.expectLive);

				if (stale !== undefined) return stale;

				const accepted = await withAcceptedVersion(catalogue, committed, args.name, args.version, async (target, proof) => {
					try {
						await api.commit((tx) => rollbackVersion(tx, target, proof, args.expectLive), context);

						return undefined;
					} catch (error) {
						if (error instanceof StaleError) return error.message;

						throw error;
					}
				});

				return accepted.ok ? accepted.value : accepted.reason;
			});

			if (outcome !== undefined) return text(`REFUSED: ${outcome}`);

			await refreshCells(api, context, registry, runtime, options.invariants);

			return text(`${args.name} is now ${args.version}`);
		},
	});

	const list = defineTool({
		name: "cell_list",
		description: "List your tools, their versions, and the chat message that asked for each version.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const catalogue = await withCommittedCatalogue(api, context, (read) => read.value);

			const rows = Object.entries(catalogue.cells).map(([cell, e]) => {
				const asked = e.history.map((v) => `zoom(${e.versions[v].why},1)`).join(", ");

				return `${cell}: live ${e.live ?? "none"}${e.pending === null ? "" : `; pending ${e.pending}`}; history ${e.history.join(" -> ")}; asked for by ${asked}`;
			});

			return text(rows.join("\n") || "(no cells)");
		},
	});

	const source = defineTool({
		name: "cell_source",
		description: "Read the source, checks and invariants of one version of a tool (default: live).",
		parameters: Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) }),
		replay: "safe",
		execute: async (args, api, context) => {
			const catalogue = await withCommittedCatalogue(api, context, (read) => read.value);
			const entry = entryOf(catalogue, args.name);
			const wanted = args.version ?? entry?.live ?? undefined;
			const cell = wanted === undefined ? undefined : entry?.versions[wanted];

			if (cell === undefined) throw new Error("no such cell");

			return text(JSON.stringify(cell, null, 2));
		},
	});

	const zoom = defineTool({
		name: "zoom",
		description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
		parameters: Type.Object({ id: Type.Number(), n: Type.Number() }),
		replay: "safe",
		execute: async (args) => text(memory.zoom(args.id, args.n)),
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

function isSystem(message: Message): message is SystemMessage {
	return message.role === "system";
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
						const prev = messages[cut - 1];

						if (prev.role === "assistant" && prev.stopReason !== "toolUse") break;

						cut--;
					}

					// Mirror every message not yet logged (the transcript is immutable, so a count is enough).
					for (let k = state.logged; k < messages.length; k++) {
						if (k === cut) state.runStartLog = memory.length;

						for (const [kind, line] of toLog(messages[k])) memory.log(kind, line);
					}

					if (state.logged <= cut && cut === messages.length) state.runStartLog = memory.length;

					state.logged = messages.length;
					writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));

					const viewUpTo = state.runStartLog ?? memory.length;
					const view: Message = { role: "user", content: [{ type: "text", text: memory.render(viewUpTo) }], timestamp: 0 };
					// pi-durable announces prompt sections and tools as positional system messages. The leading one stays first
					// (constant, cacheable); later ones before the cut are folded into one delta placed after the view, so a
					// self-written tool stays on offer without rewriting the head of every cached prefix.
					const head = messages[0]?.role === "system" ? [messages[0]] : [];
					const delta = foldSystem(messages.slice(head.length, cut).filter(isSystem));
					const out = [...head, view, ...(delta === undefined ? [] : [delta]), ...messages.slice(cut)];
					state.lastRequestChars = JSON.stringify(out).length;

					return { messages: out };
				},
				// A final answer is logged as it happens (the spec logs everything as it happens); the next request's
				// transcript will hold it as one more message, already mirrored.
				onYield: (answer) => {
					for (const [kind, line] of toLog(answer)) memory.log(kind, line);

					state.logged += 1;
					writeFileSync(join(memory.dir, "mirror.json"), JSON.stringify(state));

					return undefined;
				},
			}),
		],
	});
}

function foldSystem(systems: SystemMessage[]): SystemMessage | undefined {
	if (systems.length === 0) return undefined;

	const sections: Record<string, string | null> = {};
	const tools = new Map<string, Tool>();
	const removed = new Set<string>();
	const content: string[] = [];

	for (const m of systems) {
		const written = Array.isArray(m.content) ? m.content.map((part) => part.text).join("") : m.content;

		if (written) content.push(written);

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

	const folded: SystemMessage = { role: "system", content: content.join("\n"), timestamp: systems[systems.length - 1].timestamp };

	if (Object.keys(sections).length > 0) folded.sections = sections;

	if (tools.size > 0) folded.toolsAdded = [...tools.values()];

	if (removed.size > 0) folded.toolsRemoved = [...removed].map((toolName) => ({ name: toolName }));

	return folded;
}

function textParts(parts: string | (TextContent | { type: string })[]): string {
	return Array.isArray(parts) ? parts.flatMap((p) => (p.type === "text" && "text" in p ? [String(p.text)] : [])).join("\n") : parts;
}

function toLog(m: Message): [Kind, string][] {
	switch (m.role) {
		case "system":
			return [];
		case "user":
			return [["user", textParts(m.content)]];
		case "toolResult":
			return [["echo", textParts(m.content).slice(0, 30_000)]];
		case "assistant": {
			const out: [Kind, string][] = [];
			const talk = textParts(m.content);

			if (talk) out.push(["talk", talk]);

			for (const p of m.content) {
				if (p.type === "toolCall") out.push(["tool", `${p.name} ${JSON.stringify(p.arguments)}`]);
			}

			return out;
		}
	}
}
