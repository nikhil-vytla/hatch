// How cacheable is the OptChat view? Replays a synthetic chat and measures, between consecutive turns, how many leading
// characters of the rendered view stay identical (the part a provider prompt cache can reuse). Baseline: a sliding
// window of the most recent whole messages that fit the same budget, the usual "keep the tail" compaction.
//
//   node --experimental-strip-types --no-warnings src/bench-view.ts [messages] [budget]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Kind, Memory } from "./optchat.ts";

const N = Number(process.argv[2] ?? 20_000);

const BUDGET = Number(process.argv[3] ?? 128_000);

// Seeded generator (mulberry32) so runs are repeatable.
let seed = 42;

const rand = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const words = "cell migrate check facet version rollback zoom view tree harness commit sqlite durable replay kernel gate".split(" ");

const text = (n: number) => Array.from({ length: Math.max(1, Math.round(n / 7)) }, () => words[Math.floor(rand() * words.length)]).join(" ");

// A turn: one user message, 0-6 tool round trips, one reply. Sizes roughly like a coding agent's log.
function* turns(): Generator<[Kind, string]> {
	for (;;) {
		yield ["user", text(40 + rand() * 400)];

		for (let k = Math.floor(rand() * 7); k > 0; k--) {
			yield ["tool", text(60 + rand() * 200)];
			yield ["echo", text(rand() < 0.2 ? 4_000 + rand() * 20_000 : 100 + rand() * 1_500)];
		}

		yield ["talk", text(100 + rand() * 1_200)];
	}
}

const sharedPrefix = (a: string, b: string) => {
	let i = 0;

	while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;

	return i;
};

const dir = mkdtempSync(join(tmpdir(), "optchat-bench-"));

const memory = new Memory(dir, { budget: BUDGET, fsync: false });

const all: [Kind, string][] = [];

const window = (): string => {
	const lines: string[] = [];
	let size = 0;

	for (let k = all.length - 1; k >= 0; k--) {
		const line = `${k}|${all[k][0]}: ${all[k][1]}`;

		if (size + line.length > BUDGET) break;
		lines.unshift(line);
		size += line.length;
	}

	return lines.join("\n");
};

let prevView = "";

let prevWindow = "";

const samples: { n: number; viewLen: number; viewShared: number; windowLen: number; windowShared: number; lines: number }[] = [];

const started = performance.now();

const gen = turns();

while (memory.length < N) {
	const step = gen.next();

	if (step.done) break; // `turns` never ends; this only narrows the type
	const [kind, body] = step.value;
	memory.log(kind, body);
	all.push([kind, body]);

	if (kind !== "user") continue; // a turn starts at each user message: measure there
	const view = memory.render(memory.length - 1); // rendered before the new message, as the spec says
	const win = window();

	if (memory.length > 200) {
		samples.push({ n: memory.length, viewLen: view.length, viewShared: sharedPrefix(prevView, view), windowLen: win.length, windowShared: sharedPrefix(prevWindow, win), lines: memory.view.length });
	}

	prevView = view;
	prevWindow = win;
}

const elapsed = performance.now() - started;

const avg = (f: (s: (typeof samples)[number]) => number, from = 0) => {
	const xs = samples.flatMap((s) => (s.n >= from ? [f(s)] : []));

	return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
};

const median = (f: (s: (typeof samples)[number]) => number) => {
	const xs = samples.map(f).sort((a, b) => a - b);

	return xs[Math.floor(xs.length / 2)];
};

const result = {
	messages: N,
	budgetBytes: BUDGET,
	turnsMeasured: samples.length,
	optchat: { avgCacheReadAtMarks: avg((s) => [100_000, 80_000, 50_000].find((m) => m <= s.viewShared) ?? 0), avgViewChars: avg((s) => s.viewLen), avgSharedPrefix: avg((s) => s.viewShared), medianSharedPrefix: median((s) => s.viewShared), avgSharedPrefixLastHalf: avg((s) => s.viewShared, N / 2), avgLines: avg((s) => s.lines) },
	slidingWindow: { avgCacheReadAtMarks: avg((s) => [100_000, 80_000, 50_000].find((m) => m <= s.windowShared) ?? 0), avgChars: avg((s) => s.windowLen), avgSharedPrefix: avg((s) => s.windowShared), medianSharedPrefix: median((s) => s.windowShared) },
	msTotal: Math.round(elapsed),
};

console.log(JSON.stringify(result, null, 2));

rmSync(dir, { recursive: true, force: true });
