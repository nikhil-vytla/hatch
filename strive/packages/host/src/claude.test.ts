// The Claude Code engine end to end (ADR-0031): a real daemon starts this
// host, which runs Claude Code through its SDK against a scripted model
// behind the daemon's gateway. Every tool call is gated by the daemon and
// journaled as observed.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Entry, type Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, type ModelRequest, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;

setDefaultTimeout(60_000);

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

let clients: StriveClient[] = [];

afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  daemon?.dispose();
  fake?.stop();
});

async function setup(reply: (request: ModelRequest) => ScriptedReply, mode: "ask" | "fullAuto") {
  fake = new FakeAnthropic(reply).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-claude-"));
  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  clients.push(client);
  const { id } = await client.request("session/create", { cwd, engine: "claude-code" });

  await client.request("session/approvals", { id, mode });

  return { client, id, cwd };
}

async function events(client: StriveClient, id: string): Promise<Event[]> {
  return (await client.request("session/read", { id })).entries.map((e: Entry) => e.event);
}

/** The session's events once `n` turns have ended, each of them done (else how one ended). */
async function untilTurnsEnded(client: StriveClient, id: string, n: number): Promise<Event[]> {
  const deadline = Date.now() + 50_000;

  for (;;) {
    const e = await events(client, id);
    const ended = e.filter((x) => x.type === "turnEnded");

    if (ended.length >= n) {
      for (const t of ended) expect(t).toMatchObject({ reason: { kind: "done" } });

      return e;
    }

    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(e.map((x) => x.type))}`);
    await Bun.sleep(100);
  }
}

const last = (r: ModelRequest) => JSON.stringify(r.messages.at(-1)?.content ?? "");

test("Claude Code runs a turn: its read is gated and journaled as observed, and its reply recorded", async () => {
  let cwd = "";

  const s = await setup(
    (r) =>
      last(r).includes("tool_result")
        ? { text: "The file says hello." }
        : { toolCalls: [{ id: "toolu_1", name: "Read", input: { file_path: join(cwd, "a.txt") } }] },
    "fullAuto",
  );

  cwd = s.cwd;
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  await s.client.request("session/prompt", { id: s.id, text: "What does a.txt say?" });
  const e = await untilTurnsEnded(s.client, s.id, 1);
  const started = e.find((x) => x.type === "effectStarted");

  expect(started).toMatchObject({
    callId: "toolu_1",
    record: { kind: "observed", engine: "claude-code", tool: "Read" },
  });
  const effect = started?.type === "effectStarted" ? started.effect : -1;

  expect(e.some((x) => x.type === "effectCleared" && x.effect === effect)).toBe(true);
  const finished = e.find((x) => x.type === "effectFinished" && x.effect === effect);

  expect(finished).toMatchObject({ outcome: { kind: "done" } });
  const output = finished?.type === "effectFinished" && finished.outcome.kind === "done" ? finished.outcome.output : "";

  expect((await s.client.request("blob/get", { digest: output })).text).toContain("hello");
  expect(
    e.filter((x) => x.type === "assistantMessage").map((x) => (x.type === "assistantMessage" ? x.text : "")),
  ).toContain("The file says hello.");
  // Its model calls went through the gateway: each one journaled, with its cost.
  expect(e.filter((x) => x.type === "modelCallFinished").length).toBeGreaterThanOrEqual(2);
});

test("a call the daemon refuses doesn't run, and Claude Code is told why", async () => {
  const s = await setup(
    (r) =>
      last(r).includes("tool_result")
        ? { text: "I couldn't run it." }
        : { toolCalls: [{ id: "toolu_1", name: "Bash", input: { command: "touch made.txt" } }] },
    "ask",
  );

  await s.client.request("session/prompt", { id: s.id, text: "make a file" });
  const e = await untilTurnsEnded(s.client, s.id, 1);
  const finished = e.find((x) => x.type === "effectFinished");

  expect(finished).toMatchObject({ outcome: { kind: "refused" } });
  expect(JSON.stringify(finished)).toContain("needs a person's approval");
  expect(e.some((x) => x.type === "effectCleared")).toBe(false);
  expect(await Bun.file(join(s.cwd, "made.txt")).exists()).toBe(false);
  expect(JSON.stringify(fake!.requests.at(-1)?.messages.at(-1))).toContain("needs a person's approval");
});

test("a later prompt goes on with the same Claude Code session", async () => {
  const s = await setup((r) => ({ text: r.messages.length > 1 ? "second answer" : "first answer" }), "fullAuto");

  await s.client.request("session/prompt", { id: s.id, text: "first question" });
  await untilTurnsEnded(s.client, s.id, 1);
  await s.client.request("session/prompt", { id: s.id, text: "second question" });
  await untilTurnsEnded(s.client, s.id, 2);
  const sent = JSON.stringify(fake!.requests.at(-1)?.messages);

  expect(sent).toContain("first question");
  expect(sent).toContain("first answer");
  expect(sent).toContain("second question");
});

test("a sandboxed command still asks the daemon first, even in full-auto", async () => {
  const s = await setup(
    (r) =>
      last(r).includes("tool_result")
        ? { text: "Made it." }
        : { toolCalls: [{ id: "toolu_1", name: "Bash", input: { command: "touch made.txt" } }] },
    "fullAuto",
  );

  await s.client.request("session/prompt", { id: s.id, text: "make a file" });
  const e = await untilTurnsEnded(s.client, s.id, 1);
  const started = e.find((x) => x.type === "effectStarted");

  expect(started).toMatchObject({ record: { kind: "observed", tool: "Bash" } });
  const effect = started?.type === "effectStarted" ? started.effect : -1;
  const cleared = e.findIndex((x) => x.type === "effectCleared" && x.effect === effect);
  const finished = e.findIndex((x) => x.type === "effectFinished" && x.effect === effect);

  expect(cleared).toBeGreaterThan(-1);
  expect(finished).toBeGreaterThan(cleared);
});

test("a model chosen between turns is the one Claude Code runs the next turn on", async () => {
  const s = await setup((r) => ({ text: r.messages.length > 1 ? "second answer" : "first answer" }), "fullAuto");

  await s.client.request("session/model", { id: s.id, model: "claude-haiku-4-5" });
  await s.client.request("session/prompt", { id: s.id, text: "first question" });
  await untilTurnsEnded(s.client, s.id, 1);
  const before = fake!.requests.length;

  await s.client.request("session/model", { id: s.id, model: "claude-opus-4-5" });
  await s.client.request("session/prompt", { id: s.id, text: "second question" });
  await untilTurnsEnded(s.client, s.id, 2);
  const models = (from: number, to?: number) => new Set(fake!.requests.slice(from, to).map((r) => r.model));

  expect(models(0, before).has("claude-haiku-4-5")).toBe(true);
  expect(models(before)).toEqual(new Set(["claude-opus-4-5"]));
});
