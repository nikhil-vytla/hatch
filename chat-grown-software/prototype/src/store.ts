// Durable revisions, after Jiti's store (ADR 0003, 0007): immutable revision directories, an atomically replaced
// CURRENT pointer, and an append-only journal of attempts. Recovery loads CURRENT and never replays unfinished work.
// Rollback publishes an old state as a new revision, so history is never rewritten.
//
// One addition for verification: `traces.jsonl`, the record of real use (each executed expression with the state
// before and after and the functions it ran). That record is the regression oracle in gates.ts.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./world.ts";

export type Revision = { id: string; number: number; parent?: string; at: string; reason: string; rollbackOf?: string; world: Snapshot; specs: unknown };
export type Trace = { expr: string; before: unknown; after: unknown; value: unknown; calls: string[]; revision: string };

export class Store {
	readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(join(dir, "revisions"), { recursive: true });
	}

	current(): Revision | undefined {
		const pointer = join(this.dir, "CURRENT");
		if (!existsSync(pointer)) return undefined;
		const id = readFileSync(pointer, "utf8").trim();
		return JSON.parse(readFileSync(join(this.dir, "revisions", id, "revision.json"), "utf8"));
	}

	revisions(): Revision[] {
		return readdirSync(join(this.dir, "revisions"))
			.filter((d) => existsSync(join(this.dir, "revisions", d, "revision.json")))
			.map((d) => JSON.parse(readFileSync(join(this.dir, "revisions", d, "revision.json"), "utf8")) as Revision)
			.sort((a, b) => a.number - b.number);
	}

	/** Write the revision directory, fsync it, then swap CURRENT with an atomic rename. */
	publish(revision: Omit<Revision, "id" | "number" | "at">): Revision {
		const number = (this.current()?.number ?? 0) + 1;
		const full: Revision = { ...revision, id: `rev-${String(number).padStart(4, "0")}`, number, at: new Date().toISOString() };
		const dir = join(this.dir, "revisions", full.id);
		mkdirSync(dir, { recursive: true });
		writeDurably(join(dir, "revision.json"), JSON.stringify(full, null, 1));
		writeDurably(join(this.dir, "CURRENT.tmp"), full.id);
		renameSync(join(this.dir, "CURRENT.tmp"), join(this.dir, "CURRENT"));
		return full;
	}

	journal(event: Record<string, unknown>): void {
		appendDurably(join(this.dir, "journal.jsonl"), { at: new Date().toISOString(), ...event });
	}

	recordTrace(trace: Trace): void {
		appendDurably(join(this.dir, "traces.jsonl"), trace);
	}

	traces(): Trace[] {
		const path = join(this.dir, "traces.jsonl");
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
			try {
				return [JSON.parse(l) as Trace];
			} catch {
				return []; // a torn last line from a crash
			}
		});
	}
}

function writeDurably(path: string, text: string): void {
	writeFileSync(path, text);
	const fd = openSync(path, "r");
	fsyncSync(fd);
	closeSync(fd);
}

function appendDurably(path: string, value: unknown): void {
	const fd = openSync(path, "a");
	writeSync(fd, `${JSON.stringify(value)}\n`);
	fsyncSync(fd);
	closeSync(fd);
}
