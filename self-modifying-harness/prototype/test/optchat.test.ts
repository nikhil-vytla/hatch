// OptChat memory against the revised spec: the merge order checked against Taelin's rollback push, the sawtooth, the
// saved view, the async compactor and its queues, compaction views and prompts, the 512-byte retry loop, and the log.
// Nothing here needs a model: summarizers are the deterministic default or small fakes.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { bytes, type Compress, compressTask, mergeTask, ModelSummarizer, NODE, RULER, type Summarizer, tooLong, truncatingSummarizer, type Turn } from "../src/compaction.ts";
import { CHUNK, CLIP, clipTool, type Kind, Memory, type Message, type MemoryOptions, mergeDown, mostDue, PLACEHOLDER, type Part, splitLong } from "../src/optchat.ts";
import { PROMPT_SECTIONS, SYSTEM_PROMPT } from "../src/optchat-prompt.ts";

const dirs: string[] = [];

const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "optchat-test-"));
	dirs.push(dir);

	return dir;
};

const opened: Memory[] = [];

afterEach(async () => {
	for (const memory of opened.splice(0)) await memory.idle(); // background compactions must not outlive their directory

	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quiet = () => undefined;

function open(dir: string, options: MemoryOptions = {}): Memory {
	const memory = new Memory(dir, { fsync: false, warn: quiet, ...options });
	opened.push(memory);

	return memory;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A text of exactly n bytes that is too long to be its own node when n is over 512. */
const text = (n: number, tag: string): string => `${tag} ${"x".repeat(n)}`.slice(0, n);

const names = (view: readonly Part[]): string[] => view.map((p) => `${p.i * 2 ** p.l}+${2 ** p.l}`);

const everything = () => true;

/** Log n messages one at a time, letting the compactor finish after each (a fast summarizer). */
async function fill(memory: Memory, n: number, make: (m: number) => [Kind, string]): Promise<void> {
	for (let m = 0; m < n; m++) {
		memory.log(...make(m));
		await memory.idle();
	}
}

// --- Taelin's rollback push (spec section 3.1), as written in the spec ---

type Push = { keep: 0 | 1; life: number; state: number; older: Push | null };

function push(state: number, states: Push | null): Push {
	if (states === null) return { keep: 0, life: 0, state, older: null };

	if (states.keep === 0) return { ...states, keep: 1 };

	if (states.life > 0) return { keep: 0, life: 0, state, older: { keep: 0, life: states.life - 1, state: states.state, older: states.older } };

	return { keep: 0, life: states.life, state, older: push(states.state, states.older) };
}

/** The list read as a view: each state starts a line that runs up to the next newer state, the newest to now (T). */
function linesOf(list: Push, T: number): string[] {
	const states: number[] = [];

	for (let entry: Push | null = list; entry !== null; entry = entry.older) states.push(entry.state);
	states.reverse(); // oldest first

	return states.map((s, k) => `${s}+${(states[k + 1] ?? T) - s}`);
}

describe("merge order and Taelin's push", () => {
	test("a line budget equal to push's list length reproduces push at every step for T = 0..20000", () => {
		const view: Part[] = [];
		let list: Push | null = null;

		for (let t = 0; t <= 20_000; t++) {
			list = push(t, list);
			const want = linesOf(list, t + 1);
			view.push({ l: 0, i: t });
			mergeDown(view, t + 1, want.length, () => 1, everything, "last");

			if (names(view).join(" ") !== want.join(" ")) assert.fail(`T=${t + 1}: view ${names(view).join(" ")} but push has ${want.join(" ")}`);
		}
	});

	test("measuring from the first message matches push at only a few hundred steps", (t) => {
		const view: Part[] = [];
		let list: Push | null = null;
		let matched = 0;

		for (let step = 0; step <= 20_000; step++) {
			list = push(step, list);
			const want = linesOf(list, step + 1);
			view.push({ l: 0, i: step });
			mergeDown(view, step + 1, want.length, () => 1, everything, "first");

			if (names(view).join(" ") === want.join(" ")) matched++;
		}

		t.diagnostic(`first-message rule matched push at ${matched} of 20001 steps (the spec says 481)`);
		assert.ok(matched > 0 && matched < 1_000, `matched ${matched}`);
	});

	test("the spec's example: at T=10 over 0+4 4+4 8+1 9+1 the last-message rule merges 8-9, the first-message rule 0-7", () => {
		const view: Part[] = [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }];
		assert.equal(mostDue(view, 10, everything, "last"), 2);
		assert.equal(mostDue(view, 10, everything, "first"), 0);
	});

	test("ties go to the oldest pair, and a pair whose parent is not built is skipped", () => {
		// Pair A = 0+2 and 2+2 (l=1), last message 3: due (T-3)/2. Pair B = 6+1 and 7+1 (l=0), last message 7: due T-7.
		// Both are 4 at T=11, and pair A is older.
		const view: Part[] = [{ l: 1, i: 0 }, { l: 1, i: 1 }, { l: 0, i: 6 }, { l: 0, i: 7 }];
		assert.equal(mostDue(view, 11, everything, "last"), 0, "the older pair wins a tie");
		assert.equal(mostDue(view, 11, (l, i) => !(l === 2 && i === 0), "last"), 2, "without the older pair's parent the next is taken");
		assert.equal(mostDue(view, 11, () => false, "last"), -1);
	});

	test("a byte budget merges the same pairs, stopping when the bytes fit or nothing can merge", () => {
		const view: Part[] = Array.from({ length: 16 }, (_, i) => ({ l: 0, i }));
		const size = (part: Part) => 100 * 2 ** (part.l === 0 ? 0 : 0); // every line costs 100 bytes
		const byBytes = [...view];
		const byLines = [...view];
		mergeDown(byBytes, 16, 700, size, everything);
		mergeDown(byLines, 16, 7, () => 1, everything);
		assert.deepEqual(byBytes, byLines);
		assert.equal(byBytes.length, 7);
		const stuck = [...view];
		assert.equal(mergeDown(stuck, 16, 100, size, () => false), 1_600, "no parent is built: nothing merges");
		assert.equal(stuck.length, 16);
	});
});

describe("sawtooth", () => {
	test("a message only appends; past HIGH one batch merges down to LOW; between batches the view grows only at its end", async () => {
		const memory = open(tempDir(), { low: 4_000, high: 8_000 });
		let before: Part[] = [];
		let batches = 0;

		for (let m = 0; m < 500; m++) {
			memory.log("user", text(700, `m${m}`));
			const merges = memory.stats.merges;
			assert.ok(memory.viewBytes() <= 8_000, `after message ${m} the view is ${memory.viewBytes()} bytes`);

			if (memory.stats.batches > batches) {
				batches = memory.stats.batches;
				assert.ok(memory.stats.lastBatch.from > 8_000, "a batch starts once the view passes HIGH");
				assert.ok(memory.stats.lastBatch.to <= 4_000, `a batch ends at ${memory.stats.lastBatch.to} bytes`);
			} else {
				assert.equal(merges, memory.stats.merges - 0);
				assert.deepEqual(memory.view.slice(0, before.length), before, "between batches the view only grows at its end");
				assert.equal(memory.view.length, before.length + 1);
			}

			await memory.idle();
			before = [...memory.view];
		}

		assert.ok(batches >= 5, `${batches} batches`);
		assert.ok(memory.stats.merges > 100);
	});

	test("unbuilt parents block a batch; it merges what it can at each new message until it reaches LOW", async () => {
		let down = true;

		const flaky: Summarizer = {
			compress: truncatingSummarizer.compress,
			merge: (request) => (down ? Promise.reject(new Error("merge model down")) : truncatingSummarizer.merge(request)),
		};

		const memory = open(tempDir(), { low: 3_000, high: 6_000, summarizer: flaky });
		await fill(memory, 30, (m) => ["user", text(700, `m${m}`)]);
		assert.ok(memory.viewBytes() > 6_000, "no parent is built, so nothing can merge");
		assert.equal(memory.stats.merges, 0);
		assert.equal(memory.view.length, 30, "it only appends while blocked");
		down = false;
		memory.log("user", text(700, "retries start"));
		await memory.idle(); // the failed merges were tried again at that message and are built now
		memory.log("user", text(700, "next"));
		assert.ok(memory.stats.lastBatch.to <= 3_000, `${memory.stats.lastBatch.to} bytes after the next message`);
		assert.ok(memory.stats.merges > 10);
	});
});

const truncatingSummarizerText = (request: Compress): string => `${request.message.kind}: ${request.message.text.slice(0, 400)}`;

describe("the saved view", () => {
	test("view.json holds [l, i] pairs and reopening gives the identical view", async () => {
		const dir = tempDir();
		const memory = open(dir, { low: 3_000, high: 6_000 });

		await fill(memory, 120, (m) => [m % 3 === 0 ? "user" : "agent", text(300 + (m % 7) * 150, `m${m}`)]);
		const saved: number[][] = JSON.parse(readFileSync(join(dir, "view.json"), "utf8"));
		assert.deepEqual(saved, memory.view.map((p) => [p.l, p.i]));
		assert.ok(memory.view.some((p) => p.l > 0), "some lines merged");
		assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file is left behind");
		const again = open(dir, { low: 3_000, high: 6_000 });
		assert.deepEqual(again.view, memory.view);
		assert.equal(again.render(), memory.render());
	});

	test("a saved view is loaded as it is, never rebuilt from the log", () => {
		const dir = tempDir();
		const memory = open(dir, { low: 3_000, high: 6_000 });

		for (let m = 0; m < 8; m++) memory.log("user", `short ${m}`);
		// A coarser view than any fold would give for a budget this large: it must survive a reopen.
		writeFileSync(join(dir, "view.json"), JSON.stringify([[3, 0]]));
		const again = open(dir, { low: 3_000, high: 6_000 });
		assert.deepEqual(again.view, [{ l: 3, i: 0 }]);
	});

	test("a crash between a log write and the view save: the missing lines are appended, the rest is kept", async () => {
		const dir = tempDir();
		const memory = open(dir, { low: 3_000, high: 6_000 });

		await fill(memory, 60, (m) => ["user", text(600, `m${m}`)]);
		const before = [...memory.view];
		const day = readdirSync(join(dir, "main"))[0];
		const record = (i: number, body: string) => `${JSON.stringify({ i, kind: "user", text: body, size: bytes(body), date: "2026-01-01T00:00:00.000Z" })}\n`;
		appendFileSync(join(dir, "main", day), record(60, "lost view save one") + record(61, "lost view save two"));
		const again = open(dir, { low: 3_000, high: 6_000 });
		assert.equal(again.length, 62);
		assert.deepEqual(again.view.slice(0, before.length - 1), before.slice(0, -1), "nothing before the end was rebuilt");
		assert.deepEqual(again.view.slice(-2), [{ l: 0, i: 60 }, { l: 0, i: 61 }]);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "view.json"), "utf8")), again.view.map((p) => [p.l, p.i]), "and it was saved");
	});

	test("migration: a log with no view.json is folded once and saved; a malformed view.json is an error, not a rebuild", async () => {
		const dir = tempDir();
		const memory = open(dir, { low: 2_000, high: 4_000 });

		await fill(memory, 60, (m) => ["user", text(600, `m${m}`)]);
		const was = [...memory.view];
		rmSync(join(dir, "view.json"));
		const migrated = open(dir, { low: 2_000, high: 4_000 });
		assert.ok(existsSync(join(dir, "view.json")));
		assert.deepEqual(migrated.view, was, "the fold gives the view that live use gave");
		writeFileSync(join(dir, "view.json"), "[[0,0],[0,5]]");
		assert.throws(() => open(dir), /does not follow message 1/);
		writeFileSync(join(dir, "view.json"), "not json");
		assert.throws(() => open(dir));
	});
});

type Calls = { running: number; max: number; started: string[]; finished: Set<string>; problems: string[] };

describe("the compactor", () => {
	/** A summarizer with a delay that records how many calls overlap and in what order they start and end. */
	function recording(delay: number) {
		const record: Calls = { running: 0, max: 0, started: [], finished: new Set(), problems: [] };
		const done = new Set<number>();

		const finish = async <T>(name: string, make: () => T): Promise<T> => {
			record.running++;
			record.max = Math.max(record.max, record.running);
			record.started.push(name);
			await sleep(delay);
			record.running--;
			record.finished.add(name);

			return make();
		};

		const summarizer: Summarizer = {
			compress: (request) => {
				const unbuilt = request.id - done.size; // earlier messages not finished yet: fewer than 8 may be

				if (unbuilt >= 8) record.problems.push(`message ${request.id} started with ${unbuilt} earlier ones unbuilt`);

				return finish(`${request.id}+1`, () => {
					done.add(request.id);

					return `summary of ${request.id}: ${"s".repeat(400)}`;
				});
			},
			merge: (request) => {
				for (const half of [request.a, request.b]) {
					if (!record.finished.has(`${half.id}+${half.n}`)) record.problems.push(`merge ${half.id}+${half.n} started before it was built`);
				}

				return finish(`${request.id}+${request.b.n * 2}`, () => `merge of ${request.id}: ${"m".repeat(450)}`);
			},
		};

		return { record, summarizer };
	}

	test("at most 8 calls run at once, messages start in order once fewer than 8 earlier ones are unbuilt, merges wait for both halves", async () => {
		const { record, summarizer } = recording(3);
		const memory = open(tempDir(), { summarizer, low: 20_000, high: 40_000 });

		for (let m = 0; m < 40; m++) memory.log("user", text(700, `m${m}`));
		await memory.idle();
		assert.equal(record.max, 8, "it uses all 8 slots");
		assert.deepEqual(record.problems, []);
		const messages = record.started.filter((n) => n.endsWith("+1")).map((n) => Number.parseInt(n, 10));
		assert.deepEqual(messages, [...messages].sort((a, b) => a - b), "messages start in order");
		assert.equal(messages.length, 40);
		assert.ok(record.started.some((n) => !n.endsWith("+1")), "merges ran");
		assert.ok(memory.node(5, 0) !== undefined, "the whole first 32 messages are one node");
		assert.equal(memory.stats.failures, 0);
	});

	test("settle(id) resolves once every message before id is summarized", async () => {
		const { summarizer } = recording(4);
		const memory = open(tempDir(), { summarizer });
		assert.equal(await memory.settle(0), true);

		for (let m = 0; m < 20; m++) memory.log("user", text(700, `m${m}`));
		assert.equal(memory.node(0, 0), undefined);
		let settled = false;

		const waiting = memory.settle(12).then((ok) => {
			settled = ok;
		});

		await sleep(1);
		assert.equal(settled, false);
		assert.equal(await memory.settle(12), true);
		await waiting;
		assert.ok(settled);

		for (let m = 0; m < 12; m++) assert.ok(memory.node(0, m) !== undefined, `message ${m}`);
	});

	test("a failed call is retried at the next message; settle gives up (false) rather than hang on a call that keeps failing", async () => {
		let failures = 1;

		const flaky: Summarizer = {
			compress: async (request) => {
				if (request.id === 2 && failures-- > 0) throw new Error("model down");

				return truncatingSummarizerText(request);
			},
			merge: truncatingSummarizer.merge,
		};

		const memory = open(tempDir(), { summarizer: flaky });

		for (let m = 0; m < 5; m++) memory.log("user", text(700, `m${m}`));
		await memory.idle();
		assert.equal(memory.node(0, 2), undefined);
		assert.equal(memory.stats.failures, 1);
		memory.log("user", text(700, "next"));
		await memory.idle();
		assert.ok(memory.node(0, 2) !== undefined, "retried at the next message");

		const broken: Summarizer = { compress: () => Promise.reject(new Error("always")), merge: truncatingSummarizer.merge };
		const stuck = open(tempDir(), { summarizer: broken });
		stuck.log("user", text(700, "never"));
		assert.equal(await stuck.settle(1), false);
		assert.match(stuck.render(), new RegExp(PLACEHOLDER.replace(/[()]/g, "\\$&")));
	});

	test("after a crash the missing nodes are queued in one pass and built", async () => {
		const dir = tempDir();
		const memory = open(dir);

		for (let m = 0; m < 64; m++) memory.log("user", text(700, `m${m}`));
		await memory.idle();
		const total = readdirSync(join(dir, "tree")).map((f) => readFileSync(join(dir, "tree", f), "utf8").split("\n").length - 1).reduce((a, b) => a + b, 0);
		assert.equal(total, 127, "64 messages, 63 merges");
		const file = join(dir, "tree", readdirSync(join(dir, "tree"))[0]);
		const lines = readFileSync(file, "utf8").split("\n").slice(0, 40); // a crash lost every node after the 40th written
		writeFileSync(file, lines.join("\n") + "\n");
		const again = open(dir);
		await again.idle();
		assert.ok(again.node(6, 0) !== undefined, "the root of 64 messages is rebuilt");

		for (let m = 0; m < 64; m++) assert.ok(again.node(0, m) !== undefined);
	});
});

describe("compactions", () => {
	test("the compaction view is bounded, built only, and ends at the node", async () => {
		const seen: { id: number; end?: number; view: string }[] = [];

		const spy: Summarizer = {
			compress: async (request) => {
				seen.push({ id: request.id, view: request.view() });

				return truncatingSummarizerText(request);
			},
			merge: async (request) => {
				seen.push({ id: request.id, end: request.end, view: request.view() });

				return truncatingSummarizer.merge(request);
			},
		};

		const memory = open(tempDir(), { summarizer: spy, low: 12_000, high: 24_000, compactionLow: 2_000, compactionHigh: 4_000 });

		for (let m = 0; m < 400; m++) {
			memory.log("user", text(700, `m${m}`));
			assert.ok(memory.compactionBytes <= 5_000, `compaction view ${memory.compactionBytes} bytes`);
			await memory.idle();
		}

		assert.ok(memory.compactionBytes < memory.viewBytes());
		assert.ok(seen.length > 400);

		for (const call of seen) {
			const lines = call.view.split("\n").slice(1, -1).filter((line) => line !== "");
			const stop = call.end === undefined ? call.id : call.end + 1;
			let next = 0;

			for (const line of lines) {
				const [, start, n] = /^(\d+)\+(\d+)\|/.exec(line) ?? [];
				assert.equal(Number(start), next, `call ${call.id}: lines are contiguous from 0`);
				next += Number(n);
				assert.ok(!line.includes(PLACEHOLDER), "only built lines");
			}

			assert.equal(next, stop, `the view of ${call.end === undefined ? "message" : "merge"} ${call.id} ends at the node`);
			assert.ok(bytes(call.view) < 5_000, `${bytes(call.view)} bytes`);
		}
	});

	test("the compaction view stops at the first unbuilt line", async () => {
		const held: (() => void)[] = [];

		const stuck: Summarizer = {
			compress: (request) => (request.id === 1 ? new Promise((resolve) => held.push(() => resolve("late"))) : Promise.resolve(truncatingSummarizerText(request))),
			merge: truncatingSummarizer.merge,
		};

		const memory = open(tempDir(), { summarizer: stuck });

		for (let m = 0; m < 6; m++) memory.log("user", text(700, `m${m}`));
		await sleep(2);
		const view = memory.compactionView(5);
		assert.equal(view.split("\n").length, 3, "message 0 only: message 1 is unbuilt, so nothing after it is shown");
		held.shift()?.();
	});

	test("tasks are the spec's, with a 512-dash ruler", () => {
		assert.equal(RULER.length, 512);
		assert.match(RULER, /^-+$/);
		const message: Message = { i: 7, kind: "user", text: "do it\nnow", size: 9, date: "" };
		assert.equal(compressTask(message), `Compaction: compress message 7 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${RULER}\n<input>\nuser: do it\nnow\n</input>`);
		const merge = mergeTask({ id: 40, n: 4, text: "first\nline" }, { id: 44, n: 4, text: "second" }, 40, 47);
		assert.equal(merge, `Compaction: merge lines 40+4 and 44+4, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${RULER}\n<chat> may hold their messages, 40 to 47, in more detail: take details\nof them from there too.\n<input>\n40+4|first line\n44+4|second\n</input>`);
	});

	test("the memory gives a model summarizer the view and the task", async () => {
		const calls: Turn[][] = [];

		const complete = async (conversation: Turn[]): Promise<string> => {
			calls.push(conversation);

			return "a line";
		};

		const memory = open(tempDir(), { summarizer: new ModelSummarizer(complete) });
		memory.log("user", "short");
		memory.log("agent", text(900, "long reply"));
		await memory.idle();
		assert.equal(calls.length, 1, "the short message is its own node");
		const [view, task] = calls[0][0].parts;
		assert.equal(view, "<chat>\nuser: short\n</chat>".replace("user: short", "0+1|user: short"));
		assert.match(task, /^Compaction: compress message 1 into/);
	});
});

describe("Too long", () => {
	const reply = (n: number) => "w".repeat(n);

	test("a reply over 512 bytes gets the spec's message in the same conversation; two overshoots then a fit", async () => {
		const sizes = [600, 540, 100];
		const calls: Turn[][] = [];

		const complete = async (conversation: Turn[]): Promise<string> => {
			calls.push(conversation);

			return reply(sizes[calls.length - 1]);
		};

		const model = new ModelSummarizer(complete);
		const line = await model.compress({ id: 3, message: { i: 3, kind: "user", text: "x", size: 1, date: "" }, task: "TASK", view: () => "VIEW" });
		assert.equal(line, reply(100));
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0], [{ role: "user", parts: ["VIEW", "TASK"] }]);
		assert.deepEqual(calls[1], [{ role: "user", parts: ["VIEW", "TASK"] }, { role: "assistant", parts: [reply(600)] }, { role: "user", parts: [tooLong(reply(600))] }]);
		assert.equal(calls[2].length, 5, "the conversation keeps growing");
		assert.equal(tooLong(reply(600)), `Too long: your line is 600 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${reply(512)}| ← LIMIT`);
	});

	test("a line that never fits is tried 5 times and the shortest is kept", async () => {
		const sizes = [700, 650, 600, 640, 900];
		let n = 0;

		const complete = async (): Promise<string> => reply(sizes[n++]);

		const model = new ModelSummarizer(complete);
		const line = await model.merge({ id: 0, end: 1, a: { id: 0, n: 1, text: "a" }, b: { id: 1, n: 1, text: "b" }, task: "T", view: () => "V" });
		assert.equal(n, 5);
		assert.equal(bytes(line), 600);
		assert.ok(bytes(line) > NODE);
	});

	test("a line that fits at once is one call", async () => {
		let n = 0;

		const complete = async (): Promise<string> => {
			n++;

			return " fits \n";
		};

		assert.equal(await new ModelSummarizer(complete).merge({ id: 0, end: 1, a: { id: 0, n: 1, text: "a" }, b: { id: 1, n: 1, text: "b" }, task: "T", view: () => "V" }), "fits");
		assert.equal(n, 1);
	});

	test("the cut keeps whole characters", () => {
		const wide = "é".repeat(400); // 800 bytes
		assert.ok(tooLong(wide).includes(`${"é".repeat(256)}| ← LIMIT`));
	});
});

describe("the log", () => {
	test("a tool's output keeps its head and tail, 30,000 characters in all, and says what was cut", () => {
		const long = `HEAD${"a".repeat(60_000)}TAIL`;
		const clipped = clipTool(long);
		assert.ok(clipped.startsWith("HEAD"));
		assert.ok(clipped.endsWith("TAIL"));
		assert.match(clipped, /\[\.\.\. 30008 of 60008 characters cut here \.\.\.\]/);
		assert.equal(clipped.replace(/\n\[\.\.\..*\.\.\.\]\n/, "").length, CLIP);
		assert.equal(clipTool("short"), "short");
		assert.equal(clipTool("z".repeat(CLIP)).length, CLIP);
	});

	test("any other long text is never cut: it is split over consecutive messages", () => {
		const memory = open(tempDir());
		const long = Array.from({ length: 70_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
		const ids = memory.log("user", long);
		assert.deepEqual(ids, [0, 1, 2]);
		assert.deepEqual(memory.root.map((m) => m.text.length), [CHUNK, CHUNK, 10_000]);
		assert.equal(memory.root.map((m) => m.text).join(""), long);
		const echo = memory.log("echo", long);
		assert.equal(echo.length, 1, "tool output is clipped, not split");
		assert.ok(memory.root[3].text.length < 30_100);
		assert.deepEqual(memory.log("agent", "short"), [4]);
	});

	test("a split never lands inside a surrogate pair", () => {
		const pairs = `${"a".repeat(CHUNK - 1)}😀${"b".repeat(5)}`;
		const parts = splitLong(pairs);
		assert.equal(parts.join(""), pairs);

		for (const part of parts) assert.ok(!/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part));
		const clipped = clipTool(`${"a".repeat(CLIP / 2 - 1)}😀${"b".repeat(CLIP)}${"c".repeat(CLIP / 2 - 1)}😀d`);
		assert.ok(!/[\ud800-\udbff]\n\[/.test(clipped));
	});

	test("records carry {i, kind, text, size, date}; files split by day; reopening reads every day", async () => {
		const dir = tempDir();
		let day = "2026-03-01T10:00:00.000Z";
		const memory = open(dir, { now: () => new Date(day), summarizer: truncatingSummarizer });
		memory.log("user", "héllo");
		memory.log("tool", text(900, "call"));
		day = "2026-03-02T09:00:00.000Z";
		memory.log("note", "imported memory");
		await memory.idle();
		assert.deepEqual(readdirSync(join(dir, "main")), ["2026-03-01.jsonl", "2026-03-02.jsonl"]);
		assert.deepEqual(readdirSync(join(dir, "tree")), ["2026-03-01.jsonl", "2026-03-02.jsonl"]);
		const first: Record<string, string | number> = JSON.parse(readFileSync(join(dir, "main", "2026-03-01.jsonl"), "utf8").split("\n")[0]);
		assert.deepEqual(first, { i: 0, kind: "user", text: "héllo", size: 6, date: "2026-03-01T10:00:00.000Z" });
		const node: Record<string, string | number> = JSON.parse(readFileSync(join(dir, "tree", "2026-03-01.jsonl"), "utf8").split("\n")[0]);
		assert.deepEqual(node, { l: 0, i: 0, text: "user: héllo", size: 12 });
		const again = open(dir);
		assert.deepEqual(again.root, memory.root);
		assert.equal(again.date(2), "2026-03-02T09:00:00.000Z");
		assert.equal(again.date(9), "No message 9.");
		assert.equal(again.node(0, 0)?.text, "user: héllo");
	});

	test("the old single-file layout is still read, its `talk` kind and missing sizes included", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "main.jsonl"), `${JSON.stringify({ i: 0, kind: "user", text: "old one", date: "2025-01-01T00:00:00.000Z" })}\n${JSON.stringify({ i: 1, kind: "talk", text: "old two", date: "2025-01-01T00:00:01.000Z" })}\n`);
		writeFileSync(join(dir, "tree.jsonl"), `${JSON.stringify({ l: 0, i: 0, text: "user: old one" })}\n${JSON.stringify({ l: 0, i: 1, text: "talk: old two" })}\n`);
		const memory = open(dir);
		await memory.idle();
		assert.deepEqual(memory.root.map((m) => [m.kind, m.size]), [["user", 7], ["agent", 7]]);
		assert.ok(existsSync(join(dir, "view.json")), "migrated: folded once and saved");
		memory.log("agent", "new");
		assert.equal(open(dir).length, 3);
		assert.ok(existsSync(join(dir, "main")));
	});

	test("torn and malformed lines are skipped, and the next write starts on its own line", async () => {
		const dir = tempDir();
		const warnings: string[] = [];
		const memory = open(dir, { now: () => new Date("2026-03-01T00:00:00.000Z") });
		memory.log("user", "one");
		memory.log("user", "two");
		await memory.idle();
		const file = join(dir, "main", "2026-03-01.jsonl");
		appendFileSync(file, '{"i":2,"kind":"user","text":"torn mid wr'); // power loss in the middle of a write
		const again = open(dir, { warn: (m) => warnings.push(m), now: () => new Date("2026-03-01T00:00:00.000Z") });
		assert.equal(again.length, 2);
		assert.equal(warnings.length, 1);
		assert.deepEqual(again.log("user", "three"), [2], "the torn message was never acknowledged, so its id is reused");
		assert.equal(open(dir).length, 3);

		for (const bad of ['{"i":3,"kind":"bogus","text":"x","size":1,"date":"d"}', '{"i":3,"kind":"user","text":"x","size":9,"date":"d"}', '{"i":3,"kind":"user","text":5,"date":"d"}', "[1,2]", '{"i":-1,"kind":"user","text":"x","date":"d"}']) {
			appendFileSync(file, `${bad}\n`);
		}

		const warned: string[] = [];
		assert.equal(open(dir, { warn: (m) => warned.push(m) }).length, 3);
		assert.equal(warned.length, 6, "the old torn line and each malformed one are rejected");
	});

	test("a torn tree line is skipped and the node is built again", async () => {
		const dir = tempDir();
		const memory = open(dir, { now: () => new Date("2026-03-01T00:00:00.000Z") });
		memory.log("user", text(700, "a"));
		await memory.idle();
		const file = join(dir, "tree", "2026-03-01.jsonl");
		writeFileSync(file, readFileSync(file, "utf8").slice(0, -20));
		const again = open(dir);
		assert.equal(again.node(0, 0), undefined);
		await again.idle();
		assert.ok(again.node(0, 0) !== undefined);
	});
});

describe("the system prompt", () => {
	test("is constant text for Forge: no dates, no state, and the renamed kinds", () => {
		assert.equal(PROMPT_SECTIONS.map((s) => s.text).join("\n\n"), SYSTEM_PROMPT);
		assert.ok(SYSTEM_PROMPT.startsWith("You are Forge,"));
		assert.ok(!/unii/i.test(SYSTEM_PROMPT));
		assert.ok(SYSTEM_PROMPT.includes("- agent: Forge's replies"));
		assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT));
		assert.ok(SYSTEM_PROMPT.includes("date(id) gives the date and time of message id"));
	});
});
