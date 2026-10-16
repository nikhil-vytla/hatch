// Why: a tool that returns a big value (a long `cell_source`, a 50 KB list) would otherwise ride in the pi-durable
// session, the OptChat log, the next model request and every compaction that touches it. Values over `spillBytes` go to
// a side SQLite file that no cell can reach, and history keeps a small pointer naming the reader tools that reopen it.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { Type, type ToolCall } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	hook,
	ToolTask,
	type Extension,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CellRuntime } from "./cells.ts";
import { isObject } from "./schema-fuzz.ts";

export type SpillPolicy = { spillBytes: number; previewChars: number };

export const DEFAULT_SPILL_POLICY: SpillPolicy = { spillBytes: 8192, previewChars: 500 };

const READ_TOOL = "result_read";

const GREP_TOOL = "result_grep";

const QUERY_TOOL = "result_query";

/**
 * Tools whose output is never spilled: the readers of a spilled ref (their answers are already bounded), and the
 * kernel's OptChat recall tools `zoom` and `date` (their output is recall, and a pointer to a pointer is useless).
 */
export const NEVER_SPILLED_TOOLS = new Set([READ_TOOL, GREP_TOOL, QUERY_TOOL, "zoom", "date"]);

const DEFAULT_READ = 4_000;

const MAX_READ = 8_000;

const DEFAULT_GREP = 20;

const MAX_GREP = 100;

// How far before and after a match a `result_grep` window reaches, and how many items a shape preview shows.
const GREP_WINDOW = 120;

const PREVIEW_ITEMS = 3;

const MAX_ANSWER = 8_000;

const NOTE = "answer questions with result_query({ref, expr}) (r is the parsed value); search with result_grep({ref, pattern}); page with result_read({ref, offset, length})";

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export type StoredResult = { text: string; size: number };

type SqlValue = null | number | bigint | string | Uint8Array;

const isText = (value: SqlValue): value is string => String(value) === value;

const isSize = (value: SqlValue): value is number => Number.isInteger(value) && Number(value) >= 0;

/** The side table of full tool results: one row per spilled call, keyed by the stable ref. */
export class ResultStore {
	private readonly db: DatabaseSync;

	constructor(dir: string) {
		mkdirSync(dir, { recursive: true });
		this.db = new DatabaseSync(join(dir, "results.sqlite"));
		this.db.exec("CREATE TABLE IF NOT EXISTS results (ref TEXT PRIMARY KEY, text TEXT NOT NULL, size INTEGER NOT NULL)");
	}

	/** Write the full value once per ref: a crash rerun of the same call finds the row and adds nothing. */
	put(ref: string, text: string): void {
		this.db.prepare("INSERT OR IGNORE INTO results (ref, text, size) VALUES (?, ?, ?)").run(ref, text, utf8Bytes(text));
	}

	get(ref: string): StoredResult | undefined {
		const row = this.db.prepare("SELECT text, size FROM results WHERE ref = ?").get(ref);

		if (row === undefined) return undefined;

		if (!isText(row.text) || !isSize(row.size)) throw new Error("results.sqlite is malformed");

		return { text: row.text, size: row.size };
	}

	/** How many results are stored, for tests and diagnostics. */
	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM results").get();

		return row !== undefined && isSize(row.n) ? row.n : 0;
	}

	close(): void {
		this.db.close();
	}
}

/** Stable for one call: a crash rerun of the same task writes the same ref. */
export function spillRef(taskId: string, callId: string): string {
	return `r:${createHash("sha256").update(taskId).update("\0").update(callId).digest("hex").slice(0, 12)}`;
}

/** The value of `text` when it parses as JSON; `undefined` when it does not. JSON never parses to `undefined`. */
const parseStored = (text: string): JsonValue | undefined => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

type ArrayField = { property?: string; items: JsonValue[] };

/** An array, or the first array-valued property of an object, whichever the stored value starts with. */
function arrayField(value: JsonValue): ArrayField | undefined {
	if (Array.isArray(value)) return { items: value };

	if (isObject(value)) {
		for (const [property, candidate] of Object.entries(value)) {
			if (Array.isArray(candidate)) return { property, items: candidate };
		}
	}

	return undefined;
}

type PointerFields = { preview: string; "shape"?: string; itemCount?: number; property?: string };

/**
 * A by-structure preview for a stored JSON array, or object with an array-valued property: the first `PREVIEW_ITEMS`
 * items as JSON, plus the description and item count. Anything else keeps the leading-characters preview.
 */
function pointerFields(text: string, previewChars: number): PointerFields {
	const parsed = parseStored(text);
	const field = parsed === undefined ? undefined : arrayField(parsed);

	if (field === undefined) return { preview: `${text.slice(0, previewChars)}…` };

	const items = JSON.stringify(field.items.slice(0, PREVIEW_ITEMS)) ?? "[]";
	const preview = items.length > previewChars ? `${items.slice(0, previewChars)}…` : items;
	const described = field.property === undefined ? "array" : `object with array '${field.property}'`;

	return { preview, "shape": `${described} of ${field.items.length} items`, itemCount: field.items.length, property: field.property };
}

const pointerText = (ref: string, text: string, size: number, previewChars: number): string => JSON.stringify({ spilled: ref, size, ...pointerFields(text, previewChars), note: NOTE });

type SpillContent = NonNullable<ToolExecutionResult["content"]>;

const textOf = (content: SpillContent | undefined): string => {
	const parts: string[] = [];

	for (const part of content ?? []) if (part.type === "text") parts.push(part.text);

	return parts.join("");
};

/** The pointer replaces every text part; a non-text part (an image, say) stays where it was. */
const withPointer = (content: SpillContent | undefined, pointer: string): SpillContent => [
	{ type: "text", text: pointer },
	...(content ?? []).filter((part) => part.type !== "text"),
];

/**
 * The `afterTool` decision: a result whose text is over `spillBytes` becomes one pointer text part, its full value
 * stored under a ref derived from the task and call. `undefined` leaves the result alone.
 */
export function spillResult(store: ResultStore, policy: SpillPolicy, taskId: string, call: ToolCall, result: ToolExecutionResult): ToolExecutionResult | undefined {
	if (policy.spillBytes === 0 || NEVER_SPILLED_TOOLS.has(call.name)) return undefined;
	const text = textOf(result.content);
	const size = utf8Bytes(text);

	if (size <= policy.spillBytes) return undefined;
	const ref = spillRef(taskId, call.id);

	store.put(ref, text);

	return { ...result, content: withPointer(result.content, pointerText(ref, text, size, policy.previewChars)) };
}

export type ReadArgs = { ref: string; offset?: number; length?: number };

export type GrepArgs = { ref: string; pattern: string; max?: number };

export type QueryArgs = { ref: string; expr: string };

export type ReadSlice = { ref: string; offset: number; length: number; size: number; text: string; more: boolean };

export type GrepMatch = { offset: number; text: string };

export type GrepFound = { matches: GrepMatch[]; total: number };

/**
 * A bounded window into a stored value: `offset` and `length` are clamped to the text, and `length` never exceeds
 * MAX_READ. Reading past the end is an empty window, not an error.
 */
export function readSlice(ref: string, stored: StoredResult, offset: number, length: number): ReadSlice {
	const at = Math.max(0, Math.floor(offset));
	const take = Math.min(Math.max(0, Math.floor(length)), MAX_READ);
	const text = stored.text.slice(at, at + take);

	return { ref, offset: at, length: take, size: stored.size, text, more: at + take < stored.text.length };
}

/**
 * Every place `pattern` occurs (case-insensitive, plain substring), as up to `max` windows of GREP_WINDOW characters
 * before and after the occurrence, clipped to the value and merged where they overlap, plus how many occurrences there
 * are in all. `offset` is where the window starts in the value.
 */
export function grepMatches(pattern: string, stored: StoredResult, max: number): GrepFound {
	const needle = pattern.toLowerCase();
	const text = stored.text;
	const haystack = text.toLowerCase();
	const positions: number[] = [];

	// An empty needle never advances `indexOf`, so it matches nothing rather than looping.
	if (needle.length > 0) {
		let at = haystack.indexOf(needle);

		while (at !== -1) {
			positions.push(at);
			at = haystack.indexOf(needle, at + 1);
		}
	}

	const matches: GrepMatch[] = [];

	for (const position of positions) {
		const start = Math.max(0, position - GREP_WINDOW);
		const end = Math.min(text.length, position + needle.length + GREP_WINDOW);
		const last = matches.at(-1);

		if (last === undefined || start > last.offset + last.text.length) matches.push({ offset: start, text: text.slice(start, end) });
		else matches[matches.length - 1] = { offset: last.offset, text: text.slice(last.offset, Math.max(last.offset + last.text.length, end)) };
	}

	return { matches: matches.slice(0, max), total: positions.length };
}

/** `result_read`'s body: JSON with the window and `more`. An unknown ref is an error that names it. */
export function readResult(store: ResultStore, args: ReadArgs): string {
	const stored = store.get(args.ref);

	if (stored === undefined) throw new Error(`no spilled result with ref ${args.ref}`);

	return JSON.stringify(readSlice(args.ref, stored, args.offset ?? 0, args.length ?? DEFAULT_READ));
}

/** `result_grep`'s body: JSON with the matching windows and the total. An unknown ref is an error that names it. */
export function grepResult(store: ResultStore, args: GrepArgs): string {
	const stored = store.get(args.ref);

	if (stored === undefined) throw new Error(`no spilled result with ref ${args.ref}`);
	const max = Math.min(Math.max(0, Math.floor(args.max ?? DEFAULT_GREP)), MAX_GREP);
	const found = grepMatches(args.pattern, stored, max);

	return JSON.stringify({ ref: args.ref, pattern: args.pattern, matches: found.matches, total: found.total });
}

/** The stored value as a JavaScript literal: the raw JSON when it parses (U+2028/9 escaped), else a string literal. */
function queryLiteral(text: string): string {
	if (parseStored(text) === undefined) return JSON.stringify(text);

	return text.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * The query runs in the sandbox with the same two forms a property rule accepts: an expression (`r.length`), or a
 * function body when that does not parse (`return r.length;`). `kv` is a frozen read-only copy, so a query cannot write.
 */
function queryProgram(literal: string, expr: string): string {
	return `const r = ${literal};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const expr = ${JSON.stringify(expr)};
const readOnly = Object.freeze({ get: kv.get, keys: kv.keys });
let query;
try { query = new AsyncFunction("r", "kv", "return (" + expr + "\\n);"); } catch (error) { query = new AsyncFunction("r", "kv", expr); }
return await query(r, readOnly);`;
}

let queryCount = 0;

/**
 * `result_query`'s body: run `expr` over the stored value in the sandbox, on a throwaway empty state file, and return
 * the JSON answer (cut at MAX_ANSWER). A syntax error, a throw or a timeout comes back as a `query failed:` error.
 */
export async function queryResult(runtime: CellRuntime, store: ResultStore, args: QueryArgs): Promise<string> {
	const stored = store.get(args.ref);

	if (stored === undefined) throw new Error(`no spilled result with ref ${args.ref}`);
	const scratch = runtime.statePath(`.query-${process.pid}-${queryCount++}`);

	try {
		const value = await runtime.run(queryProgram(queryLiteral(stored.text), args.expr), {}, scratch);
		const answer = JSON.stringify(value) ?? "null";

		return answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}…[cut: answer is ${answer.length} chars; narrow the expression]` : answer;
	} catch (error) {
		throw new Error(`query failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		rmSync(scratch, { force: true });
	}
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export type SpillExtension = Extension<ToolRegistration> & { close(): void };

/** The spill extension: the `afterTool` hook, and the three read-only tools that open a spilled ref. */
export function spillExtension(dataDir: string, runtime: CellRuntime, policy: SpillPolicy = DEFAULT_SPILL_POLICY): SpillExtension {
	const store = new ResultStore(dataDir);

	const read = defineTool({
		name: READ_TOOL,
		description: "Read a slice of a spilled tool result by ref; offset defaults to 0 and length to 4000 (max 8000 characters).",
		parameters: Type.Object({ ref: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 0 })) }),
		replay: "safe",
		execute: async (args) => text(readResult(store, args)),
	});

	const grep = defineTool({
		name: GREP_TOOL,
		description: "Find places a spilled tool result contains a substring (case-insensitive), anywhere in the value; each match returns its offset and a window of 120 characters before and after it, merged where they overlap. max defaults to 20 (max 100).",
		parameters: Type.Object({ ref: Type.String(), pattern: Type.String(), max: Type.Optional(Type.Integer({ minimum: 0 })) }),
		replay: "safe",
		execute: async (args) => text(grepResult(store, args)),
	});

	const query = defineTool({
		name: QUERY_TOOL,
		description:
			"Answer a question about a spilled tool result without reading it back: evaluate a JavaScript expression over the stored value and return only the answer. `r` is the stored value parsed as JSON when it parses, otherwise the raw string. Examples: r.roster.filter(p => p.job === \"blacksmith\"), r.roster.find(p => p.number === 150), r.length. A function body (with `return`) works too. Answers over 8000 characters are cut.",
		parameters: Type.Object({ ref: Type.String(), expr: Type.String() }),
		replay: "safe",
		execute: async (args) => text(await queryResult(runtime, store, args)),
	});

	const extension = defineExtension({
		name: "spill",
		tools: [read, grep, query],
		hooks: [hook(ToolTask, { afterTool: (call, result, api) => spillResult(store, policy, String(api.taskId), call, result) })],
	});

	return { ...extension, close: () => store.close() };
}
