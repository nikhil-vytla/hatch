import { describe, expect, it } from "vitest";
import {
  advanceQueue,
  branchOfSession,
  brandNumber,
  brandString,
  createInspect,
  fixedClock,
  localPorts,
  nextFreshness,
  sessionOfBranch,
  toolEffect,
} from "../src/index.js";
import type { Turn } from "../src/index.js";

describe("pure policy", () => {
  it("nextFreshness goes stale then fresh after sync", () => {
    const base = brandString<"CommitSha">("aaa");
    const origin = brandString<"CommitSha">("bbb");
    const stale = nextFreshness({
      current: { kind: "unknown" },
      base,
      origin,
      syncDone: false,
    });
    expect(stale).toEqual({ kind: "stale", base, origin });
    const syncing = nextFreshness({
      current: { kind: "syncing", base, origin },
      base,
      origin,
      syncDone: false,
    });
    expect(syncing.kind).toBe("syncing");
    const fresh = nextFreshness({
      current: syncing,
      base,
      origin,
      syncDone: true,
    });
    expect(fresh).toEqual({ kind: "fresh", head: origin });
  });

  it("advanceQueue starts next queued turn", () => {
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
    if (result.kind === "start") {
      expect(result.turnId).toBe("t1");
      expect(result.turns[0]?.state.kind).toBe("running");
    }
  });

  it("branch round-trips", () => {
    const id = brandString<"SessionId">("ses_9");
    const branch = branchOfSession("inspect/", id);
    expect(branch).toBe("inspect/ses_9");
    expect(sessionOfBranch("inspect/", branch)).toBe(id);
  });

  it("toolEffect classifies writes", () => {
    expect(toolEffect("read")).toBe("read-only");
    expect(toolEffect("edit")).toBe("mutating");
  });
});

describe("local inspect flow", () => {
  it("create → prompt → stream → PR with sync gate", async () => {
    const clock = fixedClock(1_000_000);
    const ports = await localPorts({
      syncDelayMs: 30,
      clock,
      repos: [{ owner: "acme", name: "billing" }],
      baseCommit: "base000",
      originCommit: "origin001",
    });
    const inspect = await createInspect(ports);
    const ws = await inspect.workspace({ owner: "acme", name: "billing" });
    ws.hint({ kind: "composing", actorId: brandString<"ActorId">("ana") });

    const ana = {
      id: brandString<"ActorId">("ana"),
      display: "Ana",
      github: "ana",
    };
    const session = await ws.start({
      opener: ana,
      conversation: { surface: "web", key: "demo" },
      intent: "Fix invoice rounding",
    });

    const kinds: string[] = [];
    for await (const env of session.events()) {
      kinds.push(env.event.kind);
      if (env.event.kind === "freshness") {
        expect(["stale", "syncing", "fresh", "unknown"]).toContain(
          env.event.freshness.kind,
        );
      }
      if (env.event.kind === "turn.finished") break;
    }

    expect(kinds).toContain("session.started");
    expect(kinds).toContain("turn.queued");
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("agent.delta");
    expect(kinds).toContain("freshness");
    expect(kinds).toContain("turn.finished");

    const pr = await session.publish({
      by: ana.id,
      title: "Fix invoice rounding",
    });
    expect(pr.url).toContain("/pull/");
    expect(pr.branch).toMatch(/^inspect\//);

    const view = await session.view();
    expect(view.authors.map((a) => a.id)).toContain("ana");
    expect(view.ideUrl).toMatch(/^local:\/\/ide\//);
  });

  it("dispatch classifies repo and is multiplayer-safe", async () => {
    const ports = await localPorts({
      syncDelayMs: 10,
      repos: [
        { owner: "acme", name: "billing" },
        { owner: "acme", name: "payroll" },
      ],
    });
    const inspect = await createInspect(ports);
    const speaker = {
      id: brandString<"ActorId">("bob"),
      display: "Bob",
      github: "bob",
    };
    const first = await inspect.dispatch({
      surface: "slack",
      conversation: { surface: "slack", channel: "C1", thread: "T1" },
      speaker,
      text: "fix flaky test in billing",
      hints: { channelName: "eng-billing" },
    });
    expect(first.kind === "started" || first.kind === "continued").toBe(true);
    if (first.kind !== "started" && first.kind !== "continued") return;

    const bea = {
      id: brandString<"ActorId">("bea"),
      display: "Bea",
      github: "bea",
    };
    await first.session.submit({ author: bea, text: "also bump timeout", clientToken: "k1" });
    await first.session.submit({ author: bea, text: "also bump timeout", clientToken: "k1" });

    const view = await first.session.view();
    expect(view.authors.length).toBeGreaterThanOrEqual(1);

    const amb = await inspect.dispatch({
      surface: "slack",
      conversation: { surface: "slack", channel: "C2", thread: "T2" },
      speaker,
      text: "please help",
    });
    expect(amb.kind).toBe("unknown");
  });

  it("stop current turn", async () => {
    const ports = await localPorts({ syncDelayMs: 200 });
    const inspect = await createInspect(ports);
    const ws = await inspect.workspace({ owner: "acme", name: "billing" });
    const ana = {
      id: brandString<"ActorId">("ana"),
      display: "Ana",
      github: "ana",
    };
    const session = await ws.start({
      opener: ana,
      conversation: { surface: "api", key: "stop-demo" },
    });
    await session.submit({ author: ana, text: "long task" });
    await session.stop({ by: ana.id, scope: "current-turn" });
    // Allow mailbox to settle
    await new Promise((r) => setTimeout(r, 50));
    const view = await session.view();
    expect(view.queue.every((t) => t.state.kind !== "running")).toBe(true);
  });
});
