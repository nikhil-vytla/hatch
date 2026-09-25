import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { cut, outputsOf, pick } from "../shared/cited";
import { blocks } from "./cited";

const OUT = `sha256:${"a".repeat(64)}`;

const READ_OUT = `sha256:${"b".repeat(64)}`;

const journal = (...events: Event[]): Entry[] => events.map((event, i) => ({ seq: i + 1, tsMs: i * 1000, event }));

const session = journal(
  { type: "userMessage", text: "run the tests" },
  { type: "assistantMessage", turn: 1, text: "", toolCalls: [{ id: "c1", name: "bash" }], message: {} },
  { type: "effectStarted", effect: 1, callId: "c1", record: { kind: "bash", command: "bun test", timeoutMs: 1000 } },
  {
    type: "effectFinished",
    effect: 1,
    outcome: { kind: "done", output: OUT, exitCode: 1, truncated: false },
    durationMs: 5,
  },
  { type: "effectStarted", effect: 2, callId: "c2", record: { kind: "read", path: "/w/src/a.ts" } },
  { type: "effectFinished", effect: 2, outcome: { kind: "done", output: READ_OUT, truncated: false }, durationMs: 1 },
  { type: "effectStarted", effect: 3, callId: "c3", record: { kind: "bash", command: "rm -rf /", timeoutMs: 1000 } },
  { type: "effectFinished", effect: 3, outcome: { kind: "refused", reason: "the person declined" }, durationMs: 1 },
);

const seqs = (entries: Entry[]) => entries.map((e) => e.seq);

test("citing either half of an effect picks both, and nothing else", () => {
  expect(seqs(pick(session, [4]))).toEqual([3, 4]);
  expect(seqs(pick(session, [3]))).toEqual([3, 4]);
  expect(seqs(pick(session, [1, 8]))).toEqual([1, 7, 8]);
  expect(seqs(pick(session, [99]))).toEqual([]);
  expect(outputsOf(pick(session, [1, 4, 8]))).toEqual([OUT]);
});

test("cited entries read as who did what, with a result's output under it", () => {
  const cited = [1, 2, 4, 5, 8, 99];
  const picked = pick(session, cited);
  const shown = blocks({ entries: picked, outputs: { [OUT]: "1 fail\n" } }, cited, "/w");

  expect(shown.blocks.map((b) => [b.seq, b.cited, b.who, b.text])).toEqual([
    [1, true, "You", "run the tests"],
    [2, true, "Agent", "Called bash."],
    [3, false, "Ran", "bun test"],
    [4, true, "Result of #3", "Exit 1"],
    [5, true, "Read", "src/a.ts"],
    [6, false, "Result of #5", "Done; its output isn't kept"],
    [7, false, "Ran", "rm -rf /"],
    [8, true, "Result of #7", "Refused: the person declined"],
  ]);

  expect(shown.blocks.find((b) => b.seq === 4)?.output).toBe("1 fail");
  expect(shown.missing).toEqual([99]);
});

test("a long output keeps its start and its end", () => {
  const text = `${"a".repeat(3000)}${"z".repeat(3000)}`;
  const kept = cut(text, 1000);

  expect(kept.startsWith("a".repeat(400))).toBe(true);
  expect(kept.endsWith("z".repeat(600))).toBe(true);
  expect(kept).toContain("5000 characters cut");
  expect(cut("short", 1000)).toBe("short");
});
