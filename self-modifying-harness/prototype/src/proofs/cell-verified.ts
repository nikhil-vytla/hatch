// Trusted module: the fact "candidate version C passed the full gate".
//
// `verifyCell` runs the whole gate (gate.ts) against the committed lineage and, only if every part holds, returns a proof
// together with the gate's report. A rejection carries its reason. `acceptVersion` is the only function that writes a
// version into the catalog, and it demands this proof about the very candidate it writes.
import { createHash } from "node:crypto";
import { defineProof, type Named, type Proof } from "@gdp-ts/core";
import { type Catalogue, cellName, entryOf } from "../catalogue-doc.ts";
import type { CellRuntime, CellVersion } from "../cells.ts";
import { type GateReport, type Intent, runGate } from "../gate.ts";
import type { CatalogueCommitted } from "./catalogue-committed.ts";

const CellVerified = defineProof("CellVerified");

/**
 * Candidate `C` passed the gate. `fingerprint` is a hash of everything the gate looked at, so a candidate that was
 * changed after verification no longer matches the proof it is presented with.
 */
export interface CellVerified<C> extends Proof<"CellVerified", [C]> {
	readonly fingerprint: string;
}

export type Verification<C> =
	| { ok: true; proof: CellVerified<C>; report: GateReport }
	| { ok: false; reason: string; stale: boolean };

/** A hash of the JSON text of a candidate: source, migration, parameters, checks, retirements and invariants. */
export function fingerprintOfJson(json: string): string {
	return createHash("sha256").update(json).digest("hex");
}

export function fingerprintOf(candidate: CellVersion): string {
	return fingerprintOfJson(JSON.stringify(candidate));
}

/**
 * Run the whole gate on `candidate` against the lineage in `catalogue`. The lineage must be the committed one, which is
 * why the catalog comes with its `CatalogueCommitted` proof: a ratchet taken from a catalog the caller assembled would
 * owe nothing. `intent.expectLive` is compared with the lineage's live version first (cheap); the commit checks it again.
 */
export async function verifyCell<C, K>(
	candidate: Named<C, CellVersion>,
	catalogue: Named<K, Catalogue>,
	_committed: CatalogueCommitted<K>,
	runtime: CellRuntime,
	intent: Intent,
): Promise<Verification<C>> {
	const version = candidate.value;
	const outcome = await runGate(runtime, version, entryOf(catalogue.value, cellName(version.version)), intent);

	if (!outcome.ok) return outcome;

	const proof: CellVerified<C> = Object.freeze({ ...CellVerified.prove(candidate), fingerprint: fingerprintOf(version) });

	return { ok: true, proof, report: outcome.report };
}
