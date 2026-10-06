// Cells: agent-written code with its own durable state, after celld's model.
//
// celld runs each Durable Object as a "cell": a named server with its own SQLite database. Its Worker Loader
// (`env.LOADER.get("app-v1", ...)`) loads code from a string under a version id, and a facet
// (`ctx.facets.get("app", ...)`) gives that code a SQLite database whose identity is the facet name, not the code
// version. So code can be replaced while its state stays put.
//
// Here a cell is the same split, in one process:
//   - code: an immutable source string, addressed by `<name>@<sha8>`; it runs in a QuickJS VM (pi-codemode), whose only
//     capabilities are `args` and a `kv` namespace;
//   - state: one SQLite file per cell name (`state/<name>.sqlite`), shared by every version of that cell's code.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@earendil-works/pi-durable";

export type Check = { args: JsonValue; expect: JsonValue };

export type CellVersion = {
	version: string; // "<name>@<sha8>"
	description: string;
	parameters: JsonObject; // JSON Schema of the tool's arguments
	source: string; // body of an async function; `args` and `kv` are in scope
	migrate?: string; // run once, against the cell's state, when this version is accepted
	checks: Check[]; // examples this version must pass
	retired: Check[]; // earlier checks this version is allowed to break, each named in `why`
	invariants: Invariant[]; // model-proposed; ratcheted like checks, but never retirable (the caller's own live elsewhere)
	parent?: string;
	why?: number; // OptChat log index of the user message that asked for this version
	replay: "safe" | "unsafe"; // whether the tool may rerun after a crash (pure cells only)
};

/** A property of the cell's state that must hold after every call: a function body that returns exactly `true`. */
export type Invariant = { name: string; source: string };

/** One exactly-once call, as recorded in the `calls` table. Only calls with both snapshots are returned. */
export type Trace = {
	id: string;
	args: JsonValue;
	before: JsonObject; // the whole kv before the call
	after: JsonObject; // the whole kv after the call
	result: JsonValue;
	version: string | null; // the cell version that ran it
};

export type ReplayOutcome = { result: JsonValue; after: JsonObject } | { error: string } | { migrationError: string };

/**
 * Invariants of two origins. Each list runs in its own sandbox execution (so a model-proposed body that tampers with
 * built-ins cannot make a caller-owned body pass), the caller-owned list first.
 */
export type InvariantSets = { owned: Invariant[]; proposed: Invariant[] };

function groupsOf(invariants: Invariant[] | InvariantSets): Invariant[][] {
	const groups = Array.isArray(invariants) ? [invariants] : [invariants.owned, invariants.proposed];

	return groups.filter((group) => group.length > 0);
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export class InvariantError extends Error {
	readonly invariant: string;

	constructor(invariant: string, detail: string) {
		super(`invariant "${invariant}" violated: ${detail}`);
		this.name = "InvariantError";
		this.invariant = invariant;
	}
}

export function versionId(name: string, source: string, migrate = ""): string {
	return `${name}@${createHash("sha256").update(source).update("\0").update(migrate).digest("hex").slice(0, 8)}`;
}

/** Snapshots bigger than this are not stored (the trace keeps args and result only). */
const SNAPSHOT_LIMIT_BYTES = 64 * 1024;

// Columns added to `calls` after its first version; existing databases get them with ALTER TABLE.
const TRACE_COLUMNS = ["args TEXT", "kv_before TEXT", "kv_after TEXT", "version TEXT"];

// Runs every invariant in the same VM, in order. Each body gets a frozen read-only `kv` as a parameter (the host also
// refuses writes through the global `kv`), and is built with the AsyncFunction constructor so it cannot close the
// wrapper early. The program returns one verdict per invariant: null if it returned `true`, otherwise why not.
function invariantProgram(invariants: Invariant[]): string {
	return `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const readOnly = Object.freeze({ get: kv.get, keys: kv.keys });
const bodies = ${JSON.stringify(invariants.map((i) => i.source))};
const verdicts = [];
for (const body of bodies) {
	try {
		const value = await new AsyncFunction("kv", body)(readOnly);
		verdicts.push(value === true ? null : "returned " + JSON.stringify(value));
	} catch (error) {
		verdicts.push("threw " + (error && error.message));
	}
}
return verdicts;`;
}

function parseVerdicts(value: JsonValue | undefined, expected: number): (string | null)[] | undefined {
	if (!Array.isArray(value) || value.length !== expected) return undefined;

	return value.map((verdict) => (verdict === null ? null : String(verdict)));
}

function snapshot(db: DatabaseSync, limitBytes: number): JsonObject | null {
	const size = db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(k AS BLOB)) + LENGTH(CAST(v AS BLOB))), 0) AS bytes FROM kv").get();

	if (Number(size?.bytes) > limitBytes) return null;

	const rows = db.prepare("SELECT k, v FROM kv ORDER BY k").all();

	return Object.fromEntries(rows.map((row) => [String(row.k), JSON.parse(String(row.v))]));
}

function openState(stateFile: string): DatabaseSync {
	const db = new DatabaseSync(stateFile);
	db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
	// Exactly-once: the harness's call id is recorded in the same transaction as the call's effects, so a rerun
	// after a crash finds its own result instead of applying the effects again. The other columns are the call's trace.
	db.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
	// Crash-safe migration: `migrated_to` is written in the same transaction as the migration it records.
	db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
	const have = new Set(db.prepare("PRAGMA table_info(calls)").all().map((column) => String(column.name)));

	for (const column of TRACE_COLUMNS) {
		if (!have.has(column.split(" ")[0])) db.exec(`ALTER TABLE calls ADD COLUMN ${column}`);
	}

	return db;
}

// The statements of the call in progress. The pooled sandbox's globals dispatch to whichever is active.
type ActiveDb = {
	get: StatementSync;
	put: StatementSync;
	del: StatementSync;
	keys: StatementSync;
	readOnly: boolean;
};

function migratedMarker(db: DatabaseSync): string | null {
	const row = db.prepare("SELECT v FROM meta WHERE k = 'migrated_to'").get();

	return row === undefined ? null : String(row.v);
}

function keyOf(argv: JsonValue[]): string {
	return String(argv[0]);
}

export class CellRuntime {
	readonly dir: string;
	readonly timeoutMs: number;
	// One sandbox for every call: the QuickJS wasm is compiled once and the globals are registered once. pi-codemode
	// still starts a worker and a VM per execute() (that is how it kills runaway scripts), so this saves construction
	// and compilation, not the worker. Calls are serialized (see `serialized`) so the sandbox never sees two databases.
	private readonly sandbox: CodemodeSandbox;
	private active: ActiveDb | null = null;
	private tail: Promise<void> = Promise.resolve();
	private scratchCount = 0;

	constructor(dir: string, timeoutMs = 2_000) {
		this.dir = dir;
		this.timeoutMs = timeoutMs;
		mkdirSync(join(dir, "state"), { recursive: true });
		this.sandbox = new CodemodeSandbox({
			timeoutMs,
			wasm: loadQuickJSWasm(),
			globals: [
				{ name: "kv.get", spread: true, execute: (argv: JsonValue[]) => this.kvGet(keyOf(argv)) },
				{ name: "kv.put", spread: true, execute: (argv: JsonValue[]) => this.kvPut(keyOf(argv), argv[1] ?? null) },
				{ name: "kv.delete", spread: true, execute: (argv: JsonValue[]) => this.kvDelete(keyOf(argv)) },
				{ name: "kv.keys", spread: true, execute: () => this.kvKeys() },
			],
		});
	}

	statePath(name: string): string {
		return join(this.dir, "state", `${name}.sqlite`);
	}

	/** Writes made by the last `run()`, so the gate can test a cell's claim to be pure. */
	lastWrites = 0;
	/** Calls answered from the `calls` table instead of being run again. */
	replayed = 0;
	/** Sandbox executions so far (each is a worker and a VM, about 75 to 165 ms), so callers can budget them. */
	executions = 0;

	/** Release the sandbox. Calls after this fail. */
	async close(): Promise<void> {
		await this.sandbox.close();
	}

	private activeDb(): ActiveDb {
		if (this.active === null) throw new Error("kv used outside a cell call");

		return this.active;
	}

	private kvGet(key: string): JsonValue {
		const row = this.activeDb().get.get(key);

		return row === undefined ? null : JSON.parse(String(row.v));
	}

	private kvPut(key: string, value: JsonValue): null {
		const db = this.activeDb();

		if (db.readOnly) throw new Error("kv is read-only here");

		this.lastWrites++;
		db.put.run(key, JSON.stringify(value));

		return null;
	}

	private kvDelete(key: string): null {
		const db = this.activeDb();

		if (db.readOnly) throw new Error("kv is read-only here");

		this.lastWrites++;
		db.del.run(key);

		return null;
	}

	private kvKeys(): string[] {
		return this.activeDb().keys.all().map((row) => String(row.k));
	}

	// A mutex: the sandbox's globals point at one database at a time, so whole runs (open, execute, commit, close) queue up.
	private serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work);
		this.tail = next.then(() => undefined, () => undefined);

		return next;
	}

	private async execute(db: DatabaseSync, code: string, readOnly: boolean): Promise<JsonValue> {
		this.executions++;
		this.active = {
			get: db.prepare("SELECT v FROM kv WHERE k = ?"),
			put: db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
			del: db.prepare("DELETE FROM kv WHERE k = ?"),
			keys: db.prepare("SELECT k FROM kv ORDER BY k"),
			readOnly,
		};

		try {
			const result = await this.sandbox.execute(code);

			if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);

			return JSON.parse(JSON.stringify(result.value ?? null));
		} finally {
			this.active = null;
		}
	}

	// Evaluated against the call's own uncommitted state, so a failure can still roll the call back. One execution per
	// non-empty list, so lists of different origin never share a VM.
	private async checkInvariants(db: DatabaseSync, invariants: Invariant[] | InvariantSets): Promise<void> {
		for (const group of groupsOf(invariants)) await this.checkGroup(db, group);
	}

	private async checkGroup(db: DatabaseSync, invariants: Invariant[]): Promise<void> {
		let verdicts: (string | null)[] | undefined;

		try {
			verdicts = parseVerdicts(await this.execute(db, invariantProgram(invariants), true), invariants.length);
		} catch (error) {
			const names = invariants.map((i) => i.name).join(", ");
			throw new Error(`invariants [${names}] could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (verdicts === undefined) throw new Error("invariants could not be evaluated: the sandbox returned a malformed verdict list");

		for (const [i, verdict] of verdicts.entries()) {
			if (verdict !== null) throw new InvariantError(invariants[i].name, verdict);
		}
	}

	private async runLocked(source: string, args: JsonValue, stateFile: string, callId: string | undefined, invariants: Invariant[] | InvariantSets, version: string | undefined, marker?: string): Promise<JsonValue> {
		this.lastWrites = 0;
		const db = openState(stateFile);

		try {
			if (callId !== undefined) {
				const seen = db.prepare("SELECT result FROM calls WHERE id = ?").get(callId);

				if (seen !== undefined) {
					this.replayed++;

					return JSON.parse(String(seen.result));
				}
			}

			// One transaction per call: a script that throws, or breaks an invariant, leaves the state as it was.
			db.exec("BEGIN");

			try {
				// A migration already recorded for this version is not run twice.
				if (marker !== undefined && migratedMarker(db) === marker) {
					db.exec("ROLLBACK");

					return null;
				}

				const before = callId === undefined ? null : snapshot(db, SNAPSHOT_LIMIT_BYTES);
				const value = await this.execute(db, `const args = ${JSON.stringify(args ?? {})};\n${source}`, false);
				await this.checkInvariants(db, invariants);

				if (callId !== undefined) {
					const after = snapshot(db, SNAPSHOT_LIMIT_BYTES);
					// A trace needs both snapshots to be replayable, so an oversized one drops the other too.
					const whole = before !== null && after !== null;
					db.prepare("INSERT INTO calls (id, result, args, kv_before, kv_after, version) VALUES (?, ?, ?, ?, ?, ?)").run(
						callId,
						JSON.stringify(value),
						JSON.stringify(args ?? {}),
						whole ? JSON.stringify(before) : null,
						whole ? JSON.stringify(after) : null,
						version ?? null,
					);
				}

				if (marker !== undefined) db.prepare("INSERT INTO meta (k, v) VALUES ('migrated_to', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(marker);

				db.exec("COMMIT");

				return value;
			} catch (error) {
				if (db.isTransaction) db.exec("ROLLBACK");
				throw error;
			}
		} finally {
			db.close();
		}
	}

	/**
	 * Run code against a cell's state file. Returns the script's value or throws its error. After the script and
	 * before commit, `invariants` are checked against the same transaction; a violation rolls the call back and throws
	 * an `InvariantError`.
	 */
	run(source: string, args: JsonValue, stateFile: string, callId?: string, invariants: Invariant[] | InvariantSets = [], version?: string): Promise<JsonValue> {
		return this.serialized(() => this.runLocked(source, args, stateFile, callId, invariants, version));
	}

	/** Run a live cell's code against its real state. */
	call(cell: CellVersion, name: string, args: JsonValue, callId?: string, invariants: Invariant[] | InvariantSets = []): Promise<JsonValue> {
		return this.run(cell.source, args, this.statePath(name), callId, invariants, cell.version);
	}

	/** The most recent `limit` exactly-once calls of a cell that have complete snapshots, oldest first. */
	traces(name: string, limit: number): Promise<Trace[]> {
		return this.serialized(async () => {
			if (!existsSync(this.statePath(name))) return [];

			const db = openState(this.statePath(name));

			try {
				const rows = db
					.prepare("SELECT id, args, kv_before, kv_after, result, version FROM calls WHERE args IS NOT NULL AND kv_before IS NOT NULL AND kv_after IS NOT NULL ORDER BY rowid DESC LIMIT ?")
					.all(limit);

				const traces = rows.map((row): Trace => ({
					id: String(row.id),
					args: JSON.parse(String(row.args)),
					before: JSON.parse(String(row.kv_before)),
					after: JSON.parse(String(row.kv_after)),
					result: JSON.parse(String(row.result)),
					version: row.version === null ? null : String(row.version),
				}));

				return traces.reverse();
			} finally {
				db.close();
			}
		});
	}

	/**
	 * Run a candidate's source on a scratch database seeded with a trace's kv-before, with the trace's args. The real
	 * state is never opened. Comparing `after` with `trace.after` shows whether the candidate behaves the same. A
	 * candidate with a `migrate` runs it on the seeded state first (the before-state has the old shape), so the result
	 * is comparable but the after-state is in the new shape.
	 */
	replay(name: string, candidate: Pick<CellVersion, "source" | "migrate">, trace: Trace, invariants: Invariant[] | InvariantSets = []): Promise<ReplayOutcome> {
		return this.serialized(async () => {
			const scratch = join(this.dir, "state", `.replay-${name}-${process.pid}-${this.scratchCount++}.sqlite`);
			rmSync(scratch, { force: true });

			try {
				const seed = openState(scratch);

				try {
					const put = seed.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");

					for (const [key, value] of Object.entries(trace.before)) put.run(key, JSON.stringify(value));
				} finally {
					seed.close();
				}

				if (candidate.migrate) {
					try {
						await this.runLocked(candidate.migrate, {}, scratch, undefined, [], undefined);
					} catch (error) {
						return { migrationError: error instanceof Error ? error.message : String(error) };
					}
				}

				try {
					const result = await this.runLocked(candidate.source, trace.args, scratch, undefined, invariants, undefined);
					const db = openState(scratch);

					try {
						return { result, after: snapshot(db, Infinity) ?? {} };
					} finally {
						db.close();
					}
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			} finally {
				rmSync(scratch, { force: true });
			}
		});
	}

	/**
	 * The gate. Two checkpoints, neither of which touches the real state:
	 *   - the migration runs on a scratch copy of the cell's live state (like celld restoring a cell from its log), and
	 *     must not throw and must leave every invariant true;
	 *   - each group of checks (one group per accepted version still owed, plus the candidate's own) runs as a sequence
	 *     from an empty state, so a group's expectations never depend on another group's writes or on live data. The
	 *     invariants are checked after every check.
	 */
	async verify(name: string, candidate: CellVersion, owed: Check[][], invariants: Invariant[] | InvariantSets = []): Promise<Verdict> {
		const scratch = join(this.dir, "state", `.verify-${name}-${process.pid}.sqlite`);

		try {
			if (candidate.migrate) {
				rmSync(scratch, { force: true });

				if (existsSync(this.statePath(name))) copyFileSync(this.statePath(name), scratch);

				try {
					await this.run(candidate.migrate, {}, scratch, undefined, invariants);
				} catch (error) {
					return { ok: false, reason: `migration failed on a copy of the live state: ${error instanceof Error ? error.message : String(error)}` };
				}
			}

			for (const [g, group] of owed.entries()) {
				rmSync(scratch, { force: true });

				for (const [i, check] of group.entries()) {
					let actual: JsonValue;

					try {
						actual = await this.run(candidate.source, check.args, scratch, undefined, invariants);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const verb = error instanceof InvariantError ? "broke" : "threw";

						return { ok: false, reason: `group ${g} check ${i} ${JSON.stringify(check.args)} ${verb} ${message}` };
					}

					if (candidate.replay === "safe" && this.lastWrites > 0) {
						return { ok: false, reason: `declared pure (replay-safe) but check ${i} wrote state; a crash rerun would apply it twice` };
					}

					if (!deepEqual(actual, check.expect)) {
						return { ok: false, reason: `group ${g} check ${i} ${JSON.stringify(check.args)}: expected ${JSON.stringify(check.expect)}, got ${JSON.stringify(actual)}` };
					}
				}
			}

			return { ok: true };
		} finally {
			rmSync(scratch, { force: true });
		}
	}

	/**
	 * Step 2 of the crash-safe accept: run the version's migration (if any) against the real state and record
	 * `migrated_to = <version>` in the same SQLite transaction, so the marker is there exactly when the migration is. A
	 * version already recorded is not migrated again.
	 */
	migrateTo(name: string, cell: CellVersion, invariants: Invariant[] | InvariantSets = []): Promise<void> {
		return this.serialized(async () => {
			await this.runLocked(cell.migrate ?? "", {}, this.statePath(name), undefined, invariants, cell.version, cell.version);
		});
	}

	/** The version whose migration last committed on this cell's real state, or null if none did. */
	migratedTo(name: string): Promise<string | null> {
		return this.serialized(async () => {
			if (!existsSync(this.statePath(name))) return null;

			const db = openState(this.statePath(name));

			try {
				return migratedMarker(db);
			} finally {
				db.close();
			}
		});
	}
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// Objects with their keys sorted, so equality ignores key order.
function canonical(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(canonical);

	if (value === null || value.constructor !== Object) return value;

	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
}
