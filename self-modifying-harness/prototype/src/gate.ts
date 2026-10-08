// The gate: everything a candidate cell version must satisfy before it may become live. Pure of side effects on the real
// state (every execution runs on a scratch copy), and returns a verdict with its reason, never a bare boolean.
//
// `verifyCell` (proofs/cell-verified.ts) is the only caller and the only place that turns an `ok` verdict into a proof,
// so this file is part of what that proof trusts. Order matters for cost: the cheap structural checks run first, then the
// sandbox ones (checks, replay of real calls, schema fuzz), each of which costs 75 to 165 ms per execution.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type CatalogueEntry, cellName, staleReason } from "./catalogue-doc.ts";
import { type CellRuntime, type CellVersion, type Check, deepEqual, InvariantError, type Invariant, type InvariantSets, type ReplayOutcome, type Trace, versionId } from "./cells.ts";
import { generateArgs, isObject } from "./schema-fuzz.ts";

export const KERNEL_TOOLS = new Set(["cell_propose", "cell_rollback", "cell_list", "cell_source", "zoom", "date"]);

export const NAME = /^[a-z][a-z0-9_]{1,40}$/;

/** How many of the live cell's recent real calls a candidate is replayed against. */
export const REPLAY_TRACES = 50;

/** Inputs generated from the schema, and the cap on sandbox executions they may use (code plus invariant lists). */
export const FUZZ_INPUTS = 40;

export const FUZZ_EXECUTION_BUDGET = 40;

/** What the caller of the gate says about the proposal, and what only the caller may decide. */
export type Intent = {
	expectLive: string | null; // the live version the proposer saw; null: it expects the cell not to exist
	owned: Invariant[]; // caller-owned invariants for this cell: the model cannot change them
	changes: string[]; // enum values of the action property whose behaviour this version intends to change, or ["*"]
};

export type BehaviourDiff = { args: JsonValue; action: string | null; summary: string; intended: boolean };

export type GateReport = {
	checks: number; // checks run: every ancestor's plus the candidate's own
	replayed: number; // real calls replayed against the candidate
	replaySkipped: number; // traces that could not be replayed through the candidate's migration
	behaviourDiffs: BehaviourDiff[]; // every difference replay found; all of them intended, or the gate would have refused
	fuzz: { generated: number; ran: number; executions: number; budget: number };
	advisories: string[];
};

export type GateOutcome = { ok: true; report: GateReport } | { ok: false; reason: string; stale: boolean };

function refuse(reason: string): GateOutcome {
	return { ok: false, reason, stale: false };
}

/** The accepted versions the candidate descends from, oldest first. Stops at a gap or a cycle rather than looping. */
export function lineage(entry: CatalogueEntry | undefined): CellVersion[] {
	const chain: CellVersion[] = [];
	const seen = new Set<string>();
	let at = entry?.live ?? undefined;

	while (entry !== undefined && at !== undefined && !seen.has(at)) {
		const version = entry.versions[at];

		if (version === undefined) break;

		seen.add(at);
		chain.unshift(version);
		at = version.parent;
	}

	return chain;
}

/**
 * The checks a candidate owes: every accepted version's own checks along the live lineage (a ratchet), minus any the
 * candidate explicitly retires. Retiring is allowed, but it is recorded, with the candidate's `why`.
 */
export function owedChecks(entry: CatalogueEntry | undefined, candidate: CellVersion): Check[][] {
	const groups: Check[][] = [];

	for (const version of lineage(entry)) {
		const kept = version.checks.filter((c) => !candidate.retired.some((r) => deepEqual(r, c)));

		if (kept.length > 0) groups.push(kept);
	}

	groups.push(candidate.checks);

	return groups;
}

const invariantKey = (i: Invariant): string => JSON.stringify([i.name, i.source]);

/** Names of the model-proposed invariants of earlier versions that the candidate no longer carries. */
function droppedInvariants(chain: CellVersion[], candidate: CellVersion): string[] {
	const kept = new Set(candidate.invariants.map(invariantKey));
	const dropped = chain.flatMap((version) => version.invariants).filter((i) => !kept.has(invariantKey(i)));

	return [...new Set(dropped.map((i) => i.name))];
}

/** A top-level parameter with an `enum`: its name and members. */
export type EnumProperty = { property: string; members: JsonValue[] };

export function enumProperties(parameters: JsonObject): EnumProperty[] {
	const properties = parameters.properties;

	if (!isObject(properties)) return [];

	const found: EnumProperty[] = [];

	for (const [property, schema] of Object.entries(properties)) {
		if (isObject(schema) && Array.isArray(schema.enum) && schema.enum.length > 0) found.push({ property, members: [...schema.enum] });
	}

	return found;
}

/** Enum members that none of the candidate's own checks passes as that property's value. */
function unexercised(candidate: CellVersion): string[] {
	const missing: string[] = [];

	for (const { property, members } of enumProperties(candidate.parameters)) {
		for (const member of members) {
			const used = candidate.checks.some((check) => isObject(check.args) && check.args[property] !== undefined && deepEqual(check.args[property], member));

			if (!used) missing.push(`${property}=${JSON.stringify(member)}`);
		}
	}

	return missing;
}

/** The value of the cell's action-like property (its first enum property) in a call's args, or null. */
function actionOf(args: JsonValue, action: EnumProperty | undefined): string | null {
	if (action === undefined || !isObject(args)) return null;

	const value = args[action.property];

	return value === undefined ? null : String(value);
}

function replayDiff(trace: Trace, outcome: ReplayOutcome, compareState: boolean): string | undefined {
	if ("migrationError" in outcome) return undefined;

	if ("error" in outcome) return `the live version returned ${JSON.stringify(trace.result)}, the candidate throws ${outcome.error}`;

	if (!deepEqual(trace.result, outcome.result)) return `result ${JSON.stringify(trace.result)} became ${JSON.stringify(outcome.result)}`;

	if (compareState && !deepEqual(trace.after, outcome.after)) return `state after the call ${JSON.stringify(trace.after)} became ${JSON.stringify(outcome.after)}`;

	return undefined;
}

type Replayed = { replayed: number; skipped: number; diffs: BehaviourDiff[] };

// Replay of real use: the live version's own recent calls (see `traces`). Before-states of the traces have the live version's shape, so: without a migration the candidate
// runs on them as they are and result and after-state are both compared; with one, the migration runs on the seeded
// state first and only the result is compared (the after-state is in the new shape by design). A trace whose before-state
// the migration cannot digest is skipped and counted, not blamed on the candidate: the migration was already verified
// on the live state.
async function replayRealUse(runtime: CellRuntime, name: string, candidate: CellVersion, entry: CatalogueEntry | undefined, changes: string[]): Promise<Replayed> {
	const out: Replayed = { replayed: 0, skipped: 0, diffs: [] };

	if (entry === undefined || entry.live === null) return out;

	const action = enumProperties(candidate.parameters)[0];
	const seen = new Set<string>();

	for (const trace of await runtime.traces(name, REPLAY_TRACES)) {
		// Only calls the live version itself ran: an older version's calls have an older state shape.
		if (trace.version !== entry.live) continue;

		const key = JSON.stringify([trace.args, trace.before]);

		if (seen.has(key)) continue;

		seen.add(key);

		const outcome = await runtime.replay(name, candidate, trace);

		if ("migrationError" in outcome) {
			out.skipped++;

			continue;
		}

		out.replayed++;

		const summary = replayDiff(trace, outcome, candidate.migrate === undefined);

		if (summary === undefined) continue;

		const kind = actionOf(trace.args, action);
		const intended = changes.includes("*") || (kind !== null && changes.includes(kind));

		out.diffs.push({ args: trace.args, action: kind, summary, intended });
	}

	return out;
}

type Fuzzed = { blocking?: string; advisories: string[]; ran: number; executions: number };

const TIMEOUT = /(^|evaluated: )timeout:/;

// Schema fuzz: each generated input runs on its own empty scratch state with every invariant. Blocking: a hang, or a
// violation the live version does not have on the same input from the same (empty) state. Advisory: a violation the
// live version has too, or any on a cell with no live version. The execution budget caps the cost; a violation also
// costs one execution of the live version.
async function fuzz(runtime: CellRuntime, name: string, candidate: CellVersion, live: CellVersion | undefined, sets: InvariantSets): Promise<Fuzzed> {
	const scratch = join(runtime.dir, "state", `.fuzz-${name}-${process.pid}.sqlite`);
	const liveScratch = join(runtime.dir, "state", `.fuzz-live-${name}-${process.pid}.sqlite`);
	const seed = Number.parseInt(candidate.version.split("@")[1], 16);
	const started = runtime.executions;
	const spent = () => runtime.executions - started;
	const violations = new Map<string, { count: number; example: JsonObject }>();
	let ran = 0;

	try {
		for (const args of generateArgs(candidate.parameters, FUZZ_INPUTS, seed)) {
			if (spent() >= FUZZ_EXECUTION_BUDGET) break;

			rmSync(scratch, { force: true });
			ran++;

			try {
				await runtime.run(candidate.source, args, scratch, undefined, sets);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				if (TIMEOUT.test(message)) {
					return { blocking: `fuzz: input ${JSON.stringify(args)} did not finish within ${runtime.timeoutMs} ms (a hang the declared schema allows)`, advisories: [], ran, executions: spent() };
				}

				if (!(error instanceof InvariantError)) continue; // the script refused the input: that is validation, not a defect

				if (live !== undefined && !(await violates(runtime, live, args, liveScratch, sets, error.invariant))) {
					return { blocking: `fuzz: input ${JSON.stringify(args)} breaks invariant "${error.invariant}", which the live version ${live.version} does not on that input: a regression`, advisories: [], ran, executions: spent() };
				}

				const found = violations.get(error.invariant) ?? { count: 0, example: args };
				found.count++;
				violations.set(error.invariant, found);
			}
		}
	} finally {
		rmSync(scratch, { force: true });
		rmSync(liveScratch, { force: true });
	}

	const why = live === undefined ? "a new cell has no earlier version to compare with" : `the live version ${live.version} breaks it too`;
	const advisories = [...violations].map(([invariant, found]) => `fuzz: ${found.count} of ${ran} generated inputs break invariant "${invariant}" (first: ${JSON.stringify(found.example)}); ${why}. Not blocking.`);

	return { advisories, ran, executions: spent() };
}

async function violates(runtime: CellRuntime, live: CellVersion, args: JsonObject, scratch: string, sets: InvariantSets, invariant: string): Promise<boolean> {
	rmSync(scratch, { force: true });

	try {
		await runtime.run(live.source, args, scratch, undefined, sets);

		return false;
	} catch (error) {
		return error instanceof InvariantError && error.invariant === invariant;
	}
}

function describeDiffs(diffs: BehaviourDiff[]): string {
	return diffs
		.slice(0, 3)
		.map((d) => `${JSON.stringify(d.args)}: ${d.summary}`)
		.join("; ");
}

/**
 * Run the whole gate on `candidate` against the committed lineage in `entry`. All of these must hold:
 *   - the live version is the one the proposer expects (compare-and-swap; the commit checks again, authoritatively);
 *   - a legal, non-kernel name, a version id that matches the source, at least one check, and a version not yet accepted;
 *   - the earlier versions' model-proposed invariants are all kept (they ratchet; they cannot be retired);
 *   - every enum member of the parameters appears in one of the candidate's own checks;
 *   - the migration works on a copy of the live state; every owed check passes with every invariant; purity is honest;
 *   - replaying the live cell's recent real calls changes nothing outside `changes`;
 *   - fuzzing the schema finds no hang and no regression of an invariant.
 */
export async function runGate(runtime: CellRuntime, candidate: CellVersion, entry: CatalogueEntry | undefined, intent: Intent): Promise<GateOutcome> {
	const stale = staleReason(entry, intent.expectLive);

	if (stale !== undefined) return { ok: false, reason: stale, stale: true };

	const name = cellName(candidate.version);

	if (!NAME.test(name) || KERNEL_TOOLS.has(name)) return refuse(`refused: "${name}" is not a name a cell may take`);

	if (candidate.version !== versionId(name, candidate.source, candidate.migrate)) return refuse(`refused: ${candidate.version} is not the id of this source and migration`);

	if (candidate.checks.length === 0) return refuse("refused: a cell needs at least one check");

	if (entry?.versions[candidate.version] !== undefined) return refuse(`${candidate.version} was already accepted; use cell_rollback to make it live again`);

	const chain = lineage(entry);
	const dropped = droppedInvariants(chain, candidate);

	if (dropped.length > 0) return refuse(`invariant(s) ${dropped.map((d) => `"${d}"`).join(", ")} of earlier versions were dropped; invariants only ratchet up, so send them again and add any new ones`);

	const taken = candidate.invariants.find((i) => intent.owned.some((o) => o.name === i.name));

	if (taken !== undefined) return refuse(`invariant name "${taken.name}" belongs to a caller-owned invariant of this cell`);

	const missing = unexercised(candidate);

	if (missing.length > 0) return refuse(`checks do not exercise every action: ${missing.join(", ")} appear in none of this version's own checks`);

	const action = enumProperties(candidate.parameters)[0];

	if (action === undefined && intent.changes.some((c) => c !== "*")) return refuse(`changes ${JSON.stringify(intent.changes)} names actions, but this cell has no enum parameter; use ["*"]`);

	const unknownAction = intent.changes.find((c) => c !== "*" && !action?.members.some((m) => m === c));

	if (unknownAction !== undefined) return refuse(`changes names "${unknownAction}", which is not one of the ${action?.property} values ${JSON.stringify(action?.members)}`);

	const sets: InvariantSets = { owned: intent.owned, proposed: candidate.invariants };
	const owed = owedChecks(entry, candidate);
	const verdict = await runtime.verify(name, candidate, owed, sets);

	if (!verdict.ok) return refuse(verdict.reason);

	const live = chain.at(-1);
	const replay = await replayRealUse(runtime, name, candidate, entry, intent.changes);
	const unintended = replay.diffs.filter((d) => !d.intended);

	if (unintended.length > 0) {
		const scope = intent.changes.length === 0 ? "declared no `changes`" : `declared changes ${JSON.stringify(intent.changes)}`;

		return refuse(`replay: ${unintended.length} of ${replay.replayed} real calls behave differently from ${live?.version} and this proposal ${scope}: ${describeDiffs(unintended)}. If that is meant, list the action in \`changes\`; if not, it is a drive-by edit`);
	}

	const fuzzed = await fuzz(runtime, name, candidate, live, sets);

	if (fuzzed.blocking !== undefined) return refuse(fuzzed.blocking);

	return {
		ok: true,
		report: {
			checks: owed.flat().length,
			replayed: replay.replayed,
			replaySkipped: replay.skipped,
			behaviourDiffs: replay.diffs,
			fuzz: { generated: FUZZ_INPUTS, ran: fuzzed.ran, executions: fuzzed.executions, budget: FUZZ_EXECUTION_BUDGET },
			advisories: fuzzed.advisories,
		},
	};
}
