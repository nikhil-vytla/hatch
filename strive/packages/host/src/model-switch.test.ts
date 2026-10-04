// A model and effort chosen between turns, end to end: a real daemon and
// host, a scripted Anthropic model, and a scripted OpenAI one that is sent
// the whole conversation so far.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type Entry, type Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, type Json, startDaemon, type TestDaemon } from "@strive/testkit";
import * as v from "valibot";

const HOST = `bun ${resolve(import.meta.dir, "main.ts")}`;

setDefaultTimeout(30_000);

/** What a scripted OpenAI chat completion was sent: the parts the test checks. */
const ChatRequest = v.object({ model: v.string(), messages: v.array(v.object({ role: v.string() })) });

/** A scripted OpenAI Chat Completions API: the network edge, answering every request with `text`. */
function fakeOpenAI(text: string) {
  const requests: { model: string; body: string }[] = [];
  const data = (d: Json) => `data: ${JSON.stringify(d)}\n\n`;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const sent = await req.text();

      requests.push({ model: v.parse(ChatRequest, JSON.parse(sent)).model, body: sent });

      const chunk = { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5" };

      const body = [
        data({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
        data({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        data({ ...chunk, choices: [], usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 } }),
        "data: [DONE]\n\n",
      ].join("");

      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const f of cleanup) f();
  cleanup = [];
});

async function untilTurnsEnded(client: StriveClient, id: string, n: number): Promise<Event[]> {
  const deadline = Date.now() + 25_000;

  for (;;) {
    const e = (await client.request("session/read", { id })).entries.map((x: Entry) => x.event);
    const ended = e.filter((x) => x.type === "turnEnded");

    if (ended.length >= n) {
      for (const t of ended) expect(t).toMatchObject({ reason: { kind: "done" } });

      return e;
    }

    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(e.map((x) => x.type))}`);
    await Bun.sleep(50);
  }
}

test("a model chosen between turns runs the next turn, on another provider too, with the conversation so far", async () => {
  const anthropic = new FakeAnthropic(() => ({ text: "first answer" })).start();
  const openai = fakeOpenAI("second answer");

  const daemon: TestDaemon = startDaemon({
    STRIVE_UPSTREAM_ANTHROPIC: anthropic.url,
    STRIVE_UPSTREAM_OPENAI: openai.url,
    ANTHROPIC_API_KEY: "sk-test-key",
    OPENAI_API_KEY: "sk-test-key",
    STRIVE_HOST: HOST,
  });

  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  cleanup.push(
    () => client.close(),
    () => daemon.dispose(),
    () => anthropic.stop(),
    () => openai.stop(),
  );
  const { id } = await client.request("session/create", { cwd: realpathSync(mkdtempSync("/tmp/strv-switch-")) });

  await client.request("session/model", { id, model: "claude-haiku-4-5" });
  await client.request("session/prompt", { id, text: "first question" });
  await untilTurnsEnded(client, id, 1);
  await client.request("session/model", { id, model: "gpt-5" });
  await client.request("session/prompt", { id, text: "second question" });
  const e = await untilTurnsEnded(client, id, 2);

  expect(anthropic.requests.length).toBe(1);
  expect(openai.requests.map((r) => r.model)).toEqual(["gpt-5"]);
  const sent = openai.requests[0]?.body ?? "";

  for (const said of ["first question", "first answer", "second question"]) expect(sent).toContain(said);
  expect(
    e.filter((x) => x.type === "assistantMessage").map((x) => (x.type === "assistantMessage" ? x.text : "")),
  ).toEqual(["first answer", "second answer"]);
});

test("effort set between turns makes the next turn's model think, and off stops it", async () => {
  const anthropic = new FakeAnthropic(() => ({ text: "answer" })).start();

  const daemon = startDaemon({
    STRIVE_UPSTREAM_ANTHROPIC: anthropic.url,
    ANTHROPIC_API_KEY: "sk-test-key",
    STRIVE_HOST: HOST,
  });

  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  cleanup.push(
    () => client.close(),
    () => daemon.dispose(),
    () => anthropic.stop(),
  );
  const { id } = await client.request("session/create", { cwd: realpathSync(mkdtempSync("/tmp/strv-effort-")) });

  await client.request("session/model", { id, model: "claude-haiku-4-5" });
  await client.request("session/prompt", { id, text: "plain" });
  await untilTurnsEnded(client, id, 1);
  await client.request("session/effort", { id, effort: "high" });
  await client.request("session/prompt", { id, text: "think hard" });
  await untilTurnsEnded(client, id, 2);
  await client.request("session/effort", { id, effort: "off" });
  await client.request("session/prompt", { id, text: "plain again" });
  await untilTurnsEnded(client, id, 3);

  const thinking = anthropic.requests.map((r) => r.thinking?.type);

  expect(thinking).toEqual([undefined, "enabled", undefined]);
});

test("effort is asked only of a model that thinks, after a switch too", async () => {
  const openai = fakeOpenAI("answer");

  const daemon = startDaemon({ STRIVE_UPSTREAM_OPENAI: openai.url, OPENAI_API_KEY: "sk-test-key", STRIVE_HOST: HOST });

  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  cleanup.push(
    () => client.close(),
    () => daemon.dispose(),
    () => openai.stop(),
  );
  const { id } = await client.request("session/create", { cwd: realpathSync(mkdtempSync("/tmp/strv-effort-")) });

  await client.request("session/effort", { id, effort: "high" });
  // gpt-4.1 doesn't think: asked to, it would refuse the request.
  await client.request("session/model", { id, model: "gpt-4.1" });
  await client.request("session/prompt", { id, text: "one" });
  await untilTurnsEnded(client, id, 1);
  await client.request("session/model", { id, model: "gpt-5" });
  await client.request("session/prompt", { id, text: "two" });
  await untilTurnsEnded(client, id, 2);

  expect(openai.requests.map((r) => [r.model, r.body.includes('"reasoning_effort"')])).toEqual([
    ["gpt-4.1", false],
    ["gpt-5", true],
  ]);
});
