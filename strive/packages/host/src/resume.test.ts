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
