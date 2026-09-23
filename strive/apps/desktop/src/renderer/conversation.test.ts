import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { Conversation, summarize } from "./conversation";

const digest = "sha256:00";

function fold(events: Event[], startMs = 1_000): Conversation {
  const c = new Conversation();
  events.forEach((event, i) => c.apply({ seq: i + 1, tsMs: startMs + i * 500, event } satisfies Entry));

  return c;
}

const bash = (effect: number, command: string): Event => ({
  type: "effectStarted",
  effect,
  callId: `c${effect}`,
  record: { kind: "bash", command, timeoutMs: 1000 },
});

const read = (effect: number, path: string): Event => ({
  type: "effectStarted",
  effect,
  callId: `c${effect}`,
  record: { kind: "read", path },
});

const done = (effect: number, exitCode?: number): Event => ({
  type: "effectFinished",
  effect,
  outcome: { kind: "done", output: digest, exitCode, truncated: false },
  durationMs: 20,
});

const reply = (text: string): Event => ({ type: "assistantMessage", turn: 1, text, toolCalls: [], message: {} });

test("a step's tools are one group, and a reply starts the next", () => {
  const c = fold([
    { type: "userMessage", text: "fix it" },
    reply("Looking."),
    read(1, "a.ts"),
    bash(2, "bun test"),
    done(1),
    done(2, 1),
    reply("Fixing."),
    bash(3, "bun test"),
    done(3, 0),
  ]);

  expect(c.items.map((i) => i.kind)).toEqual(["user", "reply", "tools", "reply", "tools"]);
  const first = c.items[2];
  expect(first?.kind === "tools" && first.tools.map((t) => t.status)).toEqual(["done", "failed"]);
  expect(first?.kind === "tools" && summarize(first.tools)).toBe("Ran 1 command · read 1 file · 1 failed");
});

test("a tool waits while its approval is open, and remembers the decision", () => {
  const asked = fold([
    bash(1, "rm -rf build"),
    { type: "approvalRequested", effect: 1, description: "run: rm -rf build" },
  ]);

  expect(asked.waiting().map((t) => t.effect)).toEqual([1]);

  const decided = fold([
    bash(1, "rm -rf build"),
    { type: "approvalRequested", effect: 1, description: "run: rm -rf build" },
    { type: "approvalDecided", effect: 1, decision: "deny", by: "strive-desktop" },
    { type: "effectFinished", effect: 1, outcome: { kind: "refused", reason: "a person declined" }, durationMs: 1 },
  ]);

  const tools = decided.items[0];
  expect(decided.waiting()).toEqual([]);
  expect(tools?.kind === "tools" && tools.tools[0]).toMatchObject({
    status: "refused",
    reason: "a person declined",
    approval: { description: "run: rm -rf build", decided: "deny" },
  });
});

test("a finished turn says how long it took and what its calls cost", () => {
  const complete = (costUsdMicros: number): Event => ({
    type: "modelCallFinished",
    call: 1,
    outcome: {
      kind: "complete",
      status: 200,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0 },
      costUsdMicros,
    },
    durationMs: 5,
  });

  const c = fold([
    { type: "turnStarted", turn: 1 },
    complete(1200),
    complete(800),
    { type: "turnEnded", turn: 1, reason: { kind: "done" } },
  ]);

  expect(c.items).toEqual([{ kind: "turn", seq: 4, reason: { kind: "done" }, durationMs: 1500, costUsdMicros: 2000 }]);
});

test("only calls that went wrong and events without a place of their own become notices", () => {
  const c = fold([
    { type: "checkpointed", checkpoint: 1, commit: "abc" },
    { type: "modelCallFinished", call: 1, outcome: { kind: "rejected", status: 429 }, durationMs: 5 },
    { type: "rewound", to: 1, savedAs: 2 },
  ]);

  expect(c.items.map((i) => (i.kind === "notice" ? i.text : i.kind))).toEqual([
    "The provider refused the call (HTTP 429).",
    "Rewound to checkpoint 1. Undo with /rewind 2.",
  ]);
});

test("an approval cancelled with its command (an interrupt) stops waiting, though nobody decided it", () => {
  const c = fold([
    bash(1, "sleep 100"),
    { type: "approvalRequested", effect: 1, description: "run: sleep 100" },
    {
      type: "effectFinished",
      effect: 1,
      outcome: { kind: "refused", reason: "interrupted: run: sleep 100" },
      durationMs: 1,
    },
  ]);

  expect(c.waiting()).toEqual([]);
  const tools = c.items[0];
  expect(tools?.kind === "tools" && tools.tools[0]?.status).toBe("refused");
});
