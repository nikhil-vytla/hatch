// verifyCell, invariants and schema fuzz: caller-owned and model-proposed invariants, the ratchet on the latter, and the
// fuzz verdicts (a hang or a regression blocks; a violation the live version also has is advice).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CellVersion, Invariant } from "../src/cells.ts";
import { FUZZ_EXECUTION_BUDGET, FUZZ_INPUTS } from "../src/gate.ts";
import { type Forge, openForge, propose, verifyOnly, version } from "./support.ts";

const PARAMETERS = { type: "object", properties: { op: { enum: ["add", "get"] }, by: { type: "integer", minimum: -1, maximum: 1 } }, required: ["op", "by"] };

const CHECKS = [{ args: { op: "get", by: 1 }, expect: 0 }, { args: { op: "add", by: 1 }, expect: 1 }, { args: { op: "get", by: 1 }, expect: 1 }];

const VALIDATING = `const n = (await kv.get("n")) ?? 0;
if (args.op === "add") { if (args.by < 0) throw new Error("by must not be negative"); await kv.put("n", n + args.by); return n + args.by; }
return n;`;

const NON_NEGATIVE: Invariant = { name: "n is never negative", source: "return ((await kv.get('n')) ?? 0) >= 0;" };

const INTEGER: Invariant = { name: "n is an integer", source: "return Number.isInteger((await kv.get('n')) ?? 0);" };

let dir = "";

let forge: Forge;

let ledger: CellVersion;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "gate-invariants-"));
	forge = await openForge(dir, 1_500);
	ledger = version("ledger", VALIDATING, { parameters: PARAMETERS, checks: CHECKS, invariants: [INTEGER] });
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

const owned = [NON_NEGATIVE];

function next(source: string, extra: Partial<CellVersion> = {}): CellVersion {
	return version("ledger", source, { parameters: PARAMETERS, checks: CHECKS, parent: ledger.version, invariants: [INTEGER], ...extra });
}

async function reasonOf(candidate: CellVersion): Promise<string> {
	const outcome = await verifyOnly(forge, candidate, { expectLive: ledger.version, owned, changes: [] });
	assert.equal(outcome.ok, false, "expected a rejection");

	return outcome.ok ? "" : outcome.reason;
}

describe("invariants through the gate", () => {
	test("a version with a model-proposed invariant is accepted; the fuzz cost stays within its budget", async () => {
		const outcome = await propose(forge, ledger, { expectLive: null, owned, changes: [] });
		assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
		assert.deepEqual(outcome.report.advisories, [], "validation turns the bad inputs away before they can break anything");
		assert.ok(outcome.report.fuzz.ran < FUZZ_INPUTS, "two invariant lists make each input cost three executions, so fewer than 40 inputs fit");
		assert.ok(outcome.report.fuzz.executions >= FUZZ_EXECUTION_BUDGET && outcome.report.fuzz.executions <= FUZZ_EXECUTION_BUDGET + 3);
	});

	test("model-proposed invariants ratchet: a later version may add but never drop", async () => {
		assert.match(await reasonOf(next(`${VALIDATING}\n// a`, { invariants: [] })), /invariant\(s\) "n is an integer" of earlier versions were dropped/);
		assert.match(await reasonOf(next(`${VALIDATING}\n// b`, { invariants: [{ ...INTEGER, source: "return true;" }] })), /"n is an integer" of earlier versions were dropped/, "a weakened body is a different invariant");
		const bigger = await verifyOnly(forge, next(`${VALIDATING}\n// c`, { invariants: [INTEGER, { name: "n is small", source: "return ((await kv.get('n')) ?? 0) < 1000;" }] }), { expectLive: ledger.version, owned, changes: [] });
		assert.ok(bigger.ok, bigger.ok ? "" : bigger.reason);
	});

	test("a model-proposed invariant is enforced on every check", async () => {
		const never: Invariant = { name: "never holds", source: "return false;" };
		assert.match(await reasonOf(next(`${VALIDATING}\n// d`, { invariants: [INTEGER, never] })), /broke invariant "never holds"/);
	});

	test("a caller-owned invariant is enforced on the candidate's own checks, however the model words them", async () => {
		const careless = VALIDATING.replace('if (args.by < 0) throw new Error("by must not be negative"); ', "");
		const reason = await reasonOf(next(careless, { checks: [...CHECKS, { args: { op: "add", by: -1 }, expect: 0 }, { args: { op: "add", by: -1 }, expect: -1 }] }));
		assert.match(reason, /group 1 check 4 .* broke invariant "n is never negative"/);
	});

	test("fuzz blocks a regression: an input the live version turns away now breaks an invariant", async () => {
		const lax = VALIDATING.replace("args.by < 0", "args.by < -1");
		const reason = await reasonOf(next(lax));
		assert.match(reason, new RegExp(`fuzz: input \\{"op":"add","by":-1\\} breaks invariant "n is never negative", which the live version ${ledger.version} does not on that input: a regression`));
	});

	test("fuzz blocks a hang the schema allows, with the timeout in the reason", async () => {
		const hanging = VALIDATING.replace('throw new Error("by must not be negative");', "while (true) {}");
		assert.match(await reasonOf(next(hanging)), /fuzz: input \{"op":"add","by":-1\} did not finish within 1500 ms/);
	});

	test("a violation the live version also has is advice, not a block; on a new cell it is advice too", async () => {
		const loose = `const n = (await kv.get("n")) ?? 0;
if (args.op === "add") { await kv.put("n", n + args.by); return n + args.by; }
return n;`;

		const first = version("loose", loose, { parameters: PARAMETERS, checks: CHECKS });
		const fresh = await propose(forge, first, { expectLive: null, owned, changes: [] });
		assert.ok(fresh.ok, fresh.ok ? "" : fresh.reason);
		assert.match(fresh.report.advisories[0], /fuzz: \d+ of \d+ generated inputs break invariant "n is never negative" \(first: \{"op":"add","by":-1\}\); a new cell has no earlier version to compare with\. Not blocking\./);

		const second = version("loose", `${loose}\n// second`, { parameters: PARAMETERS, checks: CHECKS, parent: first.version });
		const again = await verifyOnly(forge, second, { expectLive: first.version, owned, changes: [] });
		assert.ok(again.ok, again.ok ? "" : again.reason);
		assert.match(again.report.advisories[0], new RegExp(`the live version ${first.version} breaks it too\\. Not blocking`));
	});
});
