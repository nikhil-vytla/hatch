// The two proof functions that read the document, the proof-demanding writes, and the three-step commit around them.
// One lineage of `counter` is grown through the real flow, so each test builds on the one before it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { name } from "@gdp-ts/core";
import { acceptVersion, commitVerified, dropPending, rollbackVersion, StaleError } from "../src/catalogue.ts";
import type { CellVersion } from "../src/cells.ts";
import { withCommittedCatalogue } from "../src/proofs/catalogue-committed.ts";
import { withAcceptedVersion } from "../src/proofs/cell-accepted.ts";
import { verifyCell } from "../src/proofs/cell-verified.ts";
import { boot, catalogueOf, context, COUNTER_SOURCE, type Forge, openForge, seedCounter, stagePending, successor, version } from "./support.ts";

let dir = "";

let forge: Forge;

let v1: CellVersion;

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "catalogue-"));
	forge = await openForge(dir);
});

after(async () => {
	await forge.close();
	rmSync(dir, { recursive: true, force: true });
});

const v2 = () => successor(v1, `${COUNTER_SOURCE}\n// v2`, { migrate: "await kv.put('seen', 1);" });

describe("withCommittedCatalogue", () => {
	test("an empty document reads as the empty catalogue, with a proof", async () => {
		const read = await withCommittedCatalogue(forge.harness, context, (catalogue, committed) => ({ value: catalogue.value, kind: committed.kind, frozen: Object.isFrozen(committed) }));
		assert.deepEqual(read, { value: { cells: {}, log: [] }, kind: "CatalogueCommitted", frozen: true });
	});

	test("it reads what is committed now, every time, and returns what the callback returns", async () => {
		v1 = await seedCounter(forge);
		const live = await withCommittedCatalogue(forge.harness, context, (catalogue) => catalogue.value.cells.counter.live);
		assert.equal(live, v1.version);
		assert.equal(await withCommittedCatalogue(forge.harness, context, async () => "async result"), "async result");
	});
});

describe("withAcceptedVersion", () => {
	test("it names only versions that were live, with a reason for every other case", async () => {
		const asked = (cell: string, wanted: string) => withCommittedCatalogue(forge.harness, context, (catalogue, committed) => withAcceptedVersion(catalogue, committed, cell, wanted, (target, accepted) => ({ version: target.value.version, kind: accepted.kind })));
		assert.deepEqual(await asked("counter", v1.version), { ok: true, value: { version: v1.version, kind: "CellAccepted" } });
		assert.deepEqual(await asked("nothing", v1.version), { ok: false, reason: "no cell named nothing" });
		assert.deepEqual(await asked("constructor", v1.version), { ok: false, reason: "no cell named constructor" });
		assert.deepEqual(await asked("counter", "counter@00000000"), { ok: false, reason: "no version counter@00000000 of counter" });
	});
});

describe("the three-step commit", () => {
	test("a candidate changed after it was verified is refused; the same one unchanged goes live with its migration marked", async () => {
		await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
			name(v2(), async (named) => {
				const verdict = await verifyCell(named, catalogue, committed, forge.runtime, { expectLive: v1.version, owned: [], changes: [] });
				assert.ok(verdict.ok, verdict.ok ? "" : verdict.reason);
				const original = named.value.source;
				named.value.source = "return 'evil';";
				await assert.rejects(commitVerified(forge.harness, context, forge.runtime, named, verdict.proof, v1.version, []), /changed after it was verified/);
				assert.equal((await catalogueOf(forge)).cells.counter.pending, null, "nothing was written");
				named.value.source = original;
				assert.deepEqual(await commitVerified(forge.harness, context, forge.runtime, named, verdict.proof, v1.version, []), { ok: true });
			}),
		);
		const entry = (await catalogueOf(forge)).cells.counter;
		assert.equal(entry.live, v2().version);
		assert.equal(entry.pending, null);
		assert.deepEqual(entry.history, [v1.version, v2().version]);
		assert.equal(await forge.runtime.migratedTo("counter"), v2().version);
	});

	test("the commit checks the live version again, authoritatively: a proof made against a live version that moved is stale", async () => {
		const v3 = successor(v2(), `${COUNTER_SOURCE}\n// v3`);

		const outcome = await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
			name(v3, async (named) => {
				const verdict = await verifyCell(named, catalogue, committed, forge.runtime, { expectLive: v2().version, owned: [], changes: [] });
				assert.ok(verdict.ok, verdict.ok ? "" : verdict.reason);
				// Someone else rolls the cell back after v3 was verified (cheap: no gate involved).
				await withAcceptedVersion(catalogue, committed, "counter", v1.version, (target, accepted) => forge.harness.commit((tx) => rollbackVersion(tx, target, accepted, v2().version), context));

				return commitVerified(forge.harness, context, forge.runtime, named, verdict.proof, v2().version, []);
			}),
		);

		assert.equal(outcome.ok, false);
		assert.equal(outcome.ok ? false : outcome.stale, true);
		assert.match(outcome.ok ? "" : outcome.reason, new RegExp(`you expected ${v2().version} to be live but the live version is ${v1.version}`));
		const entry = (await catalogue()).cells.counter;
		assert.equal(entry.pending, null);
		assert.equal(entry.live, v1.version);
	});

	test("rollback moves live to a version that was live, checks the expectation, and refuses while something is pending", async () => {
		const rollTo = (target: string, expectLive: string | null) =>
			withCommittedCatalogue(forge.harness, context, (catalogue, committed) => withAcceptedVersion(catalogue, committed, "counter", target, (candidate, accepted) => forge.harness.commit((tx) => rollbackVersion(tx, candidate, accepted, expectLive), context)));

		await assert.rejects(rollTo(v2().version, "counter@ffffffff"), (error: Error) => error instanceof StaleError && error.message.includes(`the live version is ${v1.version}`));
		assert.equal((await rollTo(v2().version, v1.version)).ok, true);
		assert.equal((await catalogue()).cells.counter.live, v2().version);
		assert.deepEqual((await catalogue()).cells.counter.history, [v1.version, v2().version, v1.version, v2().version]);
		assert.ok((await catalogue()).log.some((l) => l.event === `rolled counter back to ${v2().version}`));

		const v4 = successor(v2(), `${COUNTER_SOURCE}\n// v4`);
		await stagePending(forge, v4, { expectLive: v2().version, owned: [], changes: [] });
		await assert.rejects(rollTo(v1.version, v2().version), /is pending for counter/);
		const refused = await withCommittedCatalogue(forge.harness, context, (catalogue, committed) => withAcceptedVersion(catalogue, committed, "counter", v4.version, () => "unreachable"));
		assert.match(refused.ok ? "" : refused.reason, /was never live/, "a pending version has no CellAccepted proof");
	});

	test("one proposal at a time: a second acceptance while one is pending is refused; dropping it clears the way", async () => {
		const pending = (await catalogue()).cells.counter.pending;
		assert.ok(pending !== null);
		const rival = successor(v2(), `${COUNTER_SOURCE}\n// rival`);
		await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
			name(rival, async (named) => {
				const verdict = await verifyCell(named, catalogue, committed, forge.runtime, { expectLive: v2().version, owned: [], changes: [] });
				assert.ok(verdict.ok, verdict.ok ? "" : verdict.reason);
				await assert.rejects(forge.harness.commit((tx) => acceptVersion(tx, named, verdict.proof, v2().version), context), /is still pending for counter; one proposal at a time/);
			}),
		);
		assert.equal(await forge.harness.commit((tx) => dropPending(tx, "counter", pending, "test"), context), true);
		assert.equal(await forge.harness.commit((tx) => dropPending(tx, "counter", pending, "again"), context), false, "nothing left to drop");
		const entry = (await catalogue()).cells.counter;
		assert.equal(entry.pending, null);
		assert.equal(entry.versions[pending], undefined);
		assert.equal(entry.live, v2().version);
	});

	test("a migration that fails on the real state (it passed on the copy) drops the pending version and leaves live alone", async () => {
		const guarded = successor(v2(), `${COUNTER_SOURCE}\n// guarded`, { migrate: "if ((await kv.get('poison')) !== null) throw new Error('poisoned'); await kv.put('guarded', 1);" });

		const outcome = await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
			name(guarded, async (named) => {
				const verdict = await verifyCell(named, catalogue, committed, forge.runtime, { expectLive: v2().version, owned: [], changes: [] });
				assert.ok(verdict.ok, verdict.ok ? "" : verdict.reason);
				// The real state changes between verification and the migration.
				await forge.runtime.call(version("w", "await kv.put('poison', 1); return 1;"), "counter", {});

				return commitVerified(forge.harness, context, forge.runtime, named, verdict.proof, v2().version, []);
			}),
		);

		assert.equal(outcome.ok, false);
		assert.match(outcome.ok ? "" : outcome.reason, /the migration failed on the real state: script: poisoned/);
		const entry = (await catalogue()).cells.counter;
		assert.equal(entry.live, v2().version);
		assert.equal(entry.pending, null);
		assert.equal(entry.versions[guarded.version], undefined);
		assert.equal(await forge.runtime.migratedTo("counter"), v2().version, "no marker for the failed version");
		assert.ok((await catalogue()).log.some((l) => l.event.startsWith(`dropped ${guarded.version}: the migration failed`)));
	});
});

describe("installCells, through boot", () => {
	test("only live versions become tools; a cell whose first version is still pending is not installed", async () => {
		const pendingOnly = version("newbie", "return 1;", { checks: [{ args: {}, expect: 1 }] });
		await stagePending(forge, pendingOnly, { expectLive: null, owned: [], changes: [] });
		assert.equal((await catalogue()).cells.newbie.live, null);

		const registry = createRegistry();
		// Booting reconciles first, which drops `newbie` (its migration never ran) ...
		const booted = await boot(forge, registry);
		assert.equal(booted.cells.newbie, undefined);
		// ... so install what is live: counter.
		const tools = registry.snapshot().tools().map((t) => t.tool.name);
		assert.deepEqual(tools, ["counter"]);
		assert.match(registry.snapshot().tools()[0].tool.description, new RegExp(`\\(cell ${v2().version}\\)$`));
	});
});

const catalogue = () => catalogueOf(forge);
