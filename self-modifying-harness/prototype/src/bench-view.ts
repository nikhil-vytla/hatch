// How cacheable is the OptChat view? Replays one seeded synthetic chat through three policies and measures what a model
// call must pay to write after the previous call, in the terms of the spec (section 3.3):
//
//   sawtooth       the new policy: a message only appends its line; past HIGH (128,000 bytes) one batch merges the most
//                  due pairs (due measured from a pair's last message) down to LOW (64,000)
//   old policy     round 1: merge at every message to stay under one budget, pairs aged from their first message
//   sliding window the usual baseline: the most recent whole messages that fit the same budget
//
// "Line-inputs per message": the lines the next call must write: everything after its first changed line, plus new lines.
// Cache: the view goes in blocks of 4 lines; one mark sits on the last whole block of a call; the next call reads the
// longest marked prefix of the previous call that is still identical. This models the marking scheme only (the shape of
// Anthropic's cache), it does not call any API.
//
// Two kinds of call are measured. `perMessage` is the spec's simulation: a call after every message, the view as it
// stands. `perTurn` is the agent: one call per user message, rendered before the message is logged. The two budgets of
// the old policy and the window are the sawtooth's average (96,000 bytes) so all three hold about the same text.
//
//   node --experimental-strip-types --no-warnings src/bench-view.ts [messages]    (writes results/bench-view-v2-<n>.json)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Age, type Kind, Memory, type MemoryOptions, mergeDown, type Part } from "./optchat.ts";

const N = Number(process.argv[2] ?? 20_000);

const LOW = 64_000;

const HIGH = 128_000;

const AVERAGE = (LOW + HIGH) / 2;

const WARMUP = 500;

const BLOCK = 4;

// Seeded generator (mulberry32) so runs are repeatable; every policy gets the same stream.
function stream(seed: number): () => [Kind, string] {
	let state = seed;

	const rand = () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	const words = "cell migrate check facet version rollback zoom view tree harness commit sqlite durable replay kernel gate".split(" ");
	const text = (n: number) => Array.from({ length: Math.max(1, Math.round(n / 7)) }, () => words[Math.floor(rand() * words.length)]).join(" ");

	// A turn: one user message, 0-6 tool round trips, one reply. Sizes roughly like a coding agent's log.
	const queue: [Kind, string][] = [];

	return () => {
		if (queue.length === 0) {
			queue.push(["user", text(40 + rand() * 400)]);

			for (let k = Math.floor(rand() * 7); k > 0; k--) {
				queue.push(["tool", text(60 + rand() * 200)]);
				queue.push(["echo", text(rand() < 0.2 ? 4_000 + rand() * 20_000 : 100 + rand() * 1_500)]);
			}

			queue.push(["agent", text(100 + rand() * 1_200)]);
		}

		return queue.shift() ?? ["user", ""];
	};
}

/** What consecutive calls share, as the spec counts it. A line is a key (its identity) and its bytes. */
class Calls {
	calls = 0;
	paidLines = 0;
	lines = 0;
	bytes = 0;
	shared = 0;
	read = 0;
	perCallRead = 0;
	private keys: number[] = [];
	private sizes: number[] = [];

	call(keys: number[], sizes: number[], count: boolean): void {
		let k = 0;

		while (k < keys.length && k < this.keys.length && keys[k] === this.keys[k]) k++;
		const mark = BLOCK * Math.floor(this.keys.length / BLOCK); // the previous call marked its last whole block
		let total = 0;
		let sharedBytes = 0;
		let readBytes = 0;

		for (let j = 0; j < sizes.length; j++) {
			total += sizes[j];

			if (j < k) sharedBytes += sizes[j];

			if (j < mark && mark <= k) readBytes += sizes[j];
		}

		if (count) {
			this.calls++;
			this.paidLines += keys.length - k;
			this.lines += keys.length;
			this.bytes += total;
			this.shared += sharedBytes;
			this.read += readBytes;
			this.perCallRead += total === 0 ? 0 : readBytes / total;
		}

		this.keys = keys;
		this.sizes = sizes;
	}

	report(messages: number) {
		const round = (x: number, places = 3) => Math.round(x * 10 ** places) / 10 ** places;

		return {
			calls: this.calls,
			avgViewBytes: Math.round(this.bytes / this.calls),
			avgViewLines: round(this.lines / this.calls, 1),
			avgSharedPrefixBytes: Math.round(this.shared / this.calls),
			lineInputsPerCall: round(this.paidLines / this.calls),
			lineInputsPerMessage: round(this.paidLines / messages),
			cacheReadFraction: round(this.read / this.bytes, 4),
			cacheReadFractionMeanOfCalls: round(this.perCallRead / this.calls, 4),
		};
	}
}

/** The lines of one call: an identity and a size in bytes for each. */
type Snapshot = { keys: number[]; sizes: number[] };

const keyOf = (part: Part): number => part.i * 64 + part.l;

type Policy = { name: string; options: MemoryOptions };

async function memoryPolicy(policy: Policy) {
	const dir = mkdtempSync(join(tmpdir(), "optchat-bench-"));
	const memory = new Memory(dir, { fsync: false, ...policy.options });
	const next = stream(42);
	const each = new Calls();
	const turns = new Calls();
	const started = performance.now();
	let turnMessages = 0;

	while (memory.length < N) {
		const [kind, body] = next();
		const counted = memory.length >= WARMUP;

		if (kind === "user") {
			const before = memory.view; // the view as the turn renders it: before the user message is logged
			turns.call(before.map(keyOf), before.map(memory.cost), counted);
			turnMessages = counted ? turnMessages + 1 : turnMessages;
		}

		memory.log(kind, body);
		await memory.idle(); // the compactor keeps up: a deterministic summarizer is instant
		each.call(memory.view.map(keyOf), memory.view.map(memory.cost), counted);
	}

	const measured = N - WARMUP;
	const result = { perMessage: each.report(measured), perTurn: { ...turns.report(measured), turns: turns.calls }, batches: memory.stats.batches, merges: memory.stats.merges, msTotal: Math.round(performance.now() - started) };
	rmSync(dir, { recursive: true, force: true });

	return result;
}

function windowPolicy(budget: number) {
	const next = stream(42);
	const each = new Calls();
	const turns = new Calls();
	const started = performance.now();
	const sizes: number[] = [];
	let from = 0;
	let total = 0;

	const lineSize = (index: number): number => String(index).length + sizes[index] + 2;

	const snapshot = (): Snapshot => {
		const keys: number[] = [];
		const lines: number[] = [];

		for (let index = from; index < sizes.length; index++) {
			keys.push(index);
			lines.push(lineSize(index));
		}

		return { keys, sizes: lines };
	};

	for (let m = 0; m < N; m++) {
		const [kind, body] = next();
		const counted = m >= WARMUP;

		if (kind === "user") {
			const view = snapshot();
			turns.call(view.keys, view.sizes, counted);
		}

		sizes.push(`${kind}: ${body}`.length);
		total += lineSize(m);

		while (total > budget && from <= m) total -= lineSize(from++);
		const view = snapshot();
		each.call(view.keys, view.sizes, counted);
	}

	const measured = N - WARMUP;

	return { perMessage: each.report(measured), perTurn: { ...turns.report(measured), turns: turns.calls }, msTotal: Math.round(performance.now() - started) };
}

/**
 * The spec's own simulation, in lines instead of bytes (section 3.3): 30,000 messages, every line costs 1, a call after each
 * message. Fixed size merges at every message; the sawtooth merges down to `low` once past `high`. Pure, no I/O.
 */
function lineSimulation(low: number, high: number, age: Age, messages = 30_000) {
	const view: Part[] = [];
	let previous: number[] = [];
	let paid = 0;
	let draining = false;

	for (let t = 0; t < messages; t++) {
		view.push({ l: 0, i: t });

		if (view.length > high || draining) {
			draining = true;
			mergeDown(view, t + 1, low, () => 1, () => true, age);
			draining = view.length > low;
		}

		const keys = view.map(keyOf);
		let k = 0;

		while (k < keys.length && k < previous.length && keys[k] === previous[k]) k++;
		paid += keys.length - k;
		previous = keys;
	}

	return { low, high, age, messages, lineInputsPerMessage: Math.round((paid / messages) * 100) / 100 };
}

const result = {
	messages: N,
	warmupMessages: WARMUP,
	budgets: { sawtooth: { low: LOW, high: HIGH }, oldPolicyBytes: AVERAGE, slidingWindowBytes: AVERAGE },
	cacheModel: `blocks of ${BLOCK} lines, one mark on the last whole block, a call reads the longest marked prefix of the previous call still identical`,
	sawtooth: await memoryPolicy({ name: "sawtooth", options: { low: LOW, high: HIGH } }),
	oldPolicy: await memoryPolicy({ name: "old", options: { low: AVERAGE, high: AVERAGE, age: "first" } }),
	slidingWindow: windowPolicy(AVERAGE),
	lineSimulation: [lineSimulation(192, 192, "last"), lineSimulation(192, 192, "first"), lineSimulation(96, 192, "last")],
};

mkdirSync(join(import.meta.dirname, "..", "results"), { recursive: true });

writeFileSync(join(import.meta.dirname, "..", "results", `bench-view-v2-${N}.json`), `${JSON.stringify(result, null, "\t")}\n`);

console.log(JSON.stringify(result, null, 2));
