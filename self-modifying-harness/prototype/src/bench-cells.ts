// Measures where a cell call's time goes, and the median call latency (cold = first call, warm = median of 20).
//   node --experimental-strip-types --no-warnings src/bench-cells.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { CellRuntime, type CellVersion } from "./cells.ts";

const RUNS = 20;

function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);

	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function time<T>(work: () => Promise<T>): Promise<number> {
	const start = performance.now();
	await work();

	return performance.now() - start;
}

function cell(name: string, source: string): CellVersion {
	return { version: `${name}@bench`, description: "", parameters: {}, source, checks: [], retired: [], invariants: [], replay: "unsafe" };
}

const dir = mkdtempSync(join(tmpdir(), "bench-cells-"));

try {
	console.log("breakdown (ms)");
	const compile = await time(() => loadQuickJSWasm());
	console.log(`  wasm compile, first load in this process: ${compile.toFixed(1)}`);
	const wasm = await loadQuickJSWasm();
	const sandbox = new CodemodeSandbox({ wasm });
	const first = await time(() => sandbox.execute("return 1"));
	const warm: number[] = [];

	for (let i = 0; i < RUNS; i++) warm.push(await time(() => sandbox.execute("return 1")));
	console.log(`  bare execute("return 1"), first: ${first.toFixed(1)}, median of ${RUNS}: ${median(warm).toFixed(1)} (worker start + VM create + teardown)`);
	const construct: number[] = [];

	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		const fresh = new CodemodeSandbox({ wasm });
		construct.push(performance.now() - start);
		await fresh.close();
	}

	console.log(`  CodemodeSandbox construction: ${median(construct).toFixed(3)}`);

	const runtime = new CellRuntime(dir);
	const counter = cell("bench", "const n = (await kv.get('n')) ?? 0; await kv.put('n', n + 1); return n + 1;");
	console.log("cell call (ms)");
	const cold = await time(() => runtime.call(counter, "bench", {}));
	const calls: number[] = [];

	for (let i = 0; i < RUNS; i++) calls.push(await time(() => runtime.call(counter, "bench", {})));
	console.log(`  cold (first call): ${cold.toFixed(1)}`);
	console.log(`  warm, median of ${RUNS}: ${median(calls).toFixed(1)}`);
	const invariants = [{ name: "n is a number", source: "return (await kv.get('n')) > 0;" }];
	const checked: number[] = [];

	for (let i = 0; i < RUNS; i++) checked.push(await time(() => runtime.call(counter, "bench", {}, undefined, invariants)));
	console.log(`  warm with one invariant (a second sandbox execution), median of ${RUNS}: ${median(checked).toFixed(1)}`);
	const other = cell("other", "return await kv.keys();");
	const pairs: number[] = [];

	for (let i = 0; i < RUNS; i++) {
		pairs.push(await time(async () => {
			await runtime.call(counter, "bench", {});
			await runtime.call(other, "other", {});
		}));
	}

	console.log(`  two cells back to back, median of ${RUNS} pairs: ${median(pairs).toFixed(1)}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
