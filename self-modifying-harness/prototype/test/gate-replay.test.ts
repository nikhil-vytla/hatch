// verifyCell, replay of real use: the live cell's recent calls run against the candidate, and a difference is intended only
// if its action is in `changes`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CellVersion } from "../src/cells.ts";
import { COUNTER_SOURCE, type Forge, openForge, propose, seedCounter, successor, verifyOnly, version } from "./support.ts";

let dir = "";

let forge: Forge;

let v1: CellVersion;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "gate-replay-"));
	forge = await openForge(dir);
	v1 = await seedCounter(forge);
	// Real use: two calls with call ids, so they leave traces.
	await forge.runtime.call(v1, "counter", { op: "add", by: 20 }, "real:1");
	await forge.runtime.call(v1, "counter", { op: "get" }, "real:2");
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

const CAPPED_GET = COUNTER_SOURCE.replace("return n;", "return Math.min(n, 10);");

describe("replay of real calls", () => {
	test("a difference outside `changes` is a drive-by edit and is rejected, naming the call", async () => {
		const candidate = successor(v1, CAPPED_GET);
		const none = await verifyOnly(forge, candidate, { expectLive: v1.version, owned: [], changes: [] });
		assert.equal(none.ok, false);
		assert.match(none.ok ? "" : none.reason, new RegExp(`replay: 1 of 2 real calls behave differently from ${v1.version} and this proposal declared no \`changes\`: \\{"op":"get"\\}: result 20 became 10`));

		const wrong = await verifyOnly(forge, candidate, { expectLive: v1.version, owned: [], changes: ["add"] });
		assert.match(wrong.ok ? "" : wrong.reason, /declared changes \["add"\]/);
	});

	test("a declared change is accepted and reported as a behaviour diff for the user", async () => {
		const outcome = await verifyOnly(forge, successor(v1, CAPPED_GET), { expectLive: v1.version, owned: [], changes: ["get"] });
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
		assert.equal(outcome.report.replayed, 2);
		assert.equal(outcome.report.behaviourDiffs.length, 1);
		assert.deepEqual(outcome.report.behaviourDiffs[0], { args: { op: "get" }, action: "get", summary: "result 20 became 10", intended: true });
	});

	test("[\"*\"] declares every action", async () => {
		const outcome = await verifyOnly(forge, successor(v1, CAPPED_GET), { expectLive: v1.version, owned: [], changes: ["*"] });
		assert.ok(outcome.ok);
		assert.equal(outcome.report.behaviourDiffs.length, 1);
	});

	test("a candidate that throws where the live version succeeded is a difference too", async () => {
		const throwing = COUNTER_SOURCE.replace("return n;", "if (n > 10) throw new Error('too many'); return n;");
		const outcome = await verifyOnly(forge, successor(v1, throwing), { expectLive: v1.version, owned: [], changes: [] });
		assert.match(outcome.ok ? "" : outcome.reason, /the live version returned 20, the candidate throws script: too many/);
	});

	test("a state difference alone counts, when there is no migration", async () => {
		const audit = COUNTER_SOURCE.replace('if (args.op === "add") {', 'if (args.op === "add") { await kv.put("last", args.by);');
		const outcome = await verifyOnly(forge, successor(v1, audit), { expectLive: v1.version, owned: [], changes: [] });
		assert.match(outcome.ok ? "" : outcome.reason, /\{"op":"add","by":20\}: state after the call \{"n":20\} became \{"last":20,"n":20\}/);
	});

	test("with a migration the before-state is migrated and only results are compared; unmigratable states are skipped", async () => {
		const tenths = `const n10 = (await kv.get("n10")) ?? 0;
if (args.op === "add") { await kv.put("n10", n10 + args.by * 10); return (n10 + args.by * 10) / 10; }
return n10 / 10;`;

		const migrate = 'const n = await kv.get("n"); if (n === null) throw new Error("no n"); await kv.put("n10", n * 10); await kv.delete("n");';
		const outcome = await verifyOnly(forge, successor(v1, tenths, { migrate }), { expectLive: v1.version, owned: [], changes: [] });
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
		assert.equal(outcome.report.replayed, 1, "the get call, whose before-state has n");
		assert.equal(outcome.report.replaySkipped, 1, "the first add ran on an empty state, which this migration refuses");
		assert.deepEqual(outcome.report.behaviourDiffs, [], "same results: the new state shape is not a difference");
	});

	test("only calls the live version ran are replayed", async () => {
		const other = successor(v1, `${COUNTER_SOURCE}\n// other`);
		await forge.runtime.call(other, "counter", { op: "add", by: 1 }, "real:3"); // recorded under another version
		const outcome = await verifyOnly(forge, successor(v1, `${CAPPED_GET}\n// other 2`), { expectLive: v1.version, owned: [], changes: ["get"] });
		assert.ok(outcome.ok);
		assert.equal(outcome.report.replayed, 2, "real:3 was not run by the live version");
	});

	test("without an enum parameter any difference needs [\"*\"]", async () => {
		const parameters = { type: "object", properties: { by: { type: "integer", minimum: 0, maximum: 9 } }, required: ["by"] };
		const source = "const n = (await kv.get('n')) ?? 0; await kv.put('n', n + args.by); return n + args.by;";
		const p1 = version("plain", source, { parameters, checks: [{ args: { by: 2 }, expect: 2 }] });
		assert.equal((await propose(forge, p1, { expectLive: null, owned: [], changes: [] })).ok, true);
		await forge.runtime.call(p1, "plain", { by: 5 }, "plain:1");
		await forge.runtime.call(p1, "plain", { by: 5 }, "plain:2");
		const capped = version("plain", source.replace("n + args.by); return n + args.by", "Math.min(n + args.by, 7)); return Math.min(n + args.by, 7)"), { parameters, checks: [{ args: { by: 2 }, expect: 2 }], parent: p1.version });
		const refused = await verifyOnly(forge, capped, { expectLive: p1.version, owned: [], changes: [] });
		assert.match(refused.ok ? "" : refused.reason, /replay: 1 of 2 .* \{"by":5\}: result 10 became 7/);
		assert.equal((await verifyOnly(forge, capped, { expectLive: p1.version, owned: [], changes: ["*"] })).ok, true);
	});
});
