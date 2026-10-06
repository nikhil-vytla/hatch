// Trusted module: the fact "version C was accepted earlier": it passed the gate and was live at some point.
//
// A rollback re-uses an already-accepted version, so it has no candidate to verify and cannot be asked for a `CellVerified`.
// It gets its own narrow proof instead. The rule is the document's own history: acceptVersion stages a version as pending,
// and only `activatePending` appends to `history`, so a version that is in `history` was verified and made live. A version
// that is merely pending, dropped, unknown or invented by the caller has no proof.
import { defineProof, name, type Named, type Proof } from "@gdp-ts/core";
import { type Catalogue, entryOf } from "../catalogue-doc.ts";
import type { CellVersion } from "../cells.ts";
import type { CatalogueCommitted } from "./catalogue-committed.ts";

const CellAccepted = defineProof("CellAccepted");

/** The version named `C` is in its cell's history in the committed catalogue. */
export interface CellAccepted<C> extends Proof<"CellAccepted", [C]> {}

export type Acceptance<R> = { ok: true; value: R } | { ok: false; reason: string };

/** Hand `k` the stored version of `cell` with id `version`, named, with the proof that it was accepted before. */
export async function withAcceptedVersion<K, R>(
	catalogue: Named<K, Catalogue>,
	_committed: CatalogueCommitted<K>,
	cell: string,
	version: string,
	k: <C>(candidate: Named<C, CellVersion>, accepted: CellAccepted<C>) => R | Promise<R>,
): Promise<Acceptance<R>> {
	const entry = entryOf(catalogue.value, cell);

	if (entry === undefined) return { ok: false, reason: `no cell named ${cell}` };

	const stored = entry.versions[version];

	if (stored === undefined) return { ok: false, reason: `no version ${version} of ${cell}` };

	if (!entry.history.includes(version)) return { ok: false, reason: `${version} was never live (it is pending or was dropped), so it cannot be rolled back to` };

	return { ok: true, value: await name(stored, (candidate) => k(candidate, CellAccepted.prove(candidate))) };
}
