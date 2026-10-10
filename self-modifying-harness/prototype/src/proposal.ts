// The boundary of `cell_propose`: the tool's arguments arrive from pi-durable as the schema's static type, and are parsed
// here, once, into a `Proposal`. Nothing past this file sees raw tool arguments.
import { type Static, Type } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Catalogue } from "./catalogue-doc.ts";
import { entryOf, fullVersion } from "./catalogue-doc.ts";
import { type CellVersion, type Check, type Invariant, versionId } from "./cells.ts";
import { KERNEL_TOOLS, NAME } from "./gate.ts";

const Json = Type.Unsafe<JsonValue>({});

const CheckSchema = Type.Object({ args: Json, expect: Json });

const InvariantSchema = Type.Object({ name: Type.String(), source: Type.String() });

/** A live version the proposer expects, or null: "I expect this cell not to exist". */
export const ExpectLive = Type.Union([Type.String(), Type.Null()]);

export const ProposeParameters = Type.Object({
	name: Type.String(),
	description: Type.String(),
	parameters: Type.Unsafe<JsonObject>({ type: "object" }),
	source: Type.String(),
	checks: Type.Array(CheckSchema),
	retire: Type.Optional(Type.Array(CheckSchema)),
	migrate: Type.Optional(Type.String()),
	pure: Type.Optional(Type.Boolean()),
	invariants: Type.Optional(Type.Array(InvariantSchema)),
	changes: Type.Optional(Type.Array(Type.String())),
	expectLive: ExpectLive,
});

export type RawProposal = Static<typeof ProposeParameters>;

export type Proposal = {
	cell: string;
	description: string;
	parameters: JsonObject;
	source: string;
	checks: Check[];
	retire: Check[];
	migrate: string | undefined;
	pure: boolean;
	invariants: Invariant[];
	changes: string[];
	expectLive: string | null;
};

/** Parse tool arguments. A proposal that cannot even be a candidate is refused here, with the reason as the error. */
export function parseProposal(raw: RawProposal): Proposal {
	if (!NAME.test(raw.name) || KERNEL_TOOLS.has(raw.name)) throw new Error(`refused: "${raw.name}" is not a name a cell may take`);

	if (raw.checks.length === 0) throw new Error("refused: a cell needs at least one check");

	const invariants = raw.invariants ?? [];
	const names = new Set(invariants.map((i) => i.name));

	if (invariants.some((i) => i.name.trim() === "" || i.source.trim() === "")) throw new Error("refused: an invariant needs a name and a body");

	if (names.size !== invariants.length) throw new Error("refused: two invariants share a name");

	return {
		cell: raw.name,
		description: raw.description,
		parameters: raw.parameters,
		source: raw.source,
		checks: raw.checks,
		retire: raw.retire ?? [],
		migrate: raw.migrate,
		pure: raw.pure === true,
		invariants,
		changes: raw.changes ?? [],
		expectLive: raw.expectLive === null ? null : fullVersion(raw.name, raw.expectLive),
	};
}

/**
 * The candidate version for a proposal against the live version in `catalogue`. Optional fields are only present when
 * set, because documents hold strict JSON.
 */
export function candidateOf(proposal: Proposal, catalogue: Catalogue, why: number | undefined): CellVersion {
	const parent = entryOf(catalogue, proposal.cell)?.live ?? undefined;

	const candidate: CellVersion = {
		version: versionId(proposal.cell, proposal.source, proposal.migrate),
		description: proposal.description,
		parameters: proposal.parameters,
		source: proposal.source,
		checks: proposal.checks,
		retired: proposal.retire,
		invariants: proposal.invariants,
		replay: proposal.pure ? "safe" : "unsafe",
	};

	if (proposal.migrate !== undefined) candidate.migrate = proposal.migrate;

	if (parent !== undefined) candidate.parent = parent;

	if (why !== undefined) candidate.why = why;

	return candidate;
}
