import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { rebuild } from "./transcript";

let seq = 0;

const at = (event: Event): Entry => ({ seq: ++seq, tsMs: 1000 + seq, event });

const assistant = (text: string, calls: { id: string; name: string }[] = []) =>
  at({
    type: "assistantMessage",
    turn: 1,
    text,
    toolCalls: calls,
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: calls.length ? "toolUse" : "stop" },
  });

const effect = (n: number, callId: string, kind: "read" | "bash") =>
  at({
    type: "effectStarted",
    effect: n,
    callId,
    record: kind === "bash" ? { kind: "bash", command: "false", timeoutMs: 1000 } : { kind: "read", path: "a.txt" },
  });

const blobs = new Map([
  ["sha256:out1", "file text"],
  ["sha256:out2", "some output\n"],
]);

const blob = async (d: string) => blobs.get(d)!;

test("prompts and replies come back in order, and other events are skipped", async () => {
  const entries = [
    at({ type: "sessionStarted", format: 1, cwd: "/w", striveVersion: "x" }),
    at({ type: "budgetSet", usdMicros: 5 }),
    at({ type: "checkpointed", checkpoint: 1, commit: "c" }),
    at({ type: "userMessage", text: "hello" }),
    at({ type: "turnStarted", turn: 1 }),
    assistant("hi there"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(messages[0]).toMatchObject({ role: "user", content: "hello" });
  expect(messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hi there" }] });
});

test("each tool call gets the daemon's result, in call order", async () => {
  const entries = [
    at({ type: "userMessage", text: "look" }),
    assistant("", [
      { id: "t1", name: "read" },
      { id: "t2", name: "bash" },
    ]),
    effect(1, "t2", "bash"),
    effect(2, "t1", "read"),
    at({
      type: "effectFinished",
      effect: 2,
      outcome: { kind: "done", output: "sha256:out1", truncated: false },
      durationMs: 1,
    }),
    at({
      type: "effectFinished",
      effect: 1,
      outcome: { kind: "done", output: "sha256:out2", exitCode: 3, truncated: false },
      durationMs: 1,
    }),
  ];

  const [, , first, second] = await rebuild(entries, blob);
  expect(first).toMatchObject({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text: "file text" }],
  });
  expect(second).toMatchObject({
    role: "toolResult",
    toolCallId: "t2",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "some output\n[exit code 3]" }],
  });
});

test("refused and interrupted effects are errors the model can read", async () => {
  const entries = [
    assistant("", [
      { id: "a", name: "bash" },
      { id: "b", name: "read" },
    ]),
    effect(1, "a", "bash"),
    at({
      type: "effectFinished",
      effect: 1,
      outcome: { kind: "refused", reason: "declined: run: false" },
      durationMs: 0,
    }),
    effect(2, "b", "read"),
    at({ type: "effectFinished", effect: 2, outcome: { kind: "interrupted" }, durationMs: 0 }),
  ];

  const results = (await rebuild(entries, blob)).slice(1);
  expect(results).toMatchObject([
    { toolCallId: "a", isError: true, content: [{ type: "text", text: "declined: run: false" }] },
    {
      toolCallId: "b",
      isError: true,
      content: [{ type: "text", text: "the daemon stopped while this ran; whatever it changed stays changed" }],
    },
  ]);
});

test("a tool call that never ran still gets a result, so the transcript stays valid", async () => {
  const entries = [
    assistant("", [{ id: "x", name: "write" }]),
    at({ type: "turnEnded", turn: 1, reason: { kind: "interrupted" } }),
    at({ type: "userMessage", text: "go on" }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
  expect(messages[1]).toMatchObject({
    toolCallId: "x",
    isError: true,
    content: [{ type: "text", text: "this tool call did not run: the turn ended first" }],
  });
});
