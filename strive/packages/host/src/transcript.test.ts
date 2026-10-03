import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { ancestry, CUT_OFF, rebuild, replyText } from "./transcript";

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

test("an effect run again after a crash gives its tool call that result, not the interruption", async () => {
  const entries = [
    assistant("", [{ id: "r", name: "read" }]),
    effect(1, "r", "read"),
    at({ type: "effectCleared", effect: 1 }),
    at({ type: "effectFinished", effect: 1, outcome: { kind: "interrupted" }, durationMs: 0 }),
    at({
      type: "effectRerun",
      effect: 1,
      outcome: { kind: "done", output: "sha256:out1", truncated: false },
      durationMs: 3,
    }),
  ];

  const [, result] = await rebuild(entries, blob);

  expect(result).toMatchObject({ toolCallId: "r", isError: false, content: [{ type: "text", text: "file text" }] });
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

test("a prompt sent while a turn runs follows that turn's reply, as the model saw it", async () => {
  const entries = [
    at({ type: "userMessage", text: "A" }),
    at({ type: "turnStarted", turn: 1 }),
    at({ type: "userMessage", text: "B" }),
    assistant("answer to A"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
    at({ type: "turnStarted", turn: 2 }),
    assistant("answer to B"),
    at({ type: "turnEnded", turn: 2, reason: { kind: "done" } }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => (m.role === "user" ? `user ${m.content}` : m.role))).toEqual([
    "user A",
    "assistant",
    "user B",
    "assistant",
  ]);
});

// Providers drop an aborted or failed reply when it is sent back, so a result
// for one of its tool calls would answer a call the model never sees.
test("tool calls in an interrupted reply get no results", async () => {
  const entries = [
    at({ type: "userMessage", text: "go" }),
    at({
      type: "assistantMessage",
      turn: 1,
      text: "",
      toolCalls: [{ id: "partial", name: "bash" }],
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "partial", name: "bash" }],
        stopReason: "aborted",
      },
    }),
    at({ type: "turnEnded", turn: 1, reason: { kind: "interrupted" } }),
    at({ type: "userMessage", text: "again" }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.some((m) => m.role === "toolResult")).toBe(false);
  expect(messages.at(-1)).toMatchObject({ role: "user", content: "again" });
});

test("prompts waiting across a turn's end keep the order they were sent in", async () => {
  const entries = [
    at({ type: "userMessage", text: "A" }),
    at({ type: "turnStarted", turn: 1 }),
    at({ type: "userMessage", text: "B" }),
    assistant("answer to A"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
    at({ type: "userMessage", text: "C" }),
    at({ type: "turnStarted", turn: 2 }),
    assistant("answer to B and C"),
    at({ type: "turnEnded", turn: 2, reason: { kind: "done" } }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => (m.role === "user" ? `user ${m.content}` : m.role))).toEqual([
    "user A",
    "assistant",
    "user B",
    "user C",
    "assistant",
  ]);
});

test("a prompt journaled before its turn's start but not taken by it waits for the next turn", async () => {
  const a = at({ type: "userMessage", text: "A" });

  const entries = [
    a,
    at({ type: "userMessage", text: "B" }),
    at({ type: "turnStarted", turn: 1, throughSeq: a.seq }),
    assistant("answer to A"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
    at({ type: "turnStarted", turn: 2, throughSeq: a.seq + 1 }),
    assistant("answer to B"),
    at({ type: "turnEnded", turn: 2, reason: { kind: "done" } }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => (m.role === "user" ? `user ${m.content}` : m.role))).toEqual([
    "user A",
    "assistant",
    "user B",
    "assistant",
  ]);
});

test("the prompt of the turn that was compacted comes back after the summary", async () => {
  const before = [
    at({ type: "userMessage", text: "old" }),
    at({ type: "turnStarted", turn: 1 }),
    assistant("old answer"),
  ];

  const end = at({ type: "turnEnded", turn: 1, reason: { kind: "done" } });
  const prompt = at({ type: "userMessage", text: "new" });

  const entries = [
    ...before,
    end,
    prompt,
    at({ type: "compacted", uptoSeq: end.seq, summary: "we talked" }),
    at({ type: "turnStarted", turn: 2, throughSeq: prompt.seq }),
    assistant("new answer"),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => (m.role === "user" ? `user ${m.content}` : m.role))).toEqual([
    "user [A summary of the conversation so far]\n\nwe talked",
    "user new",
    "assistant",
  ]);
});

test("a prompt sent during the turn before a compaction comes back after the summary, not the old reply", async () => {
  const a = at({ type: "userMessage", text: "A" });

  const entries = [
    a,
    at({ type: "turnStarted", turn: 1, throughSeq: a.seq }),
    at({ type: "userMessage", text: "B" }),
    assistant("answer to A"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
  ];

  const b = entries[2]!;
  const last = entries.at(-1)!;
  entries.push(
    at({ type: "compacted", uptoSeq: last.seq, summary: "A was answered" }),
    at({ type: "turnStarted", turn: 2, throughSeq: b.seq }),
    assistant("answer to B"),
  );

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => (m.role === "user" ? `user ${m.content}` : m.role))).toEqual([
    "user [A summary of the conversation so far]\n\nA was answered",
    "user B",
    "assistant",
  ]);
});

test("a layout proposal the agent made comes back as that tool call's result", async () => {
  const entries = [
    at({ type: "userMessage", text: "tidy the layout" }),
    at({ type: "turnStarted", turn: 1 }),
    assistant("", [{ id: "t9", name: "propose_layout" }]),
    at({ type: "layoutProposed", callId: "t9", label: "spend by the chat", ops: [] }),
    assistant("Proposed."),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
  ];

  const messages = await rebuild(entries, blob);
  const result = messages.find((m) => m.role === "toolResult");
  expect(result).toMatchObject({ toolCallId: "t9", isError: false });
  expect(JSON.stringify(result)).toContain("Proposed");
});

// The journal is the daemon's, but what a host recorded in it is the
// host's: a record that isn't an assistant message is skipped, not trusted,
// so one bad record can't stop every later host from resuming.
test("an assistant record that isn't a message is skipped on resume", async () => {
  const entries: Entry[] = [
    at({ type: "userMessage", text: "hello" }),
    at({ type: "assistantMessage", turn: 1, text: "", toolCalls: [], message: null }),
    at({ type: "assistantMessage", turn: 1, text: "", toolCalls: [], message: { role: "user", content: "forged" } }),
    at({ type: "userMessage", text: "again" }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
});

test("a check report the agent was told comes back even when the host stopped before it replied", async () => {
  const entries = [
    at({ type: "userMessage", text: "make a.txt" }),
    at({ type: "turnStarted", turn: 1 }),
    assistant("Done."),
    at({
      type: "effectStarted",
      effect: 1,
      callId: "check:1:1:t",
      record: { kind: "check", name: "t", command: "false", timeoutMs: 1000, note: "" },
    }),
    at({
      type: "effectFinished",
      effect: 1,
      outcome: { kind: "done", output: "sha256:out2", exitCode: 1, truncated: false },
      durationMs: 1,
    }),
    at({ type: "checksReported", turn: 1, text: "strive ran this project's checks on your changes, and one failed." }),
    // The host stopped here; its successor closed the turn.
    at({ type: "turnEnded", turn: 1, reason: { kind: "failed", error: "the agent host stopped during this turn" } }),
  ];

  const messages = await rebuild(entries, blob);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(messages[2]).toMatchObject({ role: "user", content: expect.stringContaining("one failed") });
});

test("a check run no report followed isn't told to the agent", async () => {
  const entries = [
    at({ type: "userMessage", text: "make a.txt" }),
    at({ type: "turnStarted", turn: 1 }),
    assistant("Done."),
    at({
      type: "effectStarted",
      effect: 2,
      callId: "check:1:1:t",
      record: { kind: "check", name: "t", command: "false", timeoutMs: 1000, note: "" },
    }),
    at({
      type: "effectFinished",
      effect: 2,
      outcome: { kind: "done", output: "sha256:out2", exitCode: 1, truncated: false },
      durationMs: 1,
    }),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
  ];

  expect((await rebuild(entries, blob)).map((m) => m.role)).toEqual(["user", "assistant"]);
});

const sse = (...texts: string[]) =>
  texts
    .map(
      (text) =>
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    )
    .join("");

const call = (n: number, request: string, response?: string) => [
  at({
    type: "modelCallStarted",
    call: n,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    request,
    reservedUsdMicros: 1,
    reservedTokens: 1,
  }),
  at({
    type: "modelCallFinished",
    call: n,
    outcome: { kind: "broken", reason: "the client went away", costUsdMicros: 1, tokens: 1 },
    response,
    durationMs: 1,
  }),
];

blobs.set("sha256:agent", JSON.stringify({ tools: [{ name: "read" }], messages: [] }));

blobs.set("sha256:summary", JSON.stringify({ messages: [] }));

blobs.set(
  "sha256:judge",
  JSON.stringify({ tools: [{ name: "verdict" }], tool_choice: { type: "tool", name: "verdict" } }),
);

blobs.set("sha256:cut", sse("I'll fix the ", "failing test by"));

test("a reply given but never recorded, as when the host stopped, is told on resume as it was given", async () => {
  const entries = [
    at({ type: "userMessage", text: "fix the test" }),
    at({ type: "turnStarted", turn: 1 }),
    ...call(1, "sha256:agent", "sha256:cut"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "failed", error: "the agent host stopped during this turn" } }),
    at({ type: "userMessage", text: "go on" }),
  ];

  const messages = await rebuild(entries, blob);

  expect(messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
  expect(messages[1]).toMatchObject({ content: `${CUT_OFF}\n\nI'll fix the failing test by` });
  expect(messages[2]).toMatchObject({ content: "go on" });
});

test("a recorded reply, a summary's call and the judge's are not told again", async () => {
  const recorded = [
    at({ type: "userMessage", text: "hi" }),
    at({ type: "turnStarted", turn: 1 }),
    ...call(1, "sha256:agent", "sha256:cut"),
    assistant("I'll fix the failing test by"),
    at({ type: "turnEnded", turn: 1, reason: { kind: "done" } }),
  ];

  expect((await rebuild(recorded, blob)).map((m) => m.role)).toEqual(["user", "assistant"]);

  for (const request of ["sha256:summary", "sha256:judge"]) {
    const entries = [
      at({ type: "userMessage", text: "hi" }),
      at({ type: "turnStarted", turn: 1 }),
      ...call(1, request, "sha256:cut"),
      at({ type: "turnEnded", turn: 1, reason: { kind: "failed", error: "stopped" } }),
    ];

    expect((await rebuild(entries, blob)).map((m) => m.role)).toEqual(["user"]);
  }
});

test("a reply's text is read from each provider's stream, and from a whole response", () => {
  expect(replyText(sse("a", "b"))).toBe("ab");

  const chat = ["Hel", "lo"]
    .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
    .join("");

  expect(replyText(`${chat}data: [DONE]\n\n`)).toBe("Hello");

  const responses = ["Hi", " there"]
    .map((d) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: d })}\n\n`)
    .join("");

  expect(replyText(responses)).toBe("Hi there");
  expect(replyText(JSON.stringify({ content: [{ type: "text", text: "whole" }, { type: "tool_use" }] }))).toBe("whole");
  expect(replyText("not a response")).toBe("");
});

test("a fork's parents are followed back, oldest first, and none past a summary", async () => {
  const journals = new Map<string, Entry[]>([
    ["A", [at({ type: "userMessage", text: "in A" }), at({ type: "userMessage", text: "after the fork" })]],
    ["B", [at({ type: "forkedFrom", session: "A", seq: seq - 1 }), at({ type: "userMessage", text: "in B" })]],
  ]);

  const read = async (id: string) => journals.get(id)!;
  const own = [at({ type: "forkedFrom", session: "B", seq }), at({ type: "userMessage", text: "mine" })];
  const chain = await ancestry(own, read);

  expect(chain.map((c) => c.session)).toEqual(["A", "B"]);
  expect(chain[0]!.entries.map((e) => e.event)).toEqual([{ type: "userMessage", text: "in A" }]);
  const summarized = [...own, at({ type: "compacted", uptoSeq: seq, summary: "all of it" })];

  expect(await ancestry(summarized, read)).toEqual([]);
});
