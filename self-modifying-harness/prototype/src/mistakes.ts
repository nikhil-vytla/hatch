// Type-checked, never run. Each `@ts-expect-error` line is a mistake the proofs make a compile error; if one ever
// compiles, `tsc` fails here because the directive is then unused. The line below each directive must stay the only
// thing wrong with it.
import type { Context } from "@earendil-works/chord";
import type { DocumentReader, Registry, Tx } from "@earendil-works/pi-durable";
import { name, type Named } from "@gdp-ts/core";
import { acceptVersion, installCells, rollbackVersion } from "./catalogue.ts";
import type { Catalogue } from "./catalogue-doc.ts";
import type { CellRuntime, CellVersion } from "./cells.ts";
import type { Intent } from "./gate.ts";
import { withCommittedCatalogue } from "./proofs/catalogue-committed.ts";
import { withAcceptedVersion } from "./proofs/cell-accepted.ts";
import { type CellVerified, verifyCell } from "./proofs/cell-verified.ts";

declare const tx: Tx;

declare const registry: Registry;

declare const runtime: CellRuntime;

declare const context: Context;

declare const reader: DocumentReader;

declare const intent: Intent;

declare const version: CellVersion;

declare const handMade: Catalogue;

export async function mistakes(): Promise<void> {
	await withCommittedCatalogue(reader, context, async (catalogue, committed) => {
		await installCells(registry, catalogue, committed, runtime, {}); // the honest call: read from the document, proved

		// 1. Installing a catalogue that was not read from the document.
		// @ts-expect-error a raw catalogue is not a Named one, so no proof is about it
		installCells(registry, handMade, committed, runtime, {});

		await name(handMade, async (mine) => {
			// @ts-expect-error the proof is about the committed catalogue, not this one
			installCells(registry, mine, committed, runtime, {});
		});

		// @ts-expect-error installing agent code without any proof
		installCells(registry, catalogue, undefined, runtime, {});

		await name(version, version, async (a, b) => {
			const checkedA = await verifyCell(a, catalogue, committed, runtime, intent);

			if (!checkedA.ok) return;

			await acceptVersion(tx, a, checkedA.proof, null); // the honest call

			// 2. Accepting a candidate that was never verified.
			// @ts-expect-error no proof at all
			await acceptVersion(tx, a);

			// @ts-expect-error the whole verification result may be a rejection; only its proof counts
			await acceptVersion(tx, a, checkedA, null);

			const checkedMaybe = await verifyCell(b, catalogue, committed, runtime, intent);

			// @ts-expect-error a rejection has no proof to pass
			await acceptVersion(tx, b, checkedMaybe.proof, null);

			// 3. Using a proof about a different candidate.
			// @ts-expect-error CellVerified about a, not b
			await acceptVersion(tx, b, checkedA.proof, null);

			// 4. Passing a raw CellVersion instead of a Named one.
			// @ts-expect-error the candidate must be named so the proof can be about it
			await acceptVersion(tx, version, checkedA.proof, null);

			// A rollback needs its own proof: that the version was accepted before. A gate proof is not that.
			// @ts-expect-error CellVerified is not CellAccepted
			await rollbackVersion(tx, a, checkedA.proof, null);

			// The compare-and-swap expectation is a required argument.
			// @ts-expect-error acceptVersion needs to know which live version the proposer expected
			await acceptVersion(tx, a, checkedA.proof);

			// Same-kind proofs are about names, so a proof about a cannot be built for b.
			await name(version, async <C>(c: Named<C, CellVersion>) => {
				// @ts-expect-error a proof cannot be assembled by hand
				const forged: CellVerified<C> = { kind: "CellVerified", fingerprint: "x" };
				void forged;
				void c;
			});
		});

		const accepted = await withAcceptedVersion(catalogue, committed, "coffee", "coffee@abcdef01", async (target, proof) => {
			await rollbackVersion(tx, target, proof, null); // the honest rollback

			await name(version, async (other) => {
				// @ts-expect-error CellAccepted about target, not other
				await rollbackVersion(tx, other, proof, null);
			});

			// @ts-expect-error rolling back with no proof that the version was ever live
			await rollbackVersion(tx, target);
		});

		void accepted;
	});

	// @ts-expect-error a proof or name returned out of the callback would outlive the read it is about
	await withCommittedCatalogue(reader, context, (_catalogue, committed) => committed);

	// @ts-expect-error a named value cannot escape its name() callback
	name(version, (candidate) => candidate);
}
