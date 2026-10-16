import Database from "better-sqlite3";
import type { GitAuthor } from "../sandbox/git-sandbox.js";

export type StoredSession = {
  id: string;
  title: string;
  sandboxId: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  status: "idle" | "running" | "error";
  lastError: string | null;
  archivedAt: number | null;
  parentSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
};

/**
 * SessionAgent-shaped durable store (SQLite).
 * Local stand-in for Cloudflare Durable Object storage.
 */
export class SqliteSessionStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        archived_at INTEGER,
        parent_session_id TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
    `);
  }

  upsert(row: StoredSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, title, sandbox_id, branch, author_name, author_email,
          status, last_error, archived_at, parent_session_id, created_at, last_active_at
        ) VALUES (
          @id, @title, @sandboxId, @branch, @authorName, @authorEmail,
          @status, @lastError, @archivedAt, @parentSessionId, @createdAt, @lastActiveAt
        )
        ON CONFLICT(id) DO UPDATE SET
          title=excluded.title,
          sandbox_id=excluded.sandbox_id,
          branch=excluded.branch,
          author_name=excluded.author_name,
          author_email=excluded.author_email,
          status=excluded.status,
          last_error=excluded.last_error,
          archived_at=excluded.archived_at,
          parent_session_id=excluded.parent_session_id,
          last_active_at=excluded.last_active_at`,
      )
      .run(row);
  }

  get(id: string): StoredSession | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  list(includeArchived: boolean): StoredSession[] {
    const rows = this.db
      .prepare(
        includeArchived
          ? `SELECT * FROM sessions ORDER BY last_active_at DESC`
          : `SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY last_active_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  appendEvent(
    sessionId: string,
    envelope: { seq: number; at: number; origin: string; payload: unknown },
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (session_id, seq, at, origin, payload) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        envelope.seq,
        envelope.at,
        envelope.origin,
        JSON.stringify(envelope.payload),
      );
  }

  events(sessionId: string, fromSeq = 0): unknown[] {
    const rows = this.db
      .prepare(
        `SELECT seq, at, origin, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(sessionId, fromSeq) as {
      seq: number;
      at: number;
      origin: string;
      payload: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      origin: r.origin,
      event: JSON.parse(r.payload),
    }));
  }

  author(row: StoredSession): GitAuthor {
    return { name: row.authorName, email: row.authorEmail };
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(r: Record<string, unknown>): StoredSession {
  return {
    id: String(r.id),
    title: String(r.title),
    sandboxId: String(r.sandbox_id),
    branch: String(r.branch),
    authorName: String(r.author_name),
    authorEmail: String(r.author_email),
    status: r.status as StoredSession["status"],
    lastError: (r.last_error as string | null) ?? null,
    archivedAt: (r.archived_at as number | null) ?? null,
    parentSessionId: (r.parent_session_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
  };
}
