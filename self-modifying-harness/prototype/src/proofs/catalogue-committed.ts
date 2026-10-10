// Trusted module: the fact "catalog K is what is committed in the pi-durable session document".
//
// Installing agent code into the registry is the one step that makes unverified code live, so `installCells` demands this
// proof. The only way to get it is to let this module read the document itself; a catalog assembled by hand, kept from
// before, or taken from a tool argument has no name this proof is about.
import { defineProof, name, type Named, type Proof } from "@gdp-ts/core";
import type { Context } from "@earendil-works/chord";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { type Catalogue, CellsDoc, emptyCatalogue } from "../catalogue-doc.ts";

const CatalogueCommitted = defineProof("CatalogueCommitted");

/** The catalog named `K` is what the session document held when it was read. */
export interface CatalogueCommitted<K> extends Proof<"CatalogueCommitted", [K]> {}

/**
 * Read the committed catalog and hand it to `k`, named, with the proof. Reading again after a commit gives the proof
 * for what that commit stored (an extension is then installed from the document, never from the value a transaction
 * returned). A document that does not exist yet reads as the empty catalog, which is what it would be created as.
 * Names cannot leave `k`, so what it returns is plain data.
 */
export async function withCommittedCatalogue<R>(
	reader: DocumentReader,
	context: Context,
	k: <K>(catalogue: Named<K, Catalogue>, committed: CatalogueCommitted<K>) => R | Promise<R>,
): Promise<R> {
	const stored: Catalogue | undefined = await reader.snapshot(CellsDoc, context);

	return name(stored ?? emptyCatalogue(), (catalogue) => k(catalogue, CatalogueCommitted.prove(catalogue)));
}
