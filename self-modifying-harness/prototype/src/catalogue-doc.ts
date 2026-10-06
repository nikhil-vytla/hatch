// The cell catalogue as a pi-durable session document: its type and its token, and nothing else.
//
// Who may touch it is the point of this file's neighbours: `proofs/catalogue-committed.ts` is the only code that reads it
// to mint a proof, and `catalogue.ts` is the only code that writes it (`acceptVersion`, `activatePending`, `dropPending`,
// `rollbackVersion`). The oxlint config restricts imports of `CellsDoc` to those files.
import { defineDoc } from "@earendil-works/pi-durable";
import type { CellVersion } from "./cells.ts";

export type CatalogueEntry = {
	live: string | null; // null while the first version of a new cell is still pending
	pending: string | null; // a verified version committed but not yet live: its migration may still have to run
	versions: Record<string, CellVersion>;
	history: string[]; // every version that was ever live, in order
};

export type Catalogue = {
	cells: Record<string, CatalogueEntry>;
	log: { at: string; event: string }[];
};

export function emptyCatalogue(): Catalogue {
	return { cells: {}, log: [] };
}

export const CellsDoc = defineDoc<Catalogue>({
	kind: "app.cells",
	version: 1,
	scope: "session",
	initial: emptyCatalogue,
});

/** `name@sha8` to `name`. Names cannot contain "@" (the gate checks the version id against the name). */
export function cellName(version: string): string {
	return version.split("@")[0];
}

/** Why a proposal made against `expectLive` is stale, or undefined when the live version is what the caller expected. */
export function staleReason(entry: CatalogueEntry | undefined, expectLive: string | null): string | undefined {
	const actual = entry?.live ?? null;

	if (actual === expectLive) return undefined;

	const expected = expectLive === null ? "no live version" : expectLive;
	const found = actual === null ? "none (the cell does not exist or has no live version)" : actual;

	return `stale: you expected ${expected} to be live but the live version is ${found}. Read it with cell_source and propose again`;
}

/** One cell's entry. A name like "constructor" is a legal cell name, so look up own properties only. */
export function entryOf(catalogue: Catalogue, name: string): CatalogueEntry | undefined {
	return Object.hasOwn(catalogue.cells, name) ? catalogue.cells[name] : undefined;
}
