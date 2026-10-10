// UniiChat memory, after Victor Taelin's spec (gist 91837951a5ce5b38f341ec1ba1df6449, revised 2026-10-07): one chat that
// never ends. An append-only log (section 1), a purely binary tree of one-line summaries over it (section 2), a "view"
// that tiles the whole log and changes only at its end between batches (section 3), and an async compactor that builds
// the tree from queues (section 4).
//
//   main/YYYY-MM-DD.jsonl   messages {i, kind, text, size, date}      tree/YYYY-MM-DD.jsonl   nodes {l, i, text, size}
//   view.json               the view as [l, i] pairs, saved on every change and never rebuilt from the log
//
// Which lines merge: the most due pair, due = (T - last) / 2^l, ties to the oldest, only pairs whose parent is built
// (`mostDue`; with a line budget it reproduces Taelin's rollback push exactly, see test/optchat.test.ts).
// When: a sawtooth. A message only appends its line; once the view passes `high` bytes one batch merges down to `low`.
//
// The summarizer is async and pluggable (compaction.ts). The default is deterministic, so everything runs offline.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { bytes, type Compress, compressTask, type Line, type Merge, mergeTask, NODE, type Summarizer, truncatingSummarizer } from "./compaction.ts";

export const KINDS = ["user", "agent", "tool", "echo", "work", "note"] as const;

export type Kind = (typeof KINDS)[number];

export type Message = { i: number; kind: Kind; text: string; size: number; date: string };

export type Node = { l: number; i: number; text: string; size: number };

/** A line of the view: node(l, i), which covers the 2^l messages from i * 2^l on. */
export type Part = { l: number; i: number };

/** A tool's output is clipped to this many characters (head and tail), any other long text is split into chunks of it. */
export const CLIP = 30_000;

export const CHUNK = 30_000;

/** The compactor runs at most this many calls at once (spec section 4, "The order"). */
export const MAX_CALLS = 8;

export const PLACEHOLDER = "(not summarized yet: zoom it)";

const DEFAULTS = { low: 64_000, high: 128_000, compactionLow: 16_000, compactionHigh: 32_000 };

// --- the merge order (spec section 3), pure ---

/** Where a pair's age is measured from. `last` is the spec's rule; `first` is the bug it warns about (section 3.2). */
export type Age = "last" | "first";

export type Built = (l: number, i: number) => boolean;

export type Cost = (part: Part) => number;

/**
 * The index k of the most due mergeable pair (view[k], view[k+1]), or -1. Two lines are a pair when they are siblings in
 * the tree and their parent is built. due = (T - edge) / 2^l, a division by a power of two, so exact; the oldest pair wins
 * a tie. `T` is the number of messages in the chat.
 */
export function mostDue(view: readonly Part[], T: number, built: Built, age: Age = "last"): number {
	let best = -1;
	let bestDue = -Infinity;

	for (let k = 0; k + 1 < view.length; k++) {
		const a = view[k];
		const b = view[k + 1];

		if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !built(a.l + 1, a.i / 2)) continue;
		const edge = age === "last" ? (a.i + 2) * 2 ** a.l - 1 : a.i * 2 ** a.l;
		const due = (T - edge) / 2 ** a.l;

		if (due > bestDue) {
			bestDue = due;
			best = k;
		}
	}

	return best;
}

/**
 * Merge the most due pair, again and again, until the view costs at most `limit` or no pair can merge. `cost` is the bytes
 * of a line for a byte budget, or `() => 1` for a line-count budget. Mutates the view and returns its final cost.
 */
export function mergeDown(view: Part[], T: number, limit: number, cost: Cost, built: Built, age: Age = "last"): number {
	let size = 0;

	for (const part of view) size += cost(part);

	while (size > limit) {
		const k = mostDue(view, T, built, age);

		if (k < 0) break;
		const a = view[k];
		const parent = { l: a.l + 1, i: a.i / 2 };
		size += cost(parent) - cost(a) - cost(view[k + 1]);
		view.splice(k, 2, parent);
	}

	return size;
}

// --- long text (spec section 1) ---

/** The surrogate-pair-safe end of a cut at `end`. */
const safeEnd = (text: string, end: number): number => (end > 0 && end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff ? end - 1 : end);

/** A tool's output keeps its head and its tail, CLIP characters in all, and says what was cut. */
export function clipTool(text: string): string {
	if (text.length <= CLIP) return text;
	const half = CLIP / 2;
	const headEnd = safeEnd(text, half);
	const tailStart = safeEnd(text, text.length - half);
	const dropped = tailStart - headEnd;

	return `${text.slice(0, headEnd)}\n[... ${dropped} of ${text.length} characters cut here ...]\n${text.slice(tailStart)}`;
}

/** Any other long text is never cut: it becomes several messages in a row, CHUNK characters each at most. */
export function splitLong(text: string): string[] {
	const out: string[] = [];

	for (let at = 0; at < text.length || out.length === 0; ) {
		const end = at + CHUNK >= text.length ? text.length : safeEnd(text, at + CHUNK);
		out.push(text.slice(at, end));
		at = end;
	}

	return out;
}

// --- parsing the files (boundary data) ---

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type JsonRecord = { [key: string]: Json };

export const parseJson = (text: string): Json => JSON.parse(text);

export const isRecord = (value: Json | undefined): value is JsonRecord => value !== undefined && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";

export const isString = (value: Json | undefined): value is string => String(value) === value;

export const isCount = (value: Json | undefined): value is number => Number.isInteger(value) && Number(value) >= 0;

const isKind = (value: Json | undefined): value is Kind => KINDS.some((kind) => kind === value);

/** A message record. The pre-day-file format has no `size` and calls the agent `talk`; both are read as the new ones. */
function parseMessage(line: string): Message {
	const raw = parseJson(line);

	if (!isRecord(raw)) throw new Error("not a record");
	const kind = raw.kind === "talk" ? "agent" : raw.kind;

	if (!isCount(raw.i) || !isKind(kind) || !isString(raw.text) || !isString(raw.date)) throw new Error("not a message");

	if (raw.size !== undefined && raw.size !== bytes(raw.text)) throw new Error("size does not match the text");

	return { i: raw.i, kind, text: raw.text, size: bytes(raw.text), date: raw.date };
}

function parseNode(line: string): Node {
	const raw = parseJson(line);

	if (!isRecord(raw)) throw new Error("not a record");

	if (!isCount(raw.l) || !isCount(raw.i) || !isString(raw.text)) throw new Error("not a node");

	if (raw.size !== undefined && raw.size !== bytes(raw.text)) throw new Error("size does not match the text");

	return { l: raw.l, i: raw.i, text: raw.text, size: bytes(raw.text) };
}

function parseView(text: string): Part[] {
	const raw = parseJson(text);

	if (!Array.isArray(raw)) throw new Error("not a list");
	const out: Part[] = [];
	let next = 0;

	for (const pair of raw) {
		if (!Array.isArray(pair) || pair.length !== 2 || !isCount(pair[0]) || !isCount(pair[1])) throw new Error("not an [l, i] pair");

		if (pair[1] * 2 ** pair[0] !== next) throw new Error(`line [${pair[0]}, ${pair[1]}] does not follow message ${next}`);
		out.push({ l: pair[0], i: pair[1] });
		next += 2 ** pair[0];
	}

	return out;
}

// --- files ---

const DAY = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

type Warn = (message: string) => void;

function appendLine(path: string, value: Message | Node, durable: boolean): void {
	const fd = openSync(path, "a");

	try {
		writeSync(fd, `${JSON.stringify(value)}\n`);

		if (durable) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");

	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Write a file whole or not at all: a temp file, fsync, rename, then fsync the directory. */
function replaceFile(dir: string, name: string, text: string, durable: boolean): void {
	const temp = join(dir, `${name}.tmp`);
	const fd = openSync(temp, "w");

	try {
		writeSync(fd, text);

		if (durable) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}

	renameSync(temp, join(dir, name));

	if (durable) syncDirectory(dir);
}

/** Records of one file, a line that does not parse (a torn write, or damage) skipped with a warning. */
function readRecords<T>(path: string, parse: (line: string) => T, warn: Warn): T[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8");

	if (raw.length > 0 && !raw.endsWith("\n")) appendFileSync(path, "\n"); // a torn last line gets its own line end
	const out: T[] = [];

	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;

		try {
			out.push(parse(line));
		} catch {
			warn(`optchat: skipping a torn or malformed line in ${path}`);
		}
	}

	return out;
}

/** Every record of a log: the old single file first, then the day files in date order. */
function readLog<T>(dir: string, name: string, parse: (line: string) => T, warn: Warn): T[] {
	const out = readRecords(join(dir, `${name}.jsonl`), parse, warn);

	if (existsSync(join(dir, name))) {
		for (const file of readdirSync(join(dir, name)).sort()) {
			if (DAY.test(file)) out.push(...readRecords(join(dir, name, file), parse, warn));
		}
	}

	return out;
}

class Queue<T> {
	private items: T[] = [];
	private head = 0;

	get length(): number {
		return this.items.length - this.head;
	}

	push(item: T): void {
		this.items.push(item);
	}

	shift(): T | undefined {
		if (this.head === this.items.length) return undefined;
		const item = this.items[this.head++];

		if (this.head > 1024 && this.head * 2 > this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}

		return item;
	}
}

type Job = { l: number; i: number; counted: boolean };

type Waiter = { target: number; resolve: (settled: boolean) => void };

export type MemoryOptions = {
	low?: number; // the view merges down to this many bytes ...
	high?: number; // ... once it passes this many
	compactionLow?: number; // the same two for a compaction's own view
	compactionHigh?: number;
	age?: Age; // `first` is the old, wrong rule, kept for the benchmark's comparison
	summarizer?: Summarizer;
	fsync?: boolean;
	now?: () => Date;
	warn?: Warn;
};

/** `lastBatch` is the view's bytes when the latest batch began and where it stands now. */
export type Stats = { batches: number; merges: number; calls: number; failures: number; lastBatch: { from: number; to: number } };

const digits = (x: number): number => {
	let count = 1;

	for (let v = x; v >= 10; v = Math.trunc(v / 10)) count++;

	return count;
};

export class Memory {
	readonly dir: string;
	readonly low: number;
	readonly high: number;
	readonly compactionLow: number;
	readonly compactionHigh: number;
	readonly age: Age;
	readonly summarizer: Summarizer;
	readonly fsync: boolean;
	readonly root: Message[] = [];
	readonly stats: Stats = { batches: 0, merges: 0, calls: 0, failures: 0, lastBatch: { from: 0, to: 0 } };
	view: Part[] = [];
	private compactionParts: Part[] = [];
	private readonly tree: (Node | undefined)[][] = [];
	private readonly now: () => Date;
	private readonly warn: Warn;
	private draining = false;
	private merged = false; // the last extend merged lines
	// the compactor: queues of ready work, never a scan of the tree
	private readonly pending = new Queue<number>(); // messages not started, in id order
	private readonly ready = new Queue<Job>(); // merges whose halves are both built
	private readonly retry = new Queue<Job>();
	private failed: Job[] = [];
	private running = 0;
	private lagging = 0; // messages started (running or failed) and not built yet
	private builtPrefix = 0; // every message before this id has its node
	private waiters: Waiter[] = [];
	private idlers: (() => void)[] = [];

	constructor(dir: string, options: MemoryOptions = {}) {
		this.dir = dir;
		this.low = options.low ?? DEFAULTS.low;
		this.high = options.high ?? DEFAULTS.high;
		this.compactionLow = options.compactionLow ?? DEFAULTS.compactionLow;
		this.compactionHigh = options.compactionHigh ?? DEFAULTS.compactionHigh;
		this.age = options.age ?? "last";
		this.summarizer = options.summarizer ?? truncatingSummarizer;
		this.fsync = options.fsync ?? true;
		this.now = options.now ?? (() => new Date());
		this.warn = options.warn ?? ((message) => console.warn(message));

		if (this.low > this.high || this.compactionLow > this.compactionHigh) throw new Error("a low mark above its high mark");
		mkdirSync(join(dir, "main"), { recursive: true });
		mkdirSync(join(dir, "tree"), { recursive: true });
		this.load();
		this.pump();
	}

	get length(): number {
		return this.root.length;
	}

	node(l: number, i: number): Node | undefined {
		return this.tree[l]?.[i];
	}

	private readonly built: Built = (l, i) => this.tree[l]?.[i] !== undefined;

	private load(): void {
		for (const message of readLog(this.dir, "main", parseMessage, this.warn)) {
			if (message.i === this.root.length) this.root.push(message);
			else this.warn(`optchat: message ${message.i} is out of order (expected ${this.root.length}), skipped`);
		}

		for (const node of readLog(this.dir, "tree", parseNode, this.warn)) {
			if (node.l < 53 && (node.i + 1) * 2 ** node.l <= this.root.length && !this.built(node.l, node.i)) this.place(node, false);
		}

		const path = join(this.dir, "view.json");

		if (existsSync(path)) {
			this.view = parseView(readFileSync(path, "utf8")); // a bad file is an error: never silently rebuild the view

			if (this.covered() > this.root.length) throw new Error("view.json is ahead of the log");
		} else {
			// MIGRATION ONLY: a chat written before the view was saved has no view.json. Fold it once, here, and save it.
			// This is the one place the view is rebuilt from the log; from the next start on it is loaded.
			this.view = [];
		}

		// A crash between a log write and the view save leaves lines missing at the end: append them, as a message does.
		const stale = !existsSync(path) || this.covered() < this.root.length;

		for (let m = this.covered(); m < this.root.length; m++) this.extend(m);

		if (stale && this.root.length > 0) this.saveView();

		this.merged = false;
		this.draining = this.viewBytes() > this.high;
		this.compactionParts = this.fitCompaction([...this.view], this.root.length);

		// Nodes missing after a crash: one pass over the messages and one over the levels, queueing what is ready.
		for (let m = 0; m < this.root.length; m++) {
			if (!this.built(0, m)) this.pending.push(m);
		}

		for (let l = 0; l < this.tree.length; l++) {
			const level = this.tree[l];

			if (level === undefined) continue; // a lost level: nothing above it can be queued from here

			for (let i = 0; i + 1 < level.length; i += 2) {
				if (level[i] !== undefined && level[i + 1] !== undefined && !this.built(l + 1, i / 2)) this.ready.push({ l: l + 1, i: i / 2, counted: false });
			}
		}
	}

	/** How many messages the view covers. */
	private covered(): number {
		const last = this.view[this.view.length - 1];

		return last === undefined ? 0 : (last.i + 1) * 2 ** last.l;
	}

	// --- the log ---

	/**
	 * Append a message and return its id(s). A tool's output (`echo`) is clipped to its head and tail; any other long text
	 * is split over consecutive messages, so more than one id comes back. Each is fsynced before the next step.
	 */
	log(kind: Kind, text: string): number[] {
		return (kind === "echo" ? [clipTool(text)] : splitLong(text)).map((piece) => this.append(kind, piece));
	}

	private append(kind: Kind, text: string): number {
		const date = this.now().toISOString();
		const message: Message = { i: this.root.length, kind, text, size: bytes(text), date };
		appendLine(join(this.dir, "main", `${date.slice(0, 10)}.jsonl`), message, this.fsync);
		this.root.push(message);
		this.pending.push(message.i);
		const T = this.root.length;
		this.extend(message.i);
		const merged = this.merged;
		this.merged = false;

		if (merged) {
			this.compactionParts = this.fitCompaction([...this.view], T);
		} else {
			this.compactionParts.push({ l: 0, i: message.i });
			this.fitCompaction(this.compactionParts, T, this.compactionHigh);
		}

		this.saveView();
		this.retryFailed();
		this.pump();

		return message.i;
	}

	// --- the view (spec section 3.2) ---

	/** A line's bytes as it renders: `id+n|text` and its line end. */
	readonly cost: Cost = (part) => digits(part.i * 2 ** part.l) + 1 + digits(2 ** part.l) + 1 + (this.tree[part.l]?.[part.i]?.size ?? bytes(PLACEHOLDER)) + 1;

	private sizeOf(parts: readonly Part[]): number {
		let size = 0;

		for (const part of parts) size += this.cost(part);

		return size;
	}

	viewBytes(): number {
		return this.sizeOf(this.view);
	}

	/** Append message m's line; if the view passed `high` (or a batch is unfinished), merge the most due pairs down to `low`. */
	private extend(m: number): void {
		this.view.push({ l: 0, i: m });

		const start = this.viewBytes();

		if (!this.draining && start <= this.high) return;

		if (!this.draining) {
			this.draining = true;
			this.stats.batches++;
			this.stats.lastBatch.from = start;
		}

		const before = this.view.length;
		const size = mergeDown(this.view, m + 1, this.low, this.cost, this.built, this.age);

		this.stats.lastBatch.to = size;

		if (size <= this.low) this.draining = false; // otherwise unbuilt parents block it: it goes on at the next message
		this.stats.merges += before - this.view.length;
		this.merged ||= this.view.length !== before;
	}

	/** A compaction's view: merged down to `compactionLow` once `compactionHigh` is passed (or just rebuilt from the chat's view). */
	private fitCompaction(parts: Part[], T: number, trigger: number = 0): Part[] {
		if (this.sizeOf(parts) > trigger) mergeDown(parts, T, this.compactionLow, this.cost, this.built, this.age);

		return parts;
	}

	private saveView(): void {
		replaceFile(this.dir, "view.json", JSON.stringify(this.view.map((part) => [part.l, part.i])), this.fsync);
	}

	/** Lines of `parts` wholly before message `end`; a line that straddles it is opened into its halves. */
	private before(parts: readonly Part[], end: number, builtOnly: boolean): Part[] {
		const out: Part[] = [];

		const walk = (part: Part): boolean => {
			const start = part.i * 2 ** part.l;

			if (start >= end) return false;
			const there = this.built(part.l, part.i);

			if (start + 2 ** part.l <= end) {
				if (!there && builtOnly) return false;
				out.push(part);

				return true;
			}

			return there && walk({ l: part.l - 1, i: 2 * part.i }) && walk({ l: part.l - 1, i: 2 * part.i + 1 });
		};

		for (const part of parts) {
			if (!walk(part)) break;
		}

		return out;
	}

	private text(part: Part): string {
		return (this.tree[part.l]?.[part.i]?.text ?? PLACEHOLDER).replace(/\n/g, " ");
	}

	private show(parts: readonly Part[]): string {
		return `<chat>\n${parts.map((part) => `${part.i * 2 ** part.l}+${2 ** part.l}|${this.text(part)}`).join("\n")}\n</chat>`;
	}

	/** The view as the model sees it, covering messages before `upTo` (default: all). */
	render(upTo: number = this.root.length): string {
		return this.show(this.before(this.view, upTo, false));
	}

	/** A compaction's view (spec section 4): the chat's view merged further, up to message `end` and only built lines. */
	compactionView(end: number): string {
		return this.show(this.before(this.compactionParts, end, true));
	}

	get compactionBytes(): number {
		return this.sizeOf(this.compactionParts);
	}

	// --- the compactor (spec section 4) ---

	/** Store a built node: queue its parent if its sibling is built too. `durable` false only while loading. */
	private place(node: Node, durable: boolean): void {
		if (durable) appendLine(join(this.dir, "tree", `${this.now().toISOString().slice(0, 10)}.jsonl`), node, this.fsync);
		(this.tree[node.l] ??= [])[node.i] = node;

		if (node.l === 0) {
			while (this.tree[0][this.builtPrefix] !== undefined) this.builtPrefix++;
		}

		if (durable && this.built(node.l, node.i ^ 1) && !this.built(node.l + 1, node.i >> 1)) this.ready.push({ l: node.l + 1, i: node.i >> 1, counted: false });
	}

	private retryFailed(): void {
		for (const job of this.failed) this.retry.push(job);
		this.failed = [];
	}

	/** Start work while a slot is free: a retry first, then the next message once fewer than 8 earlier ones are unbuilt, then a merge. */
	private pump(): void {
		while (this.running < MAX_CALLS) {
			let job = this.retry.shift();

			if (job === undefined && this.lagging < MAX_CALLS) {
				const m = this.pending.shift();

				if (m !== undefined) job = { l: 0, i: m, counted: false };
			}

			job ??= this.ready.shift();

			if (job === undefined) break;
			this.start(job);
		}

		this.wake();
	}

	/** The text a node is when its sources fit in one node: no model call. */
	private free(job: Job): string | undefined {
		if (job.l === 0) {
			const m = this.root[job.i];

			return m.size + m.kind.length + 2 <= NODE ? `${m.kind}: ${m.text}` : undefined;
		}

		const joined = `${this.node(job.l - 1, 2 * job.i)?.text}\n${this.node(job.l - 1, 2 * job.i + 1)?.text}`;

		return bytes(joined) <= NODE ? joined : undefined;
	}

	private start(job: Job): void {
		const free = this.free(job);

		if (free !== undefined) {
			this.place({ l: job.l, i: job.i, text: free, size: bytes(free) }, true);

			return;
		}

		this.running++;
		this.stats.calls++;

		if (job.l === 0 && !job.counted) {
			job.counted = true;
			this.lagging++;
		}

		this.summarize(job).then(
			(text) => {
				this.running--;

				if (job.l === 0) this.lagging--;
				this.place({ l: job.l, i: job.i, text, size: bytes(text) }, true);
				this.pump();
			},
			() => {
				this.running--;
				this.stats.failures++;
				this.failed.push(job);
				this.pump();
			},
		);
	}

	private async summarize(job: Job): Promise<string> {
		const text = job.l === 0 ? await this.summarizer.compress(this.compression(job.i)) : await this.summarizer.merge(this.merging(job.l, job.i));

		if (text.trim() === "") throw new Error("empty summary");

		return text;
	}

	private compression(i: number): Compress {
		const message = this.root[i];

		return { id: i, message, task: compressTask(message), view: () => this.compactionView(i) };
	}

	private merging(l: number, i: number): Merge {
		const width = 2 ** (l - 1);
		const a: Line = { id: 2 * i * width, n: width, text: this.node(l - 1, 2 * i)?.text ?? "" };
		const b: Line = { id: (2 * i + 1) * width, n: width, text: this.node(l - 1, 2 * i + 1)?.text ?? "" };
		const end = (i + 1) * 2 ** l - 1;

		return { id: a.id, end, a, b, task: mergeTask(a, b, a.id, end), view: () => this.compactionView(end + 1) };
	}

	private wake(): void {
		const waiting = this.waiters;
		this.waiters = [];

		for (const waiter of waiting) {
			if (this.builtPrefix >= waiter.target) waiter.resolve(true);
			else if (this.running === 0) waiter.resolve(false); // nothing runs and the pump found nothing to start: failures block it
			else this.waiters.push(waiter);
		}

		if (this.running === 0) {
			const idle = this.idlers;
			this.idlers = [];

			for (const resolve of idle) resolve();
		}
	}

	/**
	 * Resolves once every message before `upTo` has its node (a turn waits on it, spec section 6). Failed calls are tried
	 * again first. Resolves false instead of hanging if nothing is left running and a failure still blocks it: the view
	 * then shows "(not summarized yet: zoom it)" for those lines.
	 */
	settle(upTo: number): Promise<boolean> {
		const target = Math.min(upTo, this.root.length);

		if (this.builtPrefix >= target) return Promise.resolve(true);
		this.retryFailed();

		return new Promise((resolve) => {
			this.waiters.push({ target, resolve });
			this.pump();
		});
	}

	/** Resolves when no call is running and nothing is startable (failed calls wait for the next message). */
	idle(): Promise<void> {
		return new Promise((resolve) => {
			this.idlers.push(resolve);
			this.pump();
		});
	}

	// --- tools ---

	/** Open line id+n into the two lines it was made from; n = 1 gives the message whole. */
	zoom(id: number, n: number): string {
		const power = Number.isInteger(n) && n >= 1 && Number.isInteger(Math.log2(n));

		if (!power || !Number.isInteger(id) || id < 0 || id % n !== 0 || id + n > this.root.length) return `No line ${id}+${n}.`;

		if (n === 1) return `${id}+1|${this.root[id].kind}: ${this.root[id].text}`;
		const half = n / 2;
		const l = Math.log2(half);

		return [id, id + half].map((start) => `${start}+${half}|${this.text({ l, i: start / half })}`).join("\n");
	}

	/** The date and time of message id. */
	date(id: number): string {
		return this.root[id]?.date ?? `No message ${id}.`;
	}
}
