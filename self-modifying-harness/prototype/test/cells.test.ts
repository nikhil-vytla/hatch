import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CellRuntime, type CellVersion, InvariantError, type Invariant } from "../src/cells.ts";
import { generateArgs } from "../src/schema-fuzz.ts";

function cell(name: string, source: string, extra: Partial<CellVersion> = {}): CellVersion {
	return { version: `${name}@test`, description: "", parameters: {}, source, checks: [], retired: [], replay: "unsafe", ...extra, invariants: extra.invariants ?? [] };
}

const COUNTER = cell("counter", "const n = (await kv.get('n')) ?? 0; await kv.put('n', n + args.by); return n + args.by;");

const NON_NEGATIVE: Invariant = { name: "n is never negative", source: "return ((await kv.get('n')) ?? 0) >= 0;" };

let root = "";

let runtime: CellRuntime;

let counter = 0;

// A fresh runtime directory per test, so tests never share state files.
function fresh(timeoutMs = 5_000): CellRuntime {
	return new CellRuntime(mkdtempSync(join(root, `t${counter++}-`)), timeoutMs);
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "cells-test-"));
	runtime = fresh();
});

after(async () => {
	await runtime.close();
	rmSync(root, { recursive: true, force: true });
});

describe("invariants", () => {
	test("a violation rolls the call back and names the invariant", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "c", { by: 5 }, undefined, [NON_NEGATIVE]);
		await assert.rejects(
			rt.call(COUNTER, "c", { by: -9 }, "call-1", [NON_NEGATIVE]),
			(error: Error) => error instanceof InvariantError && error.invariant === "n is never negative" && error.message.includes('"n is never negative"'),
		);
		assert.equal(await rt.call(COUNTER, "c", { by: 0 }), 5, "state is as before the failed call");
		assert.deepEqual(await rt.traces("c", 10), [], "a rolled-back call leaves no trace");
	});

	test("a throwing or non-true invariant also rolls back", async () => {
		const rt = fresh();
		const throwing = { name: "boom", source: "throw new Error('nope');" };
		const truthy = { name: "truthy", source: "return 1;" };
		await assert.rejects(rt.call(COUNTER, "c", { by: 1 }, undefined, [throwing]), /invariant "boom" violated: threw nope/);
		await assert.rejects(rt.call(COUNTER, "c", { by: 1 }, undefined, [truthy]), /invariant "truthy" violated: returned 1/);
		assert.equal(await rt.call(COUNTER, "c", { by: 0 }), 0);
	});

	test("invariants cannot write, even through the global kv", async () => {
		const rt = fresh();
		const sneaky = { name: "sneaky", source: "await globalThis.kv.put('x', 1); return true;" };
		await assert.rejects(rt.call(COUNTER, "c", { by: 1 }, undefined, [sneaky]), /invariant "sneaky" violated: threw kv is read-only/);
		const handed = { name: "handed", source: "await kv.put('x', 1); return true;" };
		await assert.rejects(rt.call(COUNTER, "c", { by: 1 }, undefined, [handed]), /invariant "handed" violated/);
		assert.deepEqual(await rt.call(cell("k", "return await kv.keys();"), "c", {}), [], "nothing was written");
	});

	test("an invariant that spins is killed by the timeout and rolls back", async () => {
		const rt = fresh(500);
		const spin = { name: "spin", source: "while (true) {}" };
		await assert.rejects(rt.call(COUNTER, "c", { by: 1 }, undefined, [spin]), /invariants \[spin\] could not be evaluated: timeout/);
		assert.equal(await rt.call(COUNTER, "c", { by: 0 }), 0);
	});

	test("verify checks invariants after the migration", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "m", { by: 3 });
		const candidate = cell("m", "return 1;", { migrate: "await kv.put('n', -1);" });
		const verdict = await rt.verify("m", candidate, [], [NON_NEGATIVE]);
		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.reason, /migration failed.*invariant "n is never negative"/);
		assert.equal(await rt.call(cell("g", "return await kv.get('n');"), "m", {}), 3, "the live state was not touched");
		assert.deepEqual(await rt.verify("m", cell("m", "return 1;", { migrate: "await kv.put('n', 4);" }), [], [NON_NEGATIVE]), { ok: true });
	});

	test("verify checks invariants after every check in every group", async () => {
		const rt = fresh();
		const candidate = cell("v", COUNTER.source);
		const groups = [[{ args: { by: 2 }, expect: 2 }], [{ args: { by: 1 }, expect: 1 }, { args: { by: -5 }, expect: -4 }]];
		const verdict = await rt.verify("v", candidate, groups, [NON_NEGATIVE]);
		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.reason, /group 1 check 1 .* broke invariant "n is never negative"/);
		assert.deepEqual(await rt.verify("v", candidate, groups.slice(0, 1), [NON_NEGATIVE]), { ok: true });
	});
});

describe("invariants of two origins", () => {
	// Rewrites Array.prototype.push so that every later verdict is recorded as a pass. In one VM, a model-proposed body
	// running first can therefore make a caller-owned body after it pass; in its own execution it cannot.
	const TAMPER: Invariant = { name: "tamper", source: "const push = Array.prototype.push; Array.prototype.push = function () { return push.call(this, null); }; return true;" };

	test("one list shares a VM, so a tampering body hides a later violation (why the lists are kept apart)", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "c", { by: 5 });
		assert.equal(await rt.call(COUNTER, "c", { by: -9 }, undefined, [TAMPER, NON_NEGATIVE]), -4, "the violation went unnoticed");
	});

	test("caller-owned and model-proposed lists run in separate executions", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "c", { by: 5 });
		await assert.rejects(
			rt.call(COUNTER, "c", { by: -9 }, undefined, { owned: [NON_NEGATIVE], proposed: [TAMPER] }),
			(error: Error) => error instanceof InvariantError && error.invariant === "n is never negative",
		);
		const started = rt.executions;
		await rt.call(COUNTER, "c", { by: 1 }, undefined, { owned: [NON_NEGATIVE], proposed: [TAMPER] });
		assert.equal(rt.executions - started, 3, "the call and one execution per non-empty list");
		await rt.call(COUNTER, "c", { by: 1 }, undefined, { owned: [], proposed: [] });
	});

	test("verify, replay and run take the same two lists", async () => {
		const rt = fresh();
		const candidate = cell("v", COUNTER.source);
		const verdict = await rt.verify("v", candidate, [[{ args: { by: -3 }, expect: -3 }]], { owned: [NON_NEGATIVE], proposed: [TAMPER] });
		assert.equal(verdict.ok, false);
		assert.match(verdict.ok ? "" : verdict.reason, /broke invariant "n is never negative"/);
	});
});

describe("crash-safe migration marker", () => {
	const MIGRATING = cell("m", "return 1;", { migrate: "await kv.put('n', ((await kv.get('n')) ?? 0) * 10);" });

	test("the migration and its marker commit together, and a recorded version is not migrated twice", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "m", { by: 3 });
		assert.equal(await rt.migratedTo("m"), null);
		await rt.migrateTo("m", MIGRATING);
		assert.equal(await rt.migratedTo("m"), "m@test");
		await rt.migrateTo("m", MIGRATING);
		assert.equal(await rt.call(cell("g", "return await kv.get('n');"), "m", {}), 30, "migrated once, not 300");
	});

	test("a failing migration leaves neither its writes nor a marker", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "m", { by: 3 });
		const bad = cell("m", "return 1;", { migrate: "await kv.put('n', 99); throw new Error('half done');" });
		await assert.rejects(rt.migrateTo("m", bad), /half done/);
		assert.equal(await rt.migratedTo("m"), null);
		assert.equal(await rt.call(cell("g", "return await kv.get('n');"), "m", {}), 3);
	});

	test("a version without a migration is still marked", async () => {
		const rt = fresh();
		await rt.migrateTo("p", cell("p", "return 1;"));
		assert.equal(await rt.migratedTo("p"), "p@test");
		assert.equal(await rt.migratedTo("never-seen"), null);
	});

	test("replay runs the candidate's migration on the seeded before-state and compares results", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "r", { by: 4 }, "task:a");
		const [trace] = await rt.traces("r", 1);
		const wrapping = { source: "const n = (await kv.get('n')) ?? 0; return n + args.by;", migrate: "await kv.put('n', ((await kv.get('n')) ?? 0) * 10);" };
		assert.deepEqual(await rt.replay("r", wrapping, trace), { result: 4, after: { n: 0 } });
		const failing = { source: "return 1;", migrate: "throw new Error('cannot');" };
		assert.deepEqual(await rt.replay("r", failing, trace), { migrationError: "script: cannot" });
	});
});

describe("exactly-once and traces", () => {
	test("the same call id applies its effects once", async () => {
		const rt = fresh();
		assert.equal(await rt.call(COUNTER, "e", { by: 2 }, "task:1"), 2);
		assert.equal(await rt.call(COUNTER, "e", { by: 2 }, "task:1"), 2);
		assert.equal(await rt.call(COUNTER, "e", { by: 0 }), 2);
		assert.equal(rt.replayed, 1);
	});

	test("a trace records args, before, after, result and version", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "t", { by: 4 }, "task:a");
		await rt.call(COUNTER, "t", { by: 1 }, "task:b");
		await rt.call(COUNTER, "t", { by: 100 });
		const traces = await rt.traces("t", 10);
		assert.deepEqual(traces.map((t) => t.id), ["task:a", "task:b"], "newest last; calls without an id are not traced");
		assert.deepEqual(traces[0], { id: "task:a", args: { by: 4 }, before: {}, after: { n: 4 }, result: 4, version: "counter@test" });
		assert.deepEqual(traces[1].before, { n: 4 });
		assert.deepEqual(traces[1].after, { n: 5 });
		assert.deepEqual((await rt.traces("t", 1)).map((t) => t.id), ["task:b"]);
		assert.deepEqual(await rt.traces("never-called", 5), []);
	});

	test("snapshots over 64 KB are skipped, so the trace is not returned", async () => {
		const rt = fresh();
		const big = cell("big", "await kv.put('blob', 'x'.repeat(70000)); return 1;");
		await rt.call(big, "b", {}, "task:big");
		assert.deepEqual(await rt.traces("b", 5), []);
		const db = new DatabaseSync(rt.statePath("b"));
		const row = db.prepare("SELECT kv_before, kv_after, args FROM calls WHERE id = 'task:big'").get();
		db.close();
		assert.equal(row?.kv_after, null);
		assert.equal(row?.args, "{}");
	});

	test("a database from before the trace columns is migrated in place", async () => {
		const rt = fresh();
		const old = new DatabaseSync(rt.statePath("old"));
		old.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE calls (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
		old.exec("INSERT INTO kv VALUES ('n', '1'); INSERT INTO calls VALUES ('task:0', '1')");
		old.close();
		assert.equal(await rt.call(COUNTER, "old", { by: 1 }, "task:1"), 2);
		assert.equal(await rt.call(COUNTER, "old", { by: 1 }, "task:0"), 1, "the legacy row still answers its call id");
		assert.deepEqual((await rt.traces("old", 5)).map((t) => t.id), ["task:1"], "the legacy row has no snapshots");
	});

	test("replay is side-effect free", async () => {
		const rt = fresh();
		await rt.call(COUNTER, "r", { by: 4 }, "task:a");
		await rt.call(COUNTER, "r", { by: 1 }, "task:b");
		const [first, second] = await rt.traces("r", 2);
		const doubling = { source: "const n = (await kv.get('n')) ?? 0; await kv.put('n', n + 2 * args.by); return n + 2 * args.by;" };
		assert.deepEqual(await rt.replay("r", doubling, second), { result: 6, after: { n: 6 } });
		assert.deepEqual(await rt.replay("r", COUNTER, first), { result: first.result, after: first.after });
		assert.deepEqual(await rt.replay("r", { source: "throw new Error('bad');" }, first), { error: "script: bad" });
		assert.equal(await rt.call(cell("g", "return await kv.get('n');"), "r", {}), 5, "real state untouched");
		assert.equal((await rt.traces("r", 10)).length, 2, "no trace was added");
		assert.deepEqual(readdirSync(join(rt.dir, "state")).filter((f) => f.startsWith(".")), [], "scratch files are removed");
	});
});

describe("schema fuzzing", () => {
	const schema = {
		type: "object",
		properties: {
			action: { type: "string", enum: ["add", "remove", "reset"] },
			count: { type: "integer", minimum: 0, maximum: 10 },
			note: { type: "string", maxLength: 8 },
			tags: { type: "array", items: { type: "string" }, maxItems: 3 },
			ratio: { type: "number" },
			flag: { type: "boolean" },
		},
		required: ["action", "count"],
	};

	test("is deterministic in the seed and differs across seeds", () => {
		assert.deepEqual(generateArgs(schema, 40, 7), generateArgs(schema, 40, 7));
		assert.notDeepEqual(generateArgs(schema, 40, 7), generateArgs(schema, 40, 8));
	});

	test("respects required, enums, bounds and types, and covers every enum member", () => {
		const generated = generateArgs(schema, 60, 1);
		assert.equal(generated.length, 60);
		assert.deepEqual(Object.keys(generated[0]).sort(), ["action", "count"], "the first case is required fields only");
		assert.deepEqual(Object.keys(generated[1]).sort(), Object.keys(schema.properties).sort(), "the second has every field");
		const actions = new Set<string>();

		for (const args of generated) {
			assert.ok(schema.properties.action.enum.includes(String(args.action)));
			actions.add(String(args.action));
			assert.ok(Number.isInteger(args.count) && Number(args.count) >= 0 && Number(args.count) <= 10);

			if (args.note !== undefined) assert.ok(String(args.note).length <= 8 || [...String(args.note)].length <= 8);

			if (args.tags !== undefined) assert.ok(Array.isArray(args.tags) && args.tags.length <= 3);

			if (args.ratio !== undefined) assert.ok(Number.isFinite(args.ratio));
		}

		assert.deepEqual([...actions].sort(), ["add", "remove", "reset"]);
		assert.ok(generated.some((a) => a.count === 0) && generated.some((a) => a.count === 10), "bounds are hit");
		assert.ok(generated.some((a) => Array.isArray(a.tags) && a.tags.length === 0), "empty arrays appear");
		assert.deepEqual(JSON.parse(JSON.stringify(generated)), generated, "everything is JSON");
	});

	test("hits boundary values for unbounded numbers and strings", () => {
		const open = { type: "object", properties: { n: { type: "integer" }, s: { type: "string" } }, required: ["n", "s"] };
		const generated = generateArgs(open, 200, 3);

		for (const wanted of [0, -1, 1]) assert.ok(generated.some((a) => a.n === wanted), `n = ${wanted}`);
		assert.ok(generated.some((a) => Number(a.n) > 1e9), "a very large integer");
		assert.ok(generated.some((a) => a.s === ""), "the empty string");
		assert.ok(generated.some((a) => [...String(a.s)].some((c) => (c.codePointAt(0) ?? 0) > 255)), "unicode");
	});
});

describe("sandbox", () => {
	test("the timeout still kills while(true){}", async () => {
		const rt = fresh(400);
		const started = Date.now();
		await assert.rejects(rt.call(cell("spin", "while (true) {}"), "s", {}), /timeout/);
		assert.ok(Date.now() - started < 5_000);
		assert.equal(await rt.call(cell("ok", "return 7;"), "s", {}), 7, "the pooled sandbox survives a killed execution");
	});

	test("the pooled sandbox keeps two cells' databases apart, back to back and concurrently", async () => {
		const rt = fresh();
		const writer = (tag: string) => cell(`w${tag}`, `await kv.put('owner', '${tag}'); const n = (await kv.get('n')) ?? 0; await kv.put('n', n + 1); return [await kv.keys(), n + 1];`);

		for (let i = 1; i <= 3; i++) {
			assert.deepEqual(await rt.call(writer("A"), "a", {}), [["n", "owner"], i]);
			assert.deepEqual(await rt.call(writer("B"), "b", {}), [["n", "owner"], i]);
		}

		const reader = cell("reader", "return [await kv.get('owner'), await kv.get('n')];");
		assert.deepEqual(await rt.call(reader, "a", {}), ["A", 3]);
		assert.deepEqual(await rt.call(reader, "b", {}), ["B", 3]);

		const results = await Promise.all([
			rt.call(writer("A"), "a", {}),
			rt.call(writer("B"), "b", {}),
			rt.call(writer("A"), "a", {}),
			rt.call(writer("B"), "b", {}),
		]);

		assert.deepEqual(results, [[["n", "owner"], 4], [["n", "owner"], 4], [["n", "owner"], 5], [["n", "owner"], 5]]);
		assert.deepEqual(await rt.call(reader, "a", {}), ["A", 5]);
		assert.deepEqual(await rt.call(reader, "b", {}), ["B", 5]);
	});
});
