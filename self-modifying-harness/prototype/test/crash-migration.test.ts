// Crash-safe migration: a process dies after a migration committed to the cell's SQLite and before the catalogue says the
// new version is live. Booting must roll the version forward exactly once, with the state migrated exactly once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { boot, catalogueOf, openForge, propose, stagePending, version } from "./support.ts";

const CHILD = join(import.meta.dirname, "fixtures", "crash-child.ts");

let dir = "";

before(() => {
	dir = mkdtempSync(join(tmpdir(), "crash-migration-"));
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function child(phase: string, env: Record<string, string>): number | null {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, dir, phase], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});

	if (result.status !== 0 && result.status !== 137) assert.fail(`child ${phase} failed: ${result.stderr}`);

	return result.status;
}

type CellState = { n: string | null; marker: string | null };

function readCell(): CellState {
	const db = new DatabaseSync(join(dir, "cells", "state", "counter.sqlite"));

	try {
		const n = db.prepare("SELECT v FROM kv WHERE k = 'n'").get();
		const marker = db.prepare("SELECT v FROM meta WHERE k = 'migrated_to'").get();

		return { n: n === undefined ? null : String(n.v), marker: marker === undefined ? null : String(marker.v) };
	} finally {
		db.close();
	}
}

test("a crash between the migration and the catalogue commit rolls forward exactly once", async () => {
	assert.equal(child("seed", {}), 0);
	const seeded = readCell();
	assert.equal(seeded.n, "2");
	assert.match(seeded.marker ?? "", /^counter@[0-9a-f]{8}$/, "the first version's migration (none) is recorded too");

	// The child dies with exit 137 inside commitVerified: after migrateTo, before activatePending.
	assert.equal(child("upgrade", { FORGE_CRASH_AFTER_MIGRATION: "counter" }), 137);

	const crashed = readCell();
	assert.equal(crashed.n, "20", "the migration committed once");
	assert.notEqual(crashed.marker, seeded.marker, "and its marker with it");

	const forge = await openForge(dir);

	try {
		const before = (await catalogueOf(forge)).cells.counter;
		assert.equal(before.live, seeded.marker, "the catalogue still says v1 is live");
		assert.equal(before.pending, crashed.marker, "with v2 pending");
		assert.equal(before.history.length, 1);

		const booted = await boot(forge);
		const entry = booted.cells.counter;
		assert.equal(entry.live, crashed.marker, "rolled forward to v2");
		assert.equal(entry.pending, null);
		assert.deepEqual(entry.history, [seeded.marker, crashed.marker], "v2 entered the history once");
		assert.equal(booted.log.filter((l) => l.event.includes("rolled forward after a crash")).length, 1);
		assert.deepEqual(readCell(), crashed, "reconciling did not migrate again");

		const again = await boot(forge);
		assert.deepEqual(again.cells.counter, entry, "a second boot has nothing left to do");
		assert.deepEqual(readCell(), crashed);
	} finally {
		await forge.close();
	}
});

test("a pending version whose migration never ran is dropped", async () => {
	const other = mkdtempSync(join(tmpdir(), "crash-drop-"));

	try {
		const forge = await openForge(other);

		try {
			const parameters = { type: "object", properties: { by: { type: "integer", minimum: 0, maximum: 5 } }, required: ["by"] };
			const first = { args: { by: 1 }, expect: 1 };
			const v1 = version("counter", "return args.by;", { parameters, checks: [first] });
			assert.equal((await propose(forge, v1, { expectLive: null, owned: [], changes: [] })).ok, true);

			// Step 1 only: the verified version is pending and the process dies before the migration.
			const v2 = version("counter", "return args.by + 1;", { parameters, checks: [{ args: { by: 1 }, expect: 2 }], retired: [first], parent: v1.version, migrate: "await kv.put('x', 1);" });
			await stagePending(forge, v2, { expectLive: v1.version, owned: [], changes: ["*"] });
			assert.equal((await catalogueOf(forge)).cells.counter.pending, v2.version);

			const booted = await boot(forge);
			assert.equal(booted.cells.counter.live, v1.version, "v1 stays live");
			assert.equal(booted.cells.counter.pending, null);
			assert.equal(booted.cells.counter.versions[v2.version], undefined, "the dropped version leaves no residue");
			assert.ok(booted.log.some((l) => l.event.startsWith(`dropped ${v2.version}`)));
			assert.equal(await forge.runtime.migratedTo("counter"), v1.version, "the migration never ran");
		} finally {
			await forge.close();
		}
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});
