import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import path from "node:path";
import { SessionQueues } from "../src/control/session-queues.js";
import { ResourceLifecycle } from "../src/control/resource-lifecycle.js";
import { GitSandboxManager } from "../src/sandbox/git-sandbox.js";
import { listModels, resolveModel } from "../src/agent/models.js";
import { advanceQueue, branchOfSession, sessionOfBranch } from "../src/session/index.js";
import { nextFreshness, toolEffect } from "../src/slot/index.js";
import { brandNumber, brandString } from "../src/index.js";
import type { Turn } from "../src/index.js";

describe("session queues", () => {
  it("runs work serially per session", async () => {
    const q = new SessionQueues();
    const order: number[] = [];
    const a = q.enqueue("s1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 40));
      order.push(2);
    });
    const b = q.enqueue("s1", async () => {
      order.push(3);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("resource lifecycle", () => {
  it("destroy removes sandbox disk idempotently", async () => {
    const root = path.join("/tmp", "hatch-inspect-test", `lc_${Date.now()}`);
    const mgr = new GitSandboxManager(root);
    const sb = await mgr.create({ id: "life1" });
    const sessions = new Map<
      string,
      {
        id: string;
        sandboxId: string;
        status: "idle" | "running" | "error";
        createdAt: number;
        lastActiveAt: number;
      }
    >();
    const row = {
      id: "ses_life",
      sandboxId: sb.id,
      status: "idle" as const,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    sessions.set(row.id, row);
    const life = new ResourceLifecycle(mgr, { ttlMs: 1 });
    await life.destroy(row, sessions);
    await life.destroy(row, sessions);
    expect(sessions.has(row.id)).toBe(false);
    let gone = false;
    try {
      await access(path.join(root, sb.id));
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });

  it("reap removes idle past TTL and skips running", async () => {
    const root = path.join("/tmp", "hatch-inspect-test", `reap_${Date.now()}`);
    const mgr = new GitSandboxManager(root);
    const idleSb = await mgr.create({ id: "idle1" });
    const runSb = await mgr.create({ id: "run1" });
    const sessions = new Map<
      string,
      {
        id: string;
        sandboxId: string;
        status: "idle" | "running" | "error";
        createdAt: number;
        lastActiveAt: number;
      }
    >();
    sessions.set("idle", {
      id: "idle",
      sandboxId: idleSb.id,
      status: "idle",
      createdAt: 0,
      lastActiveAt: 0,
    });
    sessions.set("run", {
      id: "run",
      sandboxId: runSb.id,
      status: "running",
      createdAt: 0,
      lastActiveAt: 0,
    });
    const life = new ResourceLifecycle(mgr, { ttlMs: 1 });
    const removed = await life.reap(sessions);
    expect(removed).toEqual(["idle"]);
    expect(sessions.has("run")).toBe(true);
  });
});

describe("models", () => {
  it("lists free models and resolves env override", () => {
    expect(listModels().length).toBeGreaterThan(1);
    expect(resolveModel("big-pickle").modelID).toBe("big-pickle");
    expect(resolveModel("custom-x", "acme")).toEqual({
      providerID: "acme",
      modelID: "custom-x",
    });
  });
});

describe("pure policy retained", () => {
  it("nextFreshness and toolEffect", () => {
    const base = brandString<"CommitSha">("aaa");
    const origin = brandString<"CommitSha">("bbb");
    expect(
      nextFreshness({
        current: { kind: "unknown" },
        base,
        origin,
        syncDone: false,
      }).kind,
    ).toBe("stale");
    expect(toolEffect("edit")).toBe("mutating");
  });

  it("advanceQueue and branch round-trip", () => {
    const turns: Turn[] = [
      {
        id: brandString<"TurnId">("t1"),
        author: { id: brandString<"ActorId">("a"), display: "A", github: "a" },
        text: "one",
        state: { kind: "queued" },
      },
    ];
    const result = advanceQueue({
      turns,
      queuePaused: false,
      now: brandNumber<"Timestamp">(1),
    });
    expect(result.kind).toBe("start");
    const id = brandString<"SessionId">("ses_9");
    const branch = branchOfSession("inspect/", id);
    expect(sessionOfBranch("inspect/", branch)).toBe(id);
  });
});
