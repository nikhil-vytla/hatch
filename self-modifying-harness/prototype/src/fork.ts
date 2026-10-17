// Why: forking copies a stopped forge's data directory so the same session can be compared under another memory
// strategy. A sqlite file is copied through SQLite's own backup (a consistent snapshot), everything else as is, and the
// WAL/SHM sidecars are skipped because a fresh open recreates them.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SIDECAR = /-(wal|shm)$/;

export const isSqlite = (name: string): boolean => name.endsWith(".sqlite");

export const isSidecar = (name: string): boolean => SIDECAR.test(name);

/** A consistent copy of one sqlite file via `node:sqlite`'s backup, or `VACUUM INTO` on a Node without it. */
async function copySqlite(src: string, dst: string): Promise<void> {
	const db = new DatabaseSync(src, { readOnly: true });

	try {
		rmSync(dst, { force: true });
		const sqlite = await import("node:sqlite");

		if (sqlite.backup !== undefined) {
			await sqlite.backup(db, dst);
		} else {
			db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
		}
	} finally {
		db.close();
	}
}

async function copyTree(src: string, dst: string): Promise<void> {
	mkdirSync(dst, { recursive: true });

	for (const entry of readdirSync(src, { withFileTypes: true })) {
		if (isSidecar(entry.name)) continue;
		const from = join(src, entry.name);
		const to = join(dst, entry.name);

		if (entry.isDirectory()) await copyTree(from, to);
		else if (isSqlite(entry.name)) await copySqlite(from, to);
		else cpSync(from, to);
	}
}

/** Copy `src` over `dst`, refusing a non-empty target unless `fresh` empties it first, and say so. */
export async function forkDataDir(src: string, dst: string, fresh: boolean): Promise<void> {
	if (!existsSync(src)) throw new Error(`fork source does not exist: ${src}`);

	if (existsSync(dst) && readdirSync(dst).length > 0) {
		if (!fresh) throw new Error(`fork target is not empty: ${dst}; pass --fresh to replace it`);
		rmSync(dst, { recursive: true, force: true });
	}

	await copyTree(src, dst);
	console.log(`forked ${src} -> ${dst}`);
}
