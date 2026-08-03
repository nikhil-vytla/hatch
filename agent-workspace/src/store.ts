/**
 * Durable workspace state: chat sessions + messages in SQLite.
 * Survives process restarts — the workspace's core promise.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatRole } from "./backend.js";

export type SessionMeta = {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly messageCount: number;
};

export class WorkspaceStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
    `);
  }

  createSession(id: string, title: string): SessionMeta {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, now, now);
    return { id, title, createdAt: now, lastActiveAt: now, messageCount: 0 };
  }

  renameSession(id: string, title: string): boolean {
    const r = this.db
      .prepare(`UPDATE sessions SET title = ? WHERE id = ?`)
      .run(title, id);
    return r.changes > 0;
  }

  deleteSession(id: string): boolean {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    const r = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.last_active_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n
         FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as
      | { id: string; title: string; created_at: number; last_active_at: number; n: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      messageCount: row.n,
    };
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.last_active_at,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n
         FROM sessions s ORDER BY s.last_active_at DESC`,
      )
      .all() as {
      id: string;
      title: string;
      created_at: number;
      last_active_at: number;
      n: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      messageCount: r.n,
    }));
  }

  appendMessage(sessionId: string, role: ChatRole, content: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, at) VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, role, content, now);
    this.db
      .prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
      .run(now, sessionId);
  }

  messages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId) as { role: ChatRole; content: string }[];
    return rows.map((r) => ({ role: r.role, content: r.content }));
  }

  close(): void {
    this.db.close();
  }
}
