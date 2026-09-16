import { describe, expect, it } from "vitest";
import path from "node:path";
import { SqliteSessionStore } from "../src/control/session-store-sqlite.js";
import { ComputeClient } from "../src/compute/client.js";

describe("sqlite session store", () => {
  it("upserts, lists, and stores events", () => {
    const dbPath = path.join(
      "/tmp",
      "hatch-inspect-test",
      `store_${Date.now()}.sqlite`,
    );
    const store = new SqliteSessionStore(dbPath);
    store.upsert({
      id: "ses_1",
      title: "t",
      sandboxId: "sb_1",
      branch: "inspect/sb_1",
      authorName: "A",
      authorEmail: "a@x",
      status: "idle",
      lastError: null,
      archivedAt: null,
      parentSessionId: null,
      createdAt: 1,
      lastActiveAt: 2,
    });
    expect(store.get("ses_1")?.title).toBe("t");
    store.appendEvent("ses_1", {
      seq: 1,
      at: 3,
      origin: "system",
      payload: { kind: "session.started" },
    });
    expect(store.events("ses_1")).toHaveLength(1);
    store.delete("ses_1");
    expect(store.get("ses_1")).toBeUndefined();
    store.close();
  });
});

describe("compute client", () => {
  it("constructs", () => {
    const c = new ComputeClient({ baseUrl: "http://example.com/" });
    expect(c).toBeTruthy();
  });
});
