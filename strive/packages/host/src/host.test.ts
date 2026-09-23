// The agent loop end to end: real daemon, real host (started by the daemon),
// real gateway and effects, and a scripted model at the network boundary.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Entry, type Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;
setDefaultTimeout(30_000);

let daemon: TestDaemon | undefined;
let fake: FakeAnthropic | undefined;
let clients: StriveClient[] = [];
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  daemon?.dispose();
  fake?.stop();
});

async function setup(script: ScriptedReply[]) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-agent-"));
  const client = await connect();
  const { id } = await client.request("session/create", { cwd });
  return { client, id, cwd };
}

async function connect() {
  const { client } = await StriveClient.connect(daemon!.socket, { name: "test", version: "0" });
  clients.push(client);
  return client;
}

async function events(client: StriveClient, id: string): Promise<Event[]> {
  return (await client.request("session/read", { id })).entries.map((e: Entry) => e.event);
}

async function waitFor(client: StriveClient, id: string, done: (e: Event[]) => boolean, ms = 15_000): Promise<Event[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const e = await events(client, id);
    if (done(e)) return e;
        if (Date.now() > deadline) {
      const log = (() => {
        try {
          return readFileSync(join(daemon!.home, "sessions", id, "host.log"), "utf8");
        } catch {
          return "(no host log)";
        }
      })();
      throw new Error(`timed out; journal: ${JSON.stringify(e.map((x) => x.type))}\nhost log:\n${log}`);
    }
    await Bun.sleep(50);
  }
}

const turnsEnded = (n: number) => (e: Event[]) => e.filter((x) => x.type === "turnEnded").length >= n;

test("a prompt runs a turn in which the model writes a file and answers", async () => {
  const { client, id, cwd } = await setup([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "hello.txt", content: "hi" } }] },
    { text: "Wrote hello.txt." },
  ]);
  await client.request("session/prompt", { id, text: "make hello.txt" });
  const e = await waitFor(client, id, turnsEnded(1));

  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi");
  const kinds = e.map((x) => x.type).slice(e.findIndex((x) => x.type === "userMessage"));
  expect(kinds).toEqual([
    "userMessage",
    "turnStarted",
    "modelCallStarted",
    "modelCallFinished",
    "assistantMessage",
    "effectStarted",
    "effectFinished",
    "modelCallStarted",
    "modelCallFinished",
    "assistantMessage",
    "turnEnded",
  ]);
  const replies = e.filter((x) => x.type === "assistantMessage");
  expect(replies.map((r) => [r.text, r.toolCalls])).toEqual([
    ["", [{ id: "toolu_1", name: "write" }]],
    ["Wrote hello.txt.", []],
  ]);
  expect(e.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "done" } });

  const second = fake!.requests[1];
  expect(second.system?.[0]?.text ?? second.system).toContain(`working in ${cwd}`);
  const last = second.messages.at(-1);
  expect(last.role).toBe("user");
  expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
  expect(JSON.stringify(last.content[0].content)).toContain("wrote hello.txt (2 bytes)");
});

test("a later prompt continues the conversation, even after the host restarts", async () => {
  const { client, id } = await setup([{ text: "first answer" }, { text: "second answer" }]);
  await client.request("session/prompt", { id, text: "first question" });
  await waitFor(client, id, turnsEnded(1));

    daemon!.strive("stop");
  daemon!.strive("status");
  const again = await connect();
  await again.request("session/prompt", { id, text: "second question" });
  await waitFor(again, id, turnsEnded(2));
  const sent = fake!.requests[1].messages.map((m: any) => [m.role, JSON.stringify(m.content)]);
  expect(sent.map((s: string[]) => s[0])).toEqual(["user", "assistant", "user"]);
  expect(sent[0][1]).toContain("first question");
  expect(sent[1][1]).toContain("first answer");
  expect(sent[2][1]).toContain("second question");
});

test("a provider error ends the turn as failed and says why", async () => {
  const { client, id } = await setup([{ status: 400, error: "prompt is too long" }]);
  await client.request("session/prompt", { id, text: "go" });
  const e = await waitFor(client, id, turnsEnded(1));
  const end = e.at(-1) as Extract<Event, { type: "turnEnded" }>;
  expect(end.reason.kind).toBe("failed");
  expect(JSON.stringify(end.reason)).toContain("prompt is too long");
  expect(e.find((x) => x.type === "modelCallFinished")).toMatchObject({ outcome: { kind: "rejected", status: 400 } });
});

test("running out of budget ends the turn and says so", async () => {
  const { client, id } = await setup([{ text: "never sent" }]);
  await client.request("session/budget", { id, usdMicros: 10 });
  await client.request("session/prompt", { id, text: "go" });
  const e = await waitFor(client, id, turnsEnded(1));
  const end = e.at(-1) as Extract<Event, { type: "turnEnded" }>;
  expect(end.reason.kind).toBe("failed");
  expect(JSON.stringify(end.reason)).toContain("session budget is left");
  expect(fake!.requests.length).toBe(0);
});

test("interrupting stops the turn", async () => {
  const { client, id } = await setup([{ text: "a slow reply", delayMs: 8000 }]);
  await client.request("session/prompt", { id, text: "go" });
  await waitFor(client, id, (e) => e.some((x) => x.type === "modelCallStarted"));
  const started = Date.now();
  await client.request("session/interrupt", { id });
  const e = await waitFor(client, id, turnsEnded(1), 5000);
  expect(Date.now() - started).toBeLessThan(4000);
  expect(e.at(-1)).toMatchObject({ type: "turnEnded", reason: { kind: "interrupted" } });
});

test("a command nobody can approve reaches the model as an error it can act on", async () => {
  const { client, id } = await setup([
    { toolCalls: [{ id: "toolu_b", name: "bash", input: { command: "ls" } }] },
    { text: "I could not run ls." },
  ]);
  await client.request("session/prompt", { id, text: "list files" });
  await waitFor(client, id, turnsEnded(1));
  const result = fake!.requests[1].messages.at(-1).content[0];
  expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_b", is_error: true });
  expect(JSON.stringify(result.content)).toContain("run: ls needs approval, but no client is attached");
});
