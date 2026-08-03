import type { GitSandboxManager } from "../sandbox/git-sandbox.js";

export type LifecycleSession = {
  id: string;
  sandboxId: string;
  status: "idle" | "running" | "error";
  createdAt: number;
  lastActiveAt: number;
  /** Soft-hidden sessions keep disk until DELETE; TTL reap skips them. */
  archivedAt?: number | null;
};

/**
 * Owns sandbox disk lifetime. Destroy is idempotent.
 * Reap removes idle sessions older than ttlMs.
 */
export class ResourceLifecycle {
  constructor(
    private readonly sandboxes: GitSandboxManager,
    private readonly opts: { readonly ttlMs: number },
  ) {}

  touch(session: LifecycleSession): void {
    session.lastActiveAt = Date.now();
  }

  async destroy(
    session: LifecycleSession,
    sessions: Map<string, { id: string }>,
  ): Promise<void> {
    sessions.delete(session.id);
    await this.sandboxes.destroy(session.sandboxId);
  }

  async reap(
    sessions: Map<string, LifecycleSession>,
  ): Promise<readonly string[]> {
    const now = Date.now();
    const removed: string[] = [];
    for (const session of [...sessions.values()]) {
      if (session.status === "running") continue;
      if (session.archivedAt) continue;
      if (now - session.lastActiveAt < this.opts.ttlMs) continue;
      await this.destroy(session, sessions);
      removed.push(session.id);
    }
    return removed;
  }
}
