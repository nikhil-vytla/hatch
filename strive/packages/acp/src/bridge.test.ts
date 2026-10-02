// The ACP bridge end to end: an editor (the SDK's client side, in memory)
// drives a real daemon and host, with a scripted model at the network edge.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { StriveClient } from "@strive/protocol";
import { FakeAnthropic, STRIVE_EXE, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";
import { bridge, promptText } from "./bridge";

const HOST = `bun ${resolve(import.meta.dir, "../../host/src/main.ts")}`;

setDefaultTimeout(30_000);

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

let closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers) close();
  closers = [];
  daemon?.dispose();
  fake?.stop();
});

/** What an editor saw, and how it answers permission requests. */
type Editor = {
  agent: acp.ClientContext;
  updates: acp.SessionUpdate[];
  asked: acp.RequestPermissionRequest[];
};

async function editor(answer: (r: acp.RequestPermissionRequest) => acp.RequestPermissionResponse): Promise<Editor> {
  const { client } = await StriveClient.connect(daemon!.socket, { name: "test-acp", version: "0" });
  const updates: acp.SessionUpdate[] = [];
  const asked: acp.RequestPermissionRequest[] = [];

  const app = acp
    .client({ name: "test-editor" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params.update);
    })
    .onRequest("session/request_permission", (ctx) => {
      asked.push(ctx.params);

      return answer(ctx.params);
    });

  const connection = app.connect(bridge(client, "test"));

  closers.push(() => {
    connection.close();
    client.close();
  });
  await connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION });

  return { agent: connection.agent, updates, asked };
}

async function setup(script: ScriptedReply[], settings?: { approvals: string }) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon(
    { STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST },
    settings,
  );

  return realpathSync(mkdtempSync("/tmp/strv-acp-"));
}

const allowOnce = () =>
  ({ outcome: { outcome: "selected", optionId: "allow" } }) satisfies acp.RequestPermissionResponse;

const said = (updates: acp.SessionUpdate[]) =>
  updates
    .flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : []))
    .join("");

test("a prompt runs a turn: the editor sees the tool call and the reply, and the turn's end", async () => {
  const cwd = await setup([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "hello.txt", content: "hi" } }] },
    { text: "Wrote hello.txt." },
  ]);

  const e = await editor(allowOnce);
  const { sessionId, modes } = await e.agent.request("session/new", { cwd, mcpServers: [] });

  expect(modes?.availableModes.map((m) => m.id)).toEqual(["ask", "autoEdit", "fullAuto"]);
  const r = await e.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "make hello.txt" }] });

  expect(r.stopReason).toBe("end_turn");
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi");
  expect(said(e.updates)).toBe("Wrote hello.txt.");
  const call = e.updates.find((u) => u.sessionUpdate === "tool_call");

  expect(call).toMatchObject({
    toolCallId: "toolu_1",
    title: "Write hello.txt",
    kind: "edit",
    locations: [{ path: join(cwd, "hello.txt") }],
  });
  const done = e.updates.find((u) => u.sessionUpdate === "tool_call_update");

  expect(done).toMatchObject({ toolCallId: "toolu_1", status: "completed" });
});

test("an approval is the editor's permission request, and what it chooses is the daemon's answer", async () => {
  const cwd = await setup(
    [
      { toolCalls: [{ id: "toolu_1", name: "bash", input: { command: "echo allowed" } }] },
      { toolCalls: [{ id: "toolu_2", name: "bash", input: { command: "echo declined" } }] },
      { text: "Ran one." },
    ],
    { approvals: "ask" },
  );

  let answers = 0;

  const e = await editor(() => ({
    outcome: { outcome: "selected", optionId: answers++ === 0 ? "allow" : "deny" },
  }));

  const { sessionId } = await e.agent.request("session/new", { cwd, mcpServers: [] });
  const r = await e.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run two" }] });

  expect(r.stopReason).toBe("end_turn");
  expect(e.asked.map((a) => [a.toolCall.toolCallId, a.toolCall.title])).toEqual([
    ["toolu_1", "run: echo allowed"],
    ["toolu_2", "run: echo declined"],
  ]);
  expect(e.asked[0]?.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  expect(e.asked[0]?.options[1]?.name).toBe("Allow everything for this session (full-auto)");
  const ends = e.updates.flatMap((u) => (u.sessionUpdate === "tool_call_update" ? [[u.toolCallId, u.status]] : []));

  expect(ends).toEqual([
    ["toolu_1", "completed"],
    ["toolu_2", "failed"],
  ]);
});

test("cancelling interrupts the turn, and the prompt ends cancelled", async () => {
  const cwd = await setup([{ text: "too slow", delayMs: 10_000 }]);
  const e = await editor(allowOnce);
  const { sessionId } = await e.agent.request("session/new", { cwd, mcpServers: [] });
  const pending = e.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "wait" }] });

  while (fake!.requests.length === 0) await Bun.sleep(20);
  await e.agent.notify("session/cancel", { sessionId });

  expect((await pending).stopReason).toBe("cancelled");
});

test("a loaded session is replayed to the editor, and its mode is the session's", async () => {
  const cwd = await setup([{ text: "first answer" }]);
  const first = await editor(allowOnce);
  const { sessionId } = await first.agent.request("session/new", { cwd, mcpServers: [] });

  await first.agent.request("session/set_mode", { sessionId, modeId: "fullAuto" });
  await first.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "first question" }] });
  const second = await editor(allowOnce);
  const loaded = await second.agent.request("session/load", { sessionId, cwd, mcpServers: [] });

  expect(loaded?.modes?.currentModeId).toBe("fullAuto");
  const kinds = second.updates.map((u) => u.sessionUpdate);

  expect(kinds).toEqual(["user_message_chunk", "agent_message_chunk"]);
  expect(said(second.updates)).toBe("first answer");
});

test("an editor's MCP servers aren't run, and the first reply says so", async () => {
  const cwd = await setup([{ text: "ok" }]);
  const e = await editor(allowOnce);

  const { sessionId } = await e.agent.request("session/new", {
    cwd,
    mcpServers: [{ name: "gh", command: "npx", args: ["gh-mcp"], env: [] }],
  });

  await e.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
  expect(said(e.updates)).toStartWith("strive runs the MCP servers in its own settings");
});

test("a prompt's embedded files are inlined, links named, and images refused", () => {
  const text = promptText([
    { type: "text", text: "look at" },
    { type: "resource", resource: { uri: "file:///a.ts", text: "const a = 1;" } },
    { type: "resource_link", name: "b.ts", uri: "file:///b.ts" },
  ]);

  expect(text).toBe('look at\n\n<file uri="file:///a.ts">\nconst a = 1;\n</file>\n\n[b.ts](file:///b.ts)');
  expect(() => promptText([{ type: "image", data: "", mimeType: "image/png" }])).toThrow("an image");
});

test("`strive acp` speaks ACP on its stdio", async () => {
  const cwd = await setup([{ text: "hello from strive" }]);
  const tui = `bun ${resolve(import.meta.dir, "../../tui/src/main.ts")}`;

  const proc = spawn(STRIVE_EXE, ["acp"], {
    env: { ...daemon!.env, STRIVE_TUI: tui },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const updates: acp.SessionUpdate[] = [];

  const connection = acp
    .client({ name: "test-editor" })
    .onNotification("session/update", (ctx) => {
      updates.push(ctx.params.update);
    })
    .connect(acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)));

  closers.push(() => {
    connection.close();
    proc.kill();
  });
  const init = await connection.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION });

  expect(init.agentInfo?.name).toBe("strive");
  expect(init.agentCapabilities?.loadSession).toBe(true);
  const { sessionId } = await connection.agent.request("session/new", { cwd, mcpServers: [] });
  const r = await connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });

  expect(r.stopReason).toBe("end_turn");
  expect(said(updates)).toBe("hello from strive");
  // It is a strive session like any other.
  expect(daemon!.strive("sessions", "--all").stdout).toContain(sessionId.slice(-6));
});
