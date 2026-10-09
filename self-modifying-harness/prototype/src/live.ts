// The forge on a real model: the demo's wiring (memory extension, cells slot, kernel, SQLite session, OptChat memory) with
// DeepSeek behind pi-ai instead of the faux provider, and a meter that makes spending a bounded, reported quantity.
//
// Two kinds of model request exist, and both go through the meter:
//   - a turn step: one generation of the harness (the agent speaks, or calls a tool);
//   - a compaction: the OptChat compactor turning a message, or two lines, into one line (`ModelSummarizer`).
// The meter counts every request when it starts and its cost when it ends. Past the limit (calls or dollars, whichever
// first) the next request is refused with an error stream, and `Live.ask` reports `capped`: nothing retries, nothing loops.
//
// The credential is not ours: the egress proxy swaps in the real DeepSeek key for requests to api.deepseek.com, so the
// placeholder below only has to satisfy pi-ai's "is a key configured" check. It is never printed or written.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Message, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type CallerInvariants, reinstallCells, reserveCellsSlot } from "./catalogue.ts";
import { type Catalogue } from "./catalogue-doc.ts";
import { type Complete, ModelSummarizer, type Turn } from "./compaction.ts";
import { CellRuntime } from "./cells.ts";
import { kernelExtension } from "./forge.ts";
import { loadMirror, memoryExtension } from "./memory-extension.ts";
import { Memory } from "./optchat.ts";
import { SYSTEM_PROMPT } from "./optchat-prompt.ts";
import { withCommittedCatalogue } from "./proofs/catalogue-committed.ts";

export const MODEL = { provider: "deepseek", modelId: "deepseek-flash" } as const;

/** USD per million tokens of deepseek-flash, used only when pi-ai reports a request without a cost. */
export const PRICE = { input: 0.3, cacheRead: 0.006, output: 1.2 } as const;

export type Limits = { maxCalls: number; maxCostUsd: number };

export const DEFAULT_LIMITS: Limits = { maxCalls: 60, maxCostUsd: 0.25 };

export type RequestKind = "turn" | "compaction";

/** One model request: DeepSeek's `prompt_cache_hit_tokens` arrives as pi-ai's `usage.cacheRead`; `input` is the cache misses. */
export type UsageRow = { n: number; kind: RequestKind; input: number; cacheRead: number; output: number; costUsd: number; stop: string };

export type Totals = { calls: number; input: number; cacheRead: number; output: number; costUsd: number };

export class CapExceeded extends Error {
	constructor(why: string) {
		super(`spending cap reached: ${why}`);
	}
}

/** Share of a request's prompt that was read from DeepSeek's cache, in percent. */
export const cachePercent = (row: Pick<UsageRow, "input" | "cacheRead">): number => {
	const prompt = row.input + row.cacheRead;

	return prompt === 0 ? 0 : Math.round((row.cacheRead / prompt) * 1000) / 10;
};

const priced = (usage: Usage): number => usage.cost.total > 0 ? usage.cost.total : (usage.input * PRICE.input + usage.cacheRead * PRICE.cacheRead + usage.output * PRICE.output) / 1_000_000;

/** Counts requests and dollars and refuses the request that would start past a limit. Rows are appended as requests end. */
export class Meter {
	readonly rows: UsageRow[] = [];
	readonly limits: Limits;
	tripped: CapExceeded | undefined;
	private started = 0;

	constructor(limits: Partial<Limits> = {}) {
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/** Called as a request starts. Throws once a limit is reached, and keeps throwing: a tripped meter stays tripped. */
	admit(): void {
		if (this.tripped === undefined && this.started >= this.limits.maxCalls) this.tripped = new CapExceeded(`${this.started} model calls (limit ${this.limits.maxCalls})`);

		if (this.tripped === undefined && this.costUsd >= this.limits.maxCostUsd) this.tripped = new CapExceeded(`$${this.costUsd.toFixed(4)} spent (limit $${this.limits.maxCostUsd})`);

		if (this.tripped !== undefined) throw this.tripped;
		this.started++;
	}

	/** Called as a request ends, with the usage pi-ai parsed from the response. */
	record(kind: RequestKind, usage: Usage, stop: string): UsageRow {
		const row: UsageRow = { n: this.rows.length + 1, kind, input: usage.input, cacheRead: usage.cacheRead, output: usage.output, costUsd: priced(usage), stop };
		this.rows.push(row);

		return row;
	}

	get costUsd(): number {
		let sum = 0;

		for (const row of this.rows) sum += row.costUsd;

		return sum;
	}

	totals(kind?: RequestKind): Totals {
		const t: Totals = { calls: 0, input: 0, cacheRead: 0, output: 0, costUsd: 0 };

		for (const row of this.rows) {
			if (kind !== undefined && row.kind !== kind) continue;
			t.calls++;
			t.input += row.input;
			t.cacheRead += row.cacheRead;
			t.output += row.output;
			t.costUsd += row.costUsd;
		}

		return t;
	}

	/** The line every run ends with. */
	summary(): string {
		const part = (label: string, t: Totals): string => `${label} ${t.calls} calls, ${t.input + t.cacheRead} prompt tokens (${cachePercent(t)}% from cache), ${t.output} out, $${t.costUsd.toFixed(4)}`;
		const all = this.totals();

		return `spend: ${all.calls} of ${this.limits.maxCalls} calls, $${all.costUsd.toFixed(4)} of $${this.limits.maxCostUsd.toFixed(2)} | ${part("turns", this.totals("turn"))} | ${part("compactions", this.totals("compaction"))}${this.tripped === undefined ? "" : ` | ABORTED: ${this.tripped.message}`}`;
	}
}

const refused = (model: Model<Api>, error: CapExceeded): AssistantMessageEventStream => {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "error", errorMessage: error.message, timestamp: Date.now() };
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);

	return stream;
};

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A provider behind a meter: each request is admitted before it is sent and its usage is recorded when it ends. */
export function meteredProvider(base: Provider, meter: Meter, kind: RequestKind): Provider {
	const tap = (send: () => AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream => {
		try {
			meter.admit();
		} catch (error) {
			if (error instanceof CapExceeded) return refused(model, error);

			throw error;
		}

		const stream = send();
		void stream.result().then((message) => meter.record(kind, message.usage, message.stopReason));

		return stream;
	};

	return {
		...base,
		stream: (model, context, options) => tap(() => base.stream(model, context, options), model),
		streamSimple: (model, context, options) => tap(() => base.streamSimple(model, context, options), model),
	};
}

/** DeepSeek through pi-ai. The proxy supplies the real key; the placeholder only has to be non-empty for pi-ai's env auth. */
function deepseek(): Provider {
	process.env.DEEPSEEK_API_KEY ??= "proxy-injected";

	return deepseekProvider();
}

const textOf = (message: AssistantMessage): string => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** A compaction conversation as pi-ai messages; the assistant turns ("Too long" retries) are replayed as the model's own words. */
function asMessages(turns: Turn[]): Message[] {
	const at = Date.now();

	return turns.map((turn): Message => {
		const parts: TextContent[] = turn.parts.map((text) => ({ type: "text", text }));

		return turn.role === "user"
			? { role: "user", content: parts, timestamp: at }
			: { role: "assistant", content: parts, api: "openai-completions", provider: MODEL.provider, model: MODEL.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: at };
	});
}

/** The compactor's model call: the constant system prompt (which carries the compaction rules), no tools, low reasoning effort. */
function compactionCall(meter: Meter): Complete {
	const models = createModels();
	models.setProvider(meteredProvider(deepseek(), meter, "compaction"));

	return async (turns) => {
		const model = models.getModel(MODEL.provider, MODEL.modelId);

		if (model === undefined) throw new Error(`no model ${MODEL.provider}/${MODEL.modelId}`);
		const reply = await models.completeSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: asMessages(turns) }, { reasoning: "low", maxTokens: 2_000, maxRetries: 0 });

		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `compaction request ${reply.stopReason}`);

		return textOf(reply);
	};
}

// --- opening the forge ---

export type LiveOptions = { limits?: Partial<Limits> };

/** What one submitted message did, in the order it happened. */
export type TurnEvent =
	| { kind: "call"; name: string; args: string }
	| { kind: "result"; name: string; text: string; isError: boolean }
	| { kind: "reply"; text: string };

export type Turned = { status: string; reason: string; events: TurnEvent[]; capped: CapExceeded | undefined };

export type Live = {
	memory: Memory;
	meter: Meter;
	runtime: CellRuntime;
	ask(text: string, onEvent?: (event: TurnEvent) => void): Promise<Turned>;
	catalogue(): Promise<Catalogue>;
	close(): Promise<void>;
};

// The model is the caller's only counterpart here: no caller-owned invariants.
const NO_INVARIANTS: CallerInvariants = {};

/**
 * Open (or reopen) the forge over `dataDir`: `session.sqlite` (pi-durable), `cells/` (code and state), `chat/` (OptChat).
 * Reopening the same directory resumes the same chat, reinstalls the tools from the catalog and keeps the memory.
 */
export async function openLive(dataDir: string, options: LiveOptions = {}): Promise<Live> {
	mkdirSync(dataDir, { recursive: true });
	const meter = new Meter(options.limits);
	const runtime = new CellRuntime(join(dataDir, "cells"));
	const summarizer = new ModelSummarizer(compactionCall(meter));

	// Real budgets: the OptChat defaults (view 64k to 128k bytes, compaction view 16k to 32k).
	const memory = new Memory(join(dataDir, "chat"), { summarizer });
	const memState = loadMirror(memory);
	const models = createModels();
	models.setProvider(meteredProvider(deepseek(), meter, "turn"));
	const registry = createRegistry();
	registry.install(memoryExtension(memory, memState));
	reserveCellsSlot(registry);

	let harness!: Harness;
	registry.install(kernelExtension({ harness: () => harness, registry, runtime, memory, currentRequest: () => memState.runStartLog, invariants: NO_INVARIANTS }));

	// No durable retries and no SDK retries: a failed request is reported, not repeated. pi-durable's own compaction is off
	// (OptChat is the memory, and the context window is 1M tokens).
	const settings = { retry: { enabled: false }, stream: { maxRetries: 0, timeoutMs: 180_000 }, compaction: { enabled: false } };
	harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "session.sqlite")), { models, registry, settings }, BACKGROUND_CONTEXT);
	await reinstallCells(harness, registry, runtime, BACKGROUND_CONTEXT, NO_INVARIANTS);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });

	const entries = async () => [...(await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT)).items].sort((a, b) => (a.id < b.id ? -1 : 1));

	return {
		memory,
		meter,
		runtime,
		catalogue: () => withCommittedCatalogue(harness, BACKGROUND_CONTEXT, (read) => read.value),
		async ask(text, onEvent) {
			const before = (await entries()).length;
			const settled = await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			const events: TurnEvent[] = [];

			for (const entry of (await entries()).slice(before)) {
				const message = entry.model?.[0];

				if (message === undefined) continue;

				if (message.role === "toolResult") events.push({ kind: "result", name: message.toolName, text: message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""), isError: message.isError });

				if (message.role === "assistant") {
					const said = textOf(message);

					for (const part of message.content) {
						if (part.type === "toolCall") events.push({ kind: "call", name: part.name, args: JSON.stringify(part.arguments) });
					}

					if (said !== "") events.push({ kind: "reply", text: said });

					if (message.stopReason === "error" && message.errorMessage !== undefined) events.push({ kind: "reply", text: `(model request failed: ${message.errorMessage})` });
				}
			}

			for (const event of events) onEvent?.(event);

			return { status: settled.status, reason: settled.status === "done" ? "" : JSON.stringify(settled.reason ?? ""), events, capped: meter.tripped };
		},
		async close() {
			await memory.idle();
			await runtime.close();
			await harness.close(BACKGROUND_CONTEXT);
		},
	};
}

/** The catalog in a few lines per cell: live version, history, the version each asked-for message, then the accept/reject log. */
export function describeCatalogue(catalogue: Catalogue): string {
	const lines: string[] = [];

	for (const [cell, entry] of Object.entries(catalogue.cells)) {
		lines.push(`${cell}: live ${entry.live ?? "none"}${entry.pending === null ? "" : `, pending ${entry.pending}`}`);

		for (const id of entry.history) {
			const v = entry.versions[id];
			lines.push(`  ${id}${id === entry.live ? " (live)" : ""}: asked for by message ${v.why ?? "?"}; ${v.checks.length} checks, ${v.invariants.length} invariants${v.migrate === undefined ? "" : ", migrates state"}; "${v.description}"`);
		}
	}

	if (lines.length === 0) lines.push("(no cells)");
	lines.push("log:", ...catalogue.log.map((l) => `  ${l.at} ${l.event}`));

	return lines.join("\n");
}

const oneLine = (text: string, n: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();

	return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

/** One line per event, or the whole text with /verbose. */
export function show(event: TurnEvent, verbose: boolean): string {
	switch (event.kind) {
		case "call":
			return `  call   ${event.name} ${verbose ? event.args : oneLine(event.args, 110)}`;
		case "result":
			return `  result ${event.isError ? "(error) " : ""}${verbose ? event.text : oneLine(event.text, 200)}`;
		case "reply":
			return `agent> ${event.text}`;
	}
}
