/**
 * Durable session index for the control plane. Sandboxes already survive
 * restarts on disk; this makes the session rows survive too.
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { SessionRow } from "../server/control-plane.js";

export class SessionIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        row TEXT NOT NULL,
        last_active_at INTEGER NOT NULL
      );
    `);
  }

  upsert(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, row, last_active_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET row = excluded.row, last_active_at = excluded.last_active_at`,
      )
      .run(row.id, JSON.stringify(row), row.lastActiveAt);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  /** Load rows whose sandbox still exists on disk; drop the rest. */
  load(): SessionRow[] {
    const rows = this.db.prepare(`SELECT id, row FROM sessions`).all() as {
      id: string;
      row: string;
    }[];
    const alive: SessionRow[] = [];
    for (const r of rows) {
      const parsed = JSON.parse(r.row) as SessionRow;
      if (existsSync(parsed.repoDir)) {
        // A restart cannot resume a mid-flight OpenCode process.
        if (parsed.status === "running") parsed.status = "idle";
        alive.push(parsed);
      } else {
        this.delete(r.id);
      }
    }
    return alive;
  }

  close(): void {
    this.db.close();
  }
}
