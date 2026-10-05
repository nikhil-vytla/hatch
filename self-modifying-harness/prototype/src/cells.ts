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
import { DatabaseSync } from "node:sqlite";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

export type Check = { args: unknown; expect: unknown };

export type CellVersion = {
	version: string; // "<name>@<sha8>"
	description: string;
	parameters: Record<string, unknown>; // JSON Schema of the tool's arguments
	source: string; // body of an async function; `args` and `kv` are in scope
	migrate?: string; // run once, against the cell's state, when this version is accepted
	checks: Check[]; // examples this version must pass
	retired: Check[]; // earlier checks this version is allowed to break, each named in `why`
	parent?: string;
	why?: number; // OptChat log index of the user message that asked for this version
	replay: "safe" | "unsafe"; // whether the tool may rerun after a crash (pure cells only)
};

export function versionId(name: string, source: string, migrate = ""): string {
	return `${name}@${createHash("sha256").update(source).update("\0").update(migrate).digest("hex").slice(0, 8)}`;
}

export class CellRuntime {
	readonly dir: string;
	readonly timeoutMs: number;
	constructor(dir: string, timeoutMs = 2_000) {
		this.dir = dir;
		this.timeoutMs = timeoutMs;
		mkdirSync(join(dir, "state"), { recursive: true });
	}

	statePath(name: string): string {
		return join(this.dir, "state", `${name}.sqlite`);
	}

	/** Writes made by the last `run()`, so the gate can test a cell's claim to be pure. */
	lastWrites = 0;
	/** Calls answered from the `calls` table instead of being run again. */
	replayed = 0;

	/** Run code against a cell's state file. Returns the script's value or throws its error. */
	async run(source: string, args: unknown, stateFile: string, callId?: string): Promise<unknown> {
		this.lastWrites = 0;
		const db = new DatabaseSync(stateFile);
		db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
		// Exactly-once: the harness's call id is recorded in the same transaction as the call's effects, so a rerun
		// after a crash finds its own result instead of applying the effects again.
		db.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
		if (callId !== undefined) {
			const seen = db.prepare("SELECT result FROM calls WHERE id = ?").get(callId) as { result: string } | undefined;
			if (seen !== undefined) {
				db.close();
				this.replayed++;
				return JSON.parse(seen.result);
			}
		}
		const get = db.prepare("SELECT v FROM kv WHERE k = ?");
		const put = db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
		const del = db.prepare("DELETE FROM kv WHERE k = ?");
		const keys = db.prepare("SELECT k FROM kv ORDER BY k");
		const sandbox = new CodemodeSandbox({
			timeoutMs: this.timeoutMs,
			globals: [
				{ name: "kv.get", spread: true, execute: ([k]: any) => { const row = get.get(String(k)) as { v: string } | undefined; return row === undefined ? null : JSON.parse(row.v); } },
				{ name: "kv.put", spread: true, execute: ([k, v]: any) => { this.lastWrites++; put.run(String(k), JSON.stringify(v ?? null)); return null; } },
				{ name: "kv.delete", spread: true, execute: ([k]: any) => { this.lastWrites++; del.run(String(k)); return null; } },
				{ name: "kv.keys", spread: true, execute: () => (keys.all() as { k: string }[]).map((r) => r.k) },
			],
		});
		try {
			// One transaction per call: a script that throws leaves the state as it was.
			db.exec("BEGIN");
			const result = await sandbox.execute(`const args = ${JSON.stringify(args ?? {})};\n${source}`);
			if (!result.ok) {
				db.exec("ROLLBACK");
				throw new Error(`${result.error.kind}: ${result.error.message}`);
			}
			if (callId !== undefined) db.prepare("INSERT INTO calls (id, result) VALUES (?, ?)").run(callId, JSON.stringify(result.value ?? null));
			db.exec("COMMIT");
			return result.value ?? null;
		} finally {
			await sandbox.close();
			db.close();
		}
	}

	/** Run a live cell's code against its real state. */
	call(cell: CellVersion, name: string, args: unknown, callId?: string): Promise<unknown> {
		return this.run(cell.source, args, this.statePath(name), callId);
	}

	/**
	 * The gate. Two checkpoints, neither of which touches the real state:
	 *   - the migration runs on a scratch copy of the cell's live state (like celld restoring a cell from its log), and
	 *     must not throw;
	 *   - each group of checks (one group per accepted version still owed, plus the candidate's own) runs as a sequence
	 *     from an empty state, so a group's expectations never depend on another group's writes or on live data.
	 */
	async verify(name: string, candidate: CellVersion, owed: Check[][]): Promise<{ ok: true } | { ok: false; reason: string }> {
		const scratch = join(this.dir, "state", `.verify-${name}-${process.pid}.sqlite`);
		try {
			if (candidate.migrate) {
				rmSync(scratch, { force: true });
				if (existsSync(this.statePath(name))) copyFileSync(this.statePath(name), scratch);
				try {
					await this.run(candidate.migrate, {}, scratch);
				} catch (error) {
					return { ok: false, reason: `migration failed on a copy of the live state: ${(error as Error).message}` };
				}
			}
			for (const [g, group] of owed.entries()) {
				rmSync(scratch, { force: true });
				for (const [i, check] of group.entries()) {
					let actual: unknown;
					try {
						actual = await this.run(candidate.source, check.args, scratch);
					} catch (error) {
						return { ok: false, reason: `group ${g} check ${i} ${JSON.stringify(check.args)} threw ${(error as Error).message}` };
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

	/** Apply an accepted version's migration to the real state. */
	async migrate(name: string, cell: CellVersion): Promise<void> {
		if (cell.migrate) await this.run(cell.migrate, {}, this.statePath(name));
	}
}

export function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
	}
	return value;
}
