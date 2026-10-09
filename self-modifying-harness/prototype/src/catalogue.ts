// The only code that changes what the catalog says is live, and the only code that puts agent code into the registry.
//
// Two sensitive operations, each behind a proof (src/proofs/):
//   - writing a version into the catalog document: `acceptVersion` demands `CellVerified<C>` about that candidate;
//     moving `live` back to an earlier version: `rollbackVersion` demands `CellAccepted<C>`;
//   - installing code into the registry: `installCells` demands `CatalogueCommitted<K>` about the catalog it installs.
// `activatePending` and `dropPending` need no proof of their own: their only input is the `pending` slot that
// `acceptVersion` filled, so they can promote or discard nothing that was not verified.
//
// A new version goes live in three steps, each atomic, so a crash between any two leaves a state `reconcile` can resolve:
//   1. `acceptVersion`  commits the verified version into the document as `pending` (live is unchanged);
//   2. `runtime.migrateTo` runs the migration and writes `migrated_to = <version>` in ONE cell-SQLite transaction;
//   3. `activatePending` commits `live = version` and clears `pending`.
// On boot, `reconcile` rolls a pending version forward if the cell's marker names it (the migration committed), and drops
// it otherwise (the migration never happened).
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type JsonObject, type Registry, type Session, type Tx } from "@earendil-works/pi-durable";
import type { Named } from "@gdp-ts/core";
import { type Catalogue, CellsDoc, cellName, entryOf, staleReason } from "./catalogue-doc.ts";
import type { CellRuntime, CellVersion, Invariant } from "./cells.ts";
import { type CatalogueCommitted, withCommittedCatalogue } from "./proofs/catalogue-committed.ts";
import type { CellAccepted } from "./proofs/cell-accepted.ts";
import { type CellVerified, fingerprintOfJson } from "./proofs/cell-verified.ts";

/** Invariants the caller owns, by cell name. The model cannot change them. */
export type CallerInvariants = Record<string, Invariant[]>;

/** The live version moved between the proposal and the commit. */
export class StaleError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "StaleError";
	}
}

export function ownedInvariants(owned: CallerInvariants, cell: string): Invariant[] {
	return Object.hasOwn(owned, cell) ? owned[cell] : [];
}

const now = (): string => new Date().toISOString();

/**
 * Step 1. Write a verified candidate into the document as the cell's pending version. Inside the transaction (the
 * authoritative check) the live version must still be `expectLive`, the candidate must be the one that was verified, a
 * successor of `expectLive`, and nothing else may be pending for the cell. Returns the stored copy: the exact bytes that
 * were fingerprinted, which is what the later steps must run.
 */
export async function acceptVersion<C>(tx: Tx, candidate: Named<C, CellVersion>, verified: CellVerified<C>, expectLive: string | null): Promise<CellVersion> {
	const json = JSON.stringify(candidate.value); // documents hold strict JSON: no undefined; and this text is what is checked and stored

	if (fingerprintOfJson(json) !== verified.fingerprint) throw new Error(`${candidate.value.version} changed after it was verified`);

	const version: CellVersion = JSON.parse(json);

	const cell = cellName(version.version);
	const doc = await tx.doc(CellsDoc);
	const found = entryOf(doc, cell);
	const stale = staleReason(found, expectLive);

	if (stale !== undefined) throw new StaleError(stale);

	if ((version.parent ?? null) !== expectLive) throw new Error(`${version.version} was verified as a successor of ${version.parent ?? "nothing"}, not of ${expectLive ?? "nothing"}`);

	if (found !== undefined && found.pending !== null) throw new Error(`${found.pending} is still pending for ${cell}; one proposal at a time`);

	if (found !== undefined && found.versions[version.version] !== undefined) throw new Error(`${version.version} was already accepted`);

	// Assign first, then edit through the draft: a plain object kept from before the assignment is not the draft.
	if (found === undefined) doc.cells[cell] = { live: null, pending: null, versions: {}, history: [] };

	const entry = doc.cells[cell];
	entry.versions[version.version] = JSON.parse(json);
	entry.pending = version.version;
	doc.log.push({ at: now(), event: `verified ${version.version}, pending${version.migrate === undefined ? "" : " its migration"}` });

	return version;
}

/** Step 3. Make the cell's pending version live. It can promote nothing but what `acceptVersion` left pending. */
export async function activatePending(tx: Tx, cell: string, version: string, expectLive: string | null, via: "commit" | "recovery"): Promise<void> {
	const doc = await tx.doc(CellsDoc);
	const found = entryOf(doc, cell);

	if (found === undefined || found.pending !== version) throw new Error(`${version} is not pending for ${cell}`);

	const stale = staleReason(found, expectLive);

	if (stale !== undefined) throw new StaleError(stale);

	const entry = doc.cells[cell];
	entry.live = version;
	entry.history.push(version);
	entry.pending = null;
	const retired = entry.versions[version].retired.length;
	doc.log.push({ at: now(), event: `accepted ${version}${retired > 0 ? `, retiring ${retired} check(s)` : ""}${via === "recovery" ? " (rolled forward after a crash)" : ""}` });
}

/** Discard a pending version that never became live, with the reason. A cell that never existed leaves no entry. */
export async function dropPending(tx: Tx, cell: string, version: string, reason: string): Promise<boolean> {
	const doc = await tx.doc(CellsDoc);
	const found = entryOf(doc, cell);

	if (found === undefined || found.pending !== version) return false;

	const entry = doc.cells[cell];
	entry.pending = null;

	if (!entry.history.includes(version)) delete entry.versions[version];

	if (entry.live === null && entry.history.length === 0) delete doc.cells[cell];

	doc.log.push({ at: now(), event: `dropped ${version}: ${reason}` });

	return true;
}

/**
 * Make an earlier accepted version live again. It adds no version to the catalog, so it needs no gate; the proof says the
 * version was accepted before. The cell's state is not rolled back, and no migration runs.
 */
export async function rollbackVersion<C>(tx: Tx, candidate: Named<C, CellVersion>, _accepted: CellAccepted<C>, expectLive: string | null): Promise<void> {
	const target = candidate.value.version;
	const cell = cellName(target);
	const doc = await tx.doc(CellsDoc);
	const found = entryOf(doc, cell);
	const stale = staleReason(found, expectLive);

	if (stale !== undefined) throw new StaleError(stale);

	if (found === undefined || !found.history.includes(target)) throw new Error(`${target} was never live in ${cell}`);

	if (found.pending !== null) throw new Error(`${found.pending} is pending for ${cell}; wait for it to settle before rolling back`);

	const entry = doc.cells[cell];
	entry.live = target;
	entry.history.push(target);
	doc.log.push({ at: now(), event: `rolled ${cell} back to ${target}` });
}

/** Record why a proposal was turned down. The log is the only part of the document a rejection touches. */
export async function recordRejection(tx: Tx, version: string, reason: string): Promise<void> {
	(await tx.doc(CellsDoc)).log.push({ at: now(), event: `rejected ${version}: ${reason}` });
}

export type Committed = { ok: true } | { ok: false; reason: string; stale: boolean };

/**
 * Steps 1 to 3 for a verified candidate. A stale live version is reported, not thrown. If the migration fails on the real
 * state (it passed on a copy, so the state moved), the pending version is dropped and the live version stays.
 */
export async function commitVerified<C>(
	committer: Pick<Session, "commit">,
	context: Context,
	runtime: CellRuntime,
	candidate: Named<C, CellVersion>,
	verified: CellVerified<C>,
	expectLive: string | null,
	owned: Invariant[],
): Promise<Committed> {
	const cell = cellName(candidate.value.version);
	let version: CellVersion;

	try {
		// From here on, only the stored copy is used: a candidate mutated after its verification changes nothing.
		version = await committer.commit((tx) => acceptVersion(tx, candidate, verified, expectLive), context);
	} catch (error) {
		if (error instanceof StaleError) return { ok: false, reason: error.message, stale: true };

		throw error;
	}

	try {
		await runtime.migrateTo(cell, version, { owned, proposed: version.invariants });
	} catch (error) {
		const reason = `the migration failed on the real state: ${error instanceof Error ? error.message : String(error)}`;
		await committer.commit((tx) => dropPending(tx, cell, version.version, reason), context);

		return { ok: false, reason, stale: false };
	}

	// Crash injection for the demo and the tests: the migration has committed, the catalog does not know yet.
	if (process.env.FORGE_CRASH_AFTER_MIGRATION === cell) process.exit(137);

	try {
		await committer.commit((tx) => activatePending(tx, cell, version.version, expectLive, "commit"), context);
	} catch (error) {
		if (error instanceof StaleError) return { ok: false, reason: error.message, stale: true };

		throw error;
	}

	return { ok: true };
}

/**
 * Boot-time recovery of a crash between the steps above. A pending version whose migration committed (the cell's marker
 * names it) is rolled forward; any other pending version is dropped. Returns what it did, for the log and the demo.
 */
export async function reconcile(session: Pick<Session, "commit" | "snapshot">, context: Context, runtime: CellRuntime): Promise<string[]> {
	const stored: Catalogue | undefined = await session.snapshot(CellsDoc, context);
	const actions: string[] = [];

	for (const [cell, entry] of Object.entries(stored?.cells ?? {})) {
		const pending = entry.pending;

		if (pending === null) continue;

		if ((await runtime.migratedTo(cell)) === pending) {
			await session.commit((tx) => activatePending(tx, cell, pending, entry.live, "recovery"), context);
			actions.push(`rolled forward ${pending}`);
		} else {
			await session.commit((tx) => dropPending(tx, cell, pending, "its migration never ran (the process died before it)"), context);
			actions.push(`dropped ${pending}`);
		}
	}

	return actions;
}

/** Whether tool calls are exactly-once (the call id is recorded with the cell's effects) and so always replay-safe. */
const exactlyOnce = process.env.FORGE_EXACTLY_ONCE !== "0";

// The agent-written tools: one per live cell. Not exported: `installCells` is the only way to put one in the registry.
function cellsExtension(catalogue: Catalogue, runtime: CellRuntime, owned: CallerInvariants) {
	const tools = Object.entries(catalogue.cells).flatMap(([cell, entry]) => {
		if (entry.live === null) return [];

		const live = entry.versions[entry.live];

		return [
			defineTool({
				name: cell,
				description: `${live.description} (cell ${live.version})`,
				parameters: Type.Unsafe<JsonObject>(live.parameters),
				// Every cell is replay-safe when calls are exactly-once (cells.ts records the call id with the effects).
				replay: exactlyOnce ? "safe" : live.replay,
				execute: async (args, api) => {
					const invariants = { owned: ownedInvariants(owned, cell), proposed: live.invariants };
					const value = await runtime.call(live, cell, args, exactlyOnce ? `${api.taskId}:${api.callId}` : undefined, invariants);

					// Demo only: die after the cell's own SQLite transaction committed but before pi-durable stored the result,
					// the window in which a rerun would apply the effect twice.
					if (process.env.FORGE_CRASH_AFTER_CELL === cell) process.exit(137);

					return { content: [{ type: "text", text: JSON.stringify(value) }], details: { version: live.version } };
				},
			}),
		];
	});

	return defineExtension({ name: "cells", tools });
}

/** Install the live versions of a committed catalog as tools. The proof is about this catalog, not another. */
export function installCells<K>(registry: Registry, catalogue: Named<K, Catalogue>, _committed: CatalogueCommitted<K>, runtime: CellRuntime, owned: CallerInvariants): void {
	registry.install(cellsExtension(catalogue.value, runtime, owned));
}

/**
 * Hold the "cells" slot in the install order (before the kernel, so a cell can never shadow a kernel tool) before the
 * harness exists to read the document from. It carries no agent code: no tools at all.
 */
export function reserveCellsSlot(registry: Registry): void {
	registry.install(defineExtension({ name: "cells", tools: [] }));
}

/** Read the document again and install what it commits. Used after every commit that changes what is live. */
export async function refreshCells(session: Pick<Session, "snapshot" | "snapshotAsOf">, context: Context, registry: Registry, runtime: CellRuntime, owned: CallerInvariants): Promise<void> {
	await withCommittedCatalogue(session, context, (catalogue, committed) => installCells(registry, catalogue, committed, runtime, owned));
}

/** Boot: reconcile a crash between the accept steps, then install the committed catalog. Returns it. */
export async function reinstallCells(session: Pick<Session, "commit" | "snapshot" | "snapshotAsOf">, registry: Registry, runtime: CellRuntime, context: Context, owned: CallerInvariants): Promise<Catalogue> {
	await reconcile(session, context, runtime);

	return withCommittedCatalogue(session, context, (catalogue, committed) => {
		installCells(registry, catalogue, committed, runtime, owned);

		return catalogue.value;
	});
}
