// Shared by the proof tests and the crash-test child: a real harness over a SQLite session in a directory, and helpers to
// build candidates and drive the same verify, commit, install steps `cell_propose` does.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type JsonObject, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { name } from "@gdp-ts/core";
import { acceptVersion, type Committed, commitVerified, reinstallCells } from "../src/catalogue.ts";
import type { Catalogue } from "../src/catalogue-doc.ts";
import { CellsDoc } from "../src/catalogue-doc.ts";
import { CellRuntime, type CellVersion, type Check, versionId } from "../src/cells.ts";
import type { GateReport, Intent } from "../src/gate.ts";
import { withCommittedCatalogue } from "../src/proofs/catalogue-committed.ts";
import { verifyCell } from "../src/proofs/cell-verified.ts";
import { join } from "node:path";

export const context = BACKGROUND_CONTEXT;

export type Forge = { harness: Harness; runtime: CellRuntime; close: () => Promise<void> };

/** Open (or reopen) a harness and a runtime over `dir`. */
export async function openForge(dir: string, timeoutMs = 5_000): Promise<Forge> {
	const runtime = new CellRuntime(join(dir, "cells"), timeoutMs);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.sqlite")), { models: createModels(), registry: createRegistry() }, context);

	return {
		harness,
		runtime,
		close: async () => {
			await runtime.close();
			await harness.close(context);
		},
	};
}

/** A candidate with the id its source and migration give it. */
export function version(cell: string, source: string, extra: Partial<CellVersion> = {}): CellVersion {
	return {
		description: "",
		parameters: {},
		checks: [],
		retired: [],
		replay: "unsafe",
		...extra,
		version: versionId(cell, source, extra.migrate),
		source,
		invariants: extra.invariants ?? [],
	};
}

export type Proposed = { ok: true; report: GateReport } | { ok: false; reason: string; stale: boolean };

/** What `cell_propose` does after parsing: read the catalogue, name the candidate, verify it, commit it in three steps. */
export async function propose(forge: Forge, candidate: CellVersion, intent: Intent): Promise<Proposed> {
	return withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
		name(candidate, async (named): Promise<Proposed> => {
			const verdict = await verifyCell(named, catalogue, committed, forge.runtime, intent);

			if (!verdict.ok) return verdict;

			const done: Committed = await commitVerified(forge.harness, context, forge.runtime, named, verdict.proof, intent.expectLive, intent.owned);

			return done.ok ? { ok: true, report: verdict.report } : done;
		}),
	);
}

export async function catalogueOf(forge: Forge): Promise<Catalogue> {
	const stored: Catalogue | undefined = await forge.harness.snapshot(CellsDoc, context);

	return stored ?? { cells: {}, log: [] };
}

/** Boot-time reconciliation as `reinstallCells` does it, into `registry` (default: one nobody reads). */
export function boot(forge: Forge, registry: Registry = createRegistry()): Promise<Catalogue> {
	return reinstallCells(forge.harness, registry, forge.runtime, context, {});
}

/** Steps 1 of the accept only (verify, then commit as pending): the state a process that dies before its migration leaves. */
export async function stagePending(forge: Forge, candidate: CellVersion, intent: Intent): Promise<void> {
	await withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
		name(candidate, async (named) => {
			const verdict = await verifyCell(named, catalogue, committed, forge.runtime, intent);

			if (!verdict.ok) throw new Error(`rejected: ${verdict.reason}`);

			await forge.harness.commit((tx) => acceptVersion(tx, named, verdict.proof, intent.expectLive), context);
		}),
	);
}

/** A small enum-driven cell used across the gate tests. */
export const COUNTER_PARAMS: JsonObject = { type: "object", properties: { op: { enum: ["add", "get"] }, by: { type: "integer", minimum: 0, maximum: 100 } }, required: ["op"] };

export const COUNTER_SOURCE = `const n = (await kv.get("n")) ?? 0;
if (args.op === "add") { await kv.put("n", n + args.by); return n + args.by; }
return n;`;

export const COUNTER_CHECKS: Check[] = [
	{ args: { op: "get" }, expect: 0 },
	{ args: { op: "add", by: 2 }, expect: 2 },
	{ args: { op: "get" }, expect: 2 },
];

/** Accept a first version of `counter` through the real flow, so later tests have a live lineage to extend. */
export async function seedCounter(forge: Forge, extra: Partial<CellVersion> = {}): Promise<CellVersion> {
	const v1 = version("counter", COUNTER_SOURCE, { parameters: COUNTER_PARAMS, checks: COUNTER_CHECKS, ...extra });
	const done = await propose(forge, v1, { expectLive: null, owned: [], changes: [] });

	if (!done.ok) throw new Error(`seeding counter was rejected: ${done.reason}`);

	return v1;
}

/** A successor of `parent` with the counter's parameters and checks unless `extra` says otherwise. */
export function successor(parent: CellVersion, source: string, extra: Partial<CellVersion> = {}): CellVersion {
	return version("counter", source, { parameters: COUNTER_PARAMS, checks: COUNTER_CHECKS, parent: parent.version, ...extra });
}

/** Verify without committing: what `verifyCell` says about `candidate` against the catalogue as committed now. */
export async function verifyOnly(forge: Forge, candidate: CellVersion, intent: Intent): Promise<Proposed> {
	return withCommittedCatalogue(forge.harness, context, (catalogue, committed) =>
		name(candidate, async (named): Promise<Proposed> => {
			const verdict = await verifyCell(named, catalogue, committed, forge.runtime, intent);

			return verdict.ok ? { ok: true, report: verdict.report } : verdict;
		}),
	);
}
