import { afterEach, expect, test } from "bun:test";
import type { AgentConfig, Entry, Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, FakeDaemon } from "@strive/testkit";
import { runHost } from "./main";

// Orderings the real daemon won't produce on demand: a prompt that arrives
// while the host is still rebuilding the conversation.

const ID = "01J8ZSESSIONAAAAAAAAAAAAAA";

let stop: (() => void) | undefined;

afterEach(() => stop?.());

const config = (baseUrl: string): AgentConfig => ({
  cwd: "/tmp/r",
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  baseUrl,
  contextWindow: 200_000,
  maxOutput: 1000,
  turnSeconds: 30,
  compactAtTokens: 150_000,
  instructions: [],
  skills: [],
  mcpTools: [],
});

/** An assistant message as pi-ai records it. */
const reply = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

const history: Entry[] = [
  { seq: 1, tsMs: 0, event: { type: "sessionStarted", format: 1, cwd: "/tmp/r", striveVersion: "x" } },
  { seq: 2, tsMs: 0, event: { type: "userMessage", text: "read a.txt" } },
  { seq: 3, tsMs: 0, event: { type: "turnStarted", turn: 1 } },
  {
    seq: 4,
    tsMs: 0,
    event: {
      type: "assistantMessage",
      turn: 1,
      text: "",
      toolCalls: [{ id: "t1", name: "read" }],
      message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
    },
  },
  {
    seq: 5,
    tsMs: 0,
    event: { type: "effectStarted", effect: 1, callId: "t1", record: { kind: "read", path: "a.txt" } },
  },
  {
    seq: 6,
    tsMs: 0,
    event: {
      type: "effectFinished",
      effect: 1,
      outcome: { kind: "done", output: "sha256:aa", truncated: false },
      durationMs: 1,
    },
  },
  { seq: 7, tsMs: 0, event: { type: "turnEnded", turn: 1, reason: { kind: "done" } } },
];

test("a prompt that arrives while the host is loading the session is still answered", async () => {
  const model = new FakeAnthropic([{ text: "answered" }]).start();
  const recorded: Event[] = [];
  let seq = 7;

  const daemon = new FakeDaemon({
    "host/register": () => ({ result: config(model.url) }),
    "session/attach": () => ({ result: { session: { id: ID, cwd: "/tmp/r", createdAtMs: 0 }, entries: history } }),
    // The rebuild waits on this, and the prompt lands meanwhile.
    "blob/get": (_p, notify) => {
      notify("session/entry", {
        sessionId: ID,
        entry: { seq: 8, tsMs: 0, event: { type: "userMessage", text: "late" } },
      });

      return { result: { text: "file text", bytes: 9 } };
    },
    "host/record": (p) => {
      recorded.push(p.event);

      return { result: { seq: ++seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  await daemon.listen();
  let client: StriveClient | undefined;
  stop = () => {
    client?.close();
    daemon.close();
    model.stop();
  };

  ({ client } = await runHost(daemon.socket, ID));
  const deadline = Date.now() + 5_000;

  while (!recorded.some((e) => e.type === "turnEnded") && Date.now() < deadline) await Bun.sleep(20);

  expect(recorded.find((e) => e.type === "turnEnded")).toMatchObject({ reason: { kind: "done" } });
  expect(JSON.stringify(model.requests[0]?.messages.at(-1))).toContain("late");
});

test("a prompt the interrupted turn hadn't taken yet runs when the host starts again", async () => {
  const model = new FakeAnthropic([{ text: "answered B" }]).start();
  const recorded: Event[] = [];
  let seq = 4;

  const entries: Entry[] = [
    { seq: 1, tsMs: 0, event: { type: "sessionStarted", format: 1, cwd: "/tmp/r", striveVersion: "x" } },
    { seq: 2, tsMs: 0, event: { type: "userMessage", text: "A" } },
    { seq: 3, tsMs: 0, event: { type: "userMessage", text: "B" } },
    { seq: 4, tsMs: 0, event: { type: "turnStarted", turn: 1, throughSeq: 2 } },
  ];

  const daemon = new FakeDaemon({
    "host/register": () => ({ result: config(model.url) }),
    "session/attach": () => ({ result: { session: { id: ID, cwd: "/tmp/r", createdAtMs: 0 }, entries } }),
    "host/record": (p) => {
      recorded.push(p.event);

      return { result: { seq: ++seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  await daemon.listen();
  let client: StriveClient | undefined;
  stop = () => {
    client?.close();
    daemon.close();
    model.stop();
  };

  ({ client } = await runHost(daemon.socket, ID));
  const deadline = Date.now() + 5_000;

  while (recorded.filter((e) => e.type === "turnEnded").length < 2 && Date.now() < deadline) await Bun.sleep(20);

  expect(recorded[0]).toMatchObject({ type: "turnEnded", turn: 1, reason: { kind: "failed" } });
  expect(recorded[1]).toEqual({ type: "turnStarted", turn: 2, throughSeq: 3 });
  const sent = JSON.stringify(model.requests[0]?.messages);
  expect(sent).toContain('"A"');
  expect(JSON.stringify(model.requests[0]?.messages.at(-1))).toContain('"B"');
});

// A notification can arrive after the reply to a later request, so what the
// host has been notified of isn't what its conversation holds.
test("a compaction covers what the conversation holds, not the latest entry the host was told of", async () => {
  const model = new FakeAnthropic([{ text: "the summary" }, { text: "answered C" }]).start();
  const recorded: Event[] = [];
  let seq = 4;

  const entries: Entry[] = [
    { seq: 1, tsMs: 0, event: { type: "userMessage", text: "A" } },
    { seq: 2, tsMs: 0, event: { type: "turnStarted", turn: 1, throughSeq: 1 } },
    {
      seq: 3,
      tsMs: 0,
      event: { type: "assistantMessage", turn: 1, text: "answer to A", toolCalls: [], message: reply("answer to A") },
    },
    { seq: 4, tsMs: 0, event: { type: "turnEnded", turn: 1, reason: { kind: "done" } } },
  ];

  const daemon = new FakeDaemon({
    "host/register": () => ({ result: { ...config(model.url), compactAtTokens: 1 } }),
    "session/attach": (_p, notify) => {
      // C arrives with a seq past anything in the conversation.
      notify("session/entry", {
        sessionId: ID,
        entry: { seq: 40, tsMs: 0, event: { type: "userMessage", text: "C" } },
      });

      return { result: { session: { id: ID, cwd: "/tmp/r", createdAtMs: 0 }, entries } };
    },
    "host/record": (p) => {
      recorded.push(p.event);

      return { result: { seq: ++seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  await daemon.listen();
  let client: StriveClient | undefined;
  stop = () => {
    client?.close();
    daemon.close();
    model.stop();
  };

  ({ client } = await runHost(daemon.socket, ID));
  const deadline = Date.now() + 5_000;

  while (!recorded.some((e) => e.type === "turnEnded") && Date.now() < deadline) await Bun.sleep(20);

  expect(recorded.find((e) => e.type === "compacted")).toMatchObject({ uptoSeq: 4, summary: "the summary" });
});

// The daemon can go away mid-turn (it stopped, or restarted). What the host
// was about to record then fails; that must end the turn quietly, not leave a
// rejection no one handles.
test("losing the daemon mid-turn leaves no unhandled rejection", async () => {
  const model = new FakeAnthropic([{ text: "answered" }]).start();
  const unhandled: string[] = [];
  const onUnhandled = (e: Error) => unhandled.push(e.message);
  process.on("unhandledRejection", onUnhandled);
  let client: StriveClient | undefined;
  let seq = 2;

  const entries: Entry[] = [
    { seq: 1, tsMs: 0, event: { type: "sessionStarted", format: 1, cwd: "/tmp/r", striveVersion: "x" } },
    { seq: 2, tsMs: 0, event: { type: "userMessage", text: "A" } },
  ];

  const daemon = new FakeDaemon({
    "host/register": () => ({ result: config(model.url) }),
    "session/attach": () => ({ result: { session: { id: ID, cwd: "/tmp/r", createdAtMs: 0 }, entries } }),
    "host/record": (p) => {
      // The connection drops once the turn has started: the reply is lost too.
      if (p.event.type === "turnStarted") setTimeout(() => client?.close(), 0);

      return { result: { seq: ++seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  await daemon.listen();
  stop = () => {
    process.off("unhandledRejection", onUnhandled);
    client?.close();
    daemon.close();
    model.stop();
  };

  ({ client } = await runHost(daemon.socket, ID));
  const deadline = Date.now() + 5_000;

  while (model.requests.length === 0 && Date.now() < deadline) await Bun.sleep(20);
  // An absence can only be checked over a window: the turn's failed record
  // rejects within a few ms of the model's reply.
  await Bun.sleep(300);

  expect(model.requests.length).toBeGreaterThan(0);
  expect(unhandled).toEqual([]);
});
