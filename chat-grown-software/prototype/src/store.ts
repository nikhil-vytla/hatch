// Durable revisions, after Jiti's store (ADR 0003, 0007): immutable revision directories, an atomically replaced
// CURRENT pointer, and an append-only journal of attempts. Recovery loads CURRENT and never replays unfinished work.
// Rollback publishes an old state as a new revision, so history is never rewritten.
//
// One addition for verification: `traces.jsonl`, the record of real use (each executed expression with the state
// before and after and the functions it ran). That record is the regression oracle in gates.ts.
//
// Two more, from the self-modifying-harness lessons:
//   - each revision carries a `codeId` (functions + contract) and a `dataId` (managed state) as separate content
//     hashes, so a rollback can move one line and keep the other;
//   - an `execute` with a request id writes that id and its result into the same revision file as the state change,
//     so a retried request finds its first result instead of applying twice.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./world.ts";

/** The chat message that asked for a change: its index in the chat log and the user's words. */
export type Asked = { message: number; text: string };
export type Revision = {
	id: string;
	number: number;
	parent?: string;
	at: string;
	reason: string;
	rollbackOf?: string;
	world: Snapshot;
	specs: unknown;
	codeId: string;
	dataId: string;
	asked?: Asked;
	requestId?: string;
	result?: unknown;
};
export type Trace = { expr: string; before: unknown; after: unknown; value: unknown; calls: string[]; revision: string; requestId?: string };

export const contentId = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

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
	publish(revision: Omit<Revision, "id" | "number" | "at" | "codeId" | "dataId">): Revision {
		const number = (this.current()?.number ?? 0) + 1;
		const codeId = contentId([revision.world.functions, revision.specs]);
		const dataId = contentId(revision.world.state);
		const full: Revision = { ...revision, id: `rev-${String(number).padStart(4, "0")}`, number, at: new Date().toISOString(), codeId, dataId };
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

	/** The first result of a request id, from the revision that carries it (a state change) or its trace (a read). */
	request(id: string): { value: unknown } | undefined {
		for (const r of this.revisions()) if (r.requestId === id) return { value: r.result };
		for (const t of this.traces()) if (t.requestId === id) return { value: t.value };
		return undefined;
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
