// The ambient clock: `Date.now()`, `new Date()` and `Date()` answer from a per-call instant, recorded with the call id
// (so a crash rerun and a replay match) and fixed at `GATE_EPOCH` for the gate's own executions. The rest of `Date`
// still works normally.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GATE_EPOCH } from "../src/cells.ts";
import { type Forge, openForge, verifyOnly, version } from "./support.ts";

let dir = "";

let forge: Forge;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "ambient-clock-"));
	forge = await openForge(dir);
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("a call id pins Date", () => {
	test("the same call id answers the same instant twice", async () => {
		const state = forge.runtime.statePath("clock-same");
		const before = forge.runtime.replayed;
		const first = await forge.runtime.run("return Date.now();", {}, state, "clock:same");
		const second = await forge.runtime.run("return Date.now();", {}, state, "clock:same");

		assert.ok(Number.isInteger(first), "Date.now() is a number");
		assert.equal(second, first);
		assert.equal(forge.runtime.replayed - before, 1, "the second answer came from the calls table");
	});

	test("a crash before the call committed still reuses the recorded instant", async () => {
		const state = forge.runtime.statePath("clock-crash");
		await assert.rejects(forge.runtime.run("throw new Error('boom');", {}, state, "clock:crash"), /boom/);

		const db = new DatabaseSync(state);
		const recorded = Number(db.prepare("SELECT at FROM call_clock WHERE id = ?").get("clock:crash")?.at);
		db.close();

		assert.ok(Number.isInteger(recorded), "the clock row survived the rolled-back call");
		assert.equal(await forge.runtime.run("return Date.now();", {}, state, "clock:crash"), recorded);
	});

	test("two call ids recorded at different instants differ", async () => {
		const state = forge.runtime.statePath("clock-diff");
		const first = Number(await forge.runtime.run("return Date.now();", {}, state, "clock:first"));
		// Record a deliberately different instant for the second id; real use records the host clock the same way.
		const db = new DatabaseSync(state);
		db.prepare("INSERT INTO call_clock (id, at) VALUES (?, ?)").run("clock:second", first + 1234);
		db.close();

		assert.equal(await forge.runtime.run("return Date.now();", {}, state, "clock:second"), first + 1234);
	});
});

describe("the wrapper keeps the rest of Date", () => {
	test("arguments, statics, the function form and instanceof all work", async () => {
		const source = `return {
	epoch: new Date(0).toISOString(),
	utc: Date.UTC(2020, 0, 1),
	parsed: Date.parse("2000-01-01T00:00:00.000Z"),
	noArgs: new Date().toISOString(),
	instance: new Date() instanceof Date,
	argumentInstance: new Date(0) instanceof Date,
	asFunction: Date() === new Date().toString(),
};`;

		assert.deepEqual(await forge.runtime.run(source, {}, forge.runtime.statePath("clock-static")), {
			epoch: "1970-01-01T00:00:00.000Z",
			utc: 1577836800000,
			parsed: 946684800000,
			noArgs: "2026-01-01T00:00:00.000Z",
			instance: true,
			argumentInstance: true,
			asFunction: true,
		});
	});

	test("GATE_EPOCH is 2026-01-01T00:00:00.000Z", () => {
		assert.equal(new Date(GATE_EPOCH).toISOString(), "2026-01-01T00:00:00.000Z");
	});
});

describe("the gate's fixed instant", () => {
	test("an exact check of new Date().toISOString() passes", async () => {
		const candidate = version("gateclock", "return new Date().toISOString();", { checks: [{ args: {}, expect: "2026-01-01T00:00:00.000Z" }] });
		const outcome = await verifyOnly(forge, candidate, { expectLive: null, owned: [], changes: [] });

		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
	});
});

describe("replay", () => {
	test("a recorded clock and random stream replay without a difference", async () => {
		const source = "return { at: Date.now(), r: Math.random() };";
		const candidate = version("trace-clock", source, { checks: [] });
		await forge.runtime.call(candidate, "trace-clock", {}, "trace-clock:1");
		const [trace] = await forge.runtime.traces("trace-clock", 1);

		assert.ok(Number.isInteger(trace.at), "the trace carries the call's clock instant");
		assert.deepEqual(await forge.runtime.replay("trace-clock", { source }, trace), { result: trace.result, after: trace.after });
	});
});

// Invariants and migrations that run on real state must see real time. Against the fixed gate epoch, an invariant
// like "nothing is dated in the future" fails on every entry stamped after January 1.
describe("real state sees real time", () => {
	const NOT_FUTURE = [{ name: "not in the future", source: "return ((await kv.get('stamp')) ?? 0) <= Date.now();" }];

	test("an invariant checking a real call sees that call's instant", async () => {
		const state = forge.runtime.statePath("clock-invariant");
		const stamped = await forge.runtime.run("await kv.put('stamp', Date.now()); return Date.now();", {}, state, "clock:inv", NOT_FUTURE);

		assert.ok(Number(stamped) > GATE_EPOCH, "the call saw today, not the gate epoch");
	});

	test("a migration of today's state sees today, so the same invariant still holds", async () => {
		const name = "clock-migrate";
		const state = forge.runtime.statePath(name);
		await forge.runtime.run("await kv.put('stamp', Date.now()); return null;", {}, state, "clock:mig", NOT_FUTURE);
		const cell = version(name, "return null;", { migrate: "await kv.put('migratedAt', Date.now()); return null;", invariants: NOT_FUTURE });

		await forge.runtime.migrateTo(name, cell, NOT_FUTURE);

		const db = new DatabaseSync(state);
		const migratedAt = Number(JSON.parse(String(db.prepare("SELECT v FROM kv WHERE k = 'migratedAt'").get()?.v)));
		db.close();
		assert.ok(migratedAt > GATE_EPOCH, "the migration saw today");
	});
});
