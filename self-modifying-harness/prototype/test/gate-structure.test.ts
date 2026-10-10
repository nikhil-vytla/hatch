// verifyCell, the cheap structural parts of the gate: each rejection names its reason, and a good candidate gets a proof.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { JsonObject } from "@earendil-works/pi-durable";
import { name } from "@gdp-ts/core";
import type { CellVersion } from "../src/cells.ts";
import { FUZZ_EXECUTION_BUDGET } from "../src/gate.ts";
import { withCommittedCatalogue } from "../src/proofs/catalogue-committed.ts";
import { fingerprintOf, verifyCell } from "../src/proofs/cell-verified.ts";
import { COUNTER_CHECKS, COUNTER_SOURCE, context, type Forge, openForge, propose, seedCounter, successor, version } from "./support.ts";

let dir = "";

let forge: Forge;

let v1: CellVersion;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "gate-structure-"));
	forge = await openForge(dir);
	v1 = await seedCounter(forge);
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

const NEW = { owned: [], changes: [] };

async function reasonOf(candidate: CellVersion, expectLive: string | null, changes: string[] = []): Promise<string> {
	const outcome = await propose(forge, candidate, { expectLive, owned: [], changes });

	assert.equal(outcome.ok, false, "expected a rejection");

	return outcome.ok ? "" : outcome.reason;
}

describe("verifyCell mints a proof for a candidate that passed", () => {
	test("the proof is about the candidate, carries its fingerprint, and the report says what ran", async () => {
		await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
			name(successor(v1, `${COUNTER_SOURCE}\n// harmless`), async (candidate) => {
				const verdict = await verifyCell(candidate, catalogue, committed, forge.runtime, { expectLive: v1.version, ...NEW });
				assert.ok(verdict.ok, verdict.ok ? "" : verdict.reason);
				assert.equal(verdict.proof.kind, "CellVerified");
				assert.equal(verdict.proof.fingerprint, fingerprintOf(candidate.value));
				assert.ok(Object.isFrozen(verdict.proof));
				assert.equal(verdict.report.checks, 6, "v1's three checks plus its own three");
				assert.equal(verdict.report.replayed, 0, "no real calls yet");
				assert.ok(verdict.report.fuzz.ran > 0 && verdict.report.fuzz.executions <= FUZZ_EXECUTION_BUDGET + 3);
				assert.equal(verdict.report.fuzz.budget, FUZZ_EXECUTION_BUDGET);
			}),
		);
	});

	test("the fingerprint covers everything the gate looked at", () => {
		const base = successor(v1, COUNTER_SOURCE);

		const prints = new Set([
			fingerprintOf(base),
			fingerprintOf({ ...base, checks: [...base.checks, { args: { op: "get" }, expect: 0 }] }),
			fingerprintOf({ ...base, invariants: [{ name: "x", source: "return true;" }] }),
			fingerprintOf({ ...base, parameters: { type: "object" } }),
			fingerprintOf({ ...base, retired: [COUNTER_CHECKS[0]] }),
			fingerprintOf({ ...base, replay: "safe" }),
		]);

		assert.equal(prints.size, 6);
	});
});

describe("verifyCell refuses, with the reason", () => {
	test("a stale expectLive is rejected, naming the actual live version", async () => {
		const outcome = await propose(forge, successor(v1, `${COUNTER_SOURCE}\n// a`), { expectLive: "counter@00000000", ...NEW });
		assert.deepEqual(outcome.ok ? null : outcome.stale, true);
		assert.match(outcome.ok ? "" : outcome.reason, new RegExp(`stale: you expected counter@00000000 to be live but the live version is ${v1.version}`));
	});

	test("null means \"I expect it not to exist\", and is stale once it does", async () => {
		assert.match(await reasonOf(successor(v1, `${COUNTER_SOURCE}\n// b`), null), new RegExp(`expected no live version to be live but the live version is ${v1.version}`));
	});

	test("an expectLive for a cell that does not exist is stale too", async () => {
		const outcome = await propose(forge, version("ghost", "return 1;", { checks: [{ args: {}, expect: 1 }] }), { expectLive: "ghost@12345678", ...NEW });
		assert.match(outcome.ok ? "" : outcome.reason, /stale: .* the live version is none/);
	});

	test("a kernel name, an illegal name, a lying version id, no checks, a repeated version", async () => {
		const check = [{ args: {}, expect: 1 }];
		assert.match(await reasonOf(version("cell_propose", "return 1;", { checks: check }), null), /refused: "cell_propose" is not a name a cell may take/);
		assert.match(await reasonOf(version("Bad-Name", "return 1;", { checks: check }), null), /refused: "Bad-Name" is not a name/);
		assert.match(await reasonOf({ ...successor(v1, "return 2;"), version: "counter@00000000" }, v1.version), /not the id of this source and migration/);
		assert.match(await reasonOf(version("fresh", "return 1;"), null), /refused: a cell needs at least one check/);
		assert.match(await reasonOf({ ...successor(v1, COUNTER_SOURCE), version: v1.version, parent: v1.version }, v1.version), /already accepted; use cell_rollback/);
	});

	test("a cell named like an Object.prototype member is looked up as its own entry, not the prototype's", async () => {
		const outcome = await propose(forge, version("constructor", "return 1;", { checks: [{ args: {}, expect: 2 }] }), { expectLive: null, ...NEW });
		assert.match(outcome.ok ? "" : outcome.reason, /group 0 check 0 \{\}: expected 2, got 1/, "reached the checks as a new cell");
	});

	test("checks that never pass an enum member are rejected, naming the members", async () => {
		const onlyGet = [COUNTER_CHECKS[0]];
		assert.match(await reasonOf(successor(v1, `${COUNTER_SOURCE}\n// e`, { checks: onlyGet }), v1.version), /do not exercise every action: op="add" appear in none/);
		const two: JsonObject = { type: "object", properties: { op: { enum: ["add", "get"] }, mode: { enum: ["a", "b"] } }, required: ["op"] };
		assert.match(await reasonOf(successor(v1, `${COUNTER_SOURCE}\n// f`, { parameters: two }), v1.version), /mode="a", mode="b"/);
	});

	test("a model-proposed invariant may not share a name with a caller-owned one", async () => {
		const outcome = await propose(forge, successor(v1, `${COUNTER_SOURCE}\n// c`, { invariants: [{ name: "mine", source: "return true;" }] }), { expectLive: v1.version, owned: [{ name: "mine", source: "return true;" }], changes: [] });
		assert.match(outcome.ok ? "" : outcome.reason, /belongs to a caller-owned invariant/);
	});

	test("changes must name real actions, or be [\"*\"]", async () => {
		assert.match(await reasonOf(successor(v1, `${COUNTER_SOURCE}\n// d`), v1.version, ["delete"]), /changes names "delete", which is not one of the op values \["add","get"\]/);
		const plain = version("plain", "return 1;", { checks: [{ args: {}, expect: 1 }] });
		assert.match(await reasonOf(plain, null, ["add"]), /has no enum parameter; use \["\*"\]/);
	});
});
