// The agent loop end to end: real daemon, real host (started by the daemon),
// real gateway and effects, and a scripted model at the network boundary.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Entry, type Event, StriveClient } from "@strive/protocol";
import { FakeAnthropic, type ScriptedReply, startDaemon, type TestDaemon } from "@strive/testkit";
import { CHECK_ROUNDS } from "./host";

type TurnEnded = Extract<Event, { type: "turnEnded" }>;

const lastTurnEnd = (events: Event[]) => events.findLast((x): x is TurnEnded => x.type === "turnEnded");

/** The parts of ~/.strive/settings.json these tests set. */
type SettingsFile = {
  compactAtTokens?: number;
  turnSeconds?: number;
  mcpServers?: { [name: string]: { command: string } };
};

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
    "contextLoaded",
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
  const end = lastTurnEnd(e);
  expect(end?.reason.kind).toBe("failed");
  expect(JSON.stringify(end?.reason)).toContain("prompt is too long");
  expect(e.find((x) => x.type === "modelCallFinished")).toMatchObject({ outcome: { kind: "rejected", status: 400 } });
});

test("running out of budget ends the turn and says so", async () => {
  const { client, id } = await setup([{ text: "never sent" }]);
  await client.request("session/budget", { id, usdMicros: 10 });
  await client.request("session/prompt", { id, text: "go" });
  const e = await waitFor(client, id, turnsEnded(1));
  const end = lastTurnEnd(e);
  expect(end?.reason.kind).toBe("failed");
  expect(JSON.stringify(end?.reason)).toContain("session budget is left");
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

test("the model is given the project's instructions and the skills it can load", async () => {
  fake = new FakeAnthropic([{ text: "ok" }]).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-agent-"));
  const { mkdirSync, writeFileSync } = await import("node:fs");
  writeFileSync(join(cwd, "AGENTS.md"), "Always write tests first.");
  mkdirSync(join(cwd, ".strive/skills/release"), { recursive: true });
  writeFileSync(
    join(cwd, ".strive/skills/release/SKILL.md"),
    "---\nname: release\ndescription: Cut a release.\n---\nSteps",
  );
  const client = await connect();
  const { id } = await client.request("session/create", { cwd });
  await client.request("session/prompt", { id, text: "hi" });
  await waitFor(client, id, turnsEnded(1));
  const system = JSON.stringify(fake!.requests[0].system);
  expect(system).toContain(`${join(cwd, "AGENTS.md")}`);
  expect(system).toContain("Always write tests first.");
  expect(system).toContain(`release: Cut a release. (${join(cwd, ".strive/skills/release/SKILL.md")})`);
});

async function setupWith(settings: SettingsFile, script: ScriptedReply[]) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test-key", STRIVE_HOST: HOST });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(daemon.home, "settings.json"), JSON.stringify(settings));
  daemon.strive("stop");
  daemon.strive("status");
  const cwd = realpathSync(mkdtempSync("/tmp/strv-agent-"));
  const client = await connect();
  const { id } = await client.request("session/create", { cwd });

  return { client, id, cwd };
}

test("a long conversation is summarized before the next turn, and resumes from the summary", async () => {
  const { client, id } = await setupWith({ compactAtTokens: 5 }, [
    { text: "The first answer, long enough to push the conversation past the tiny limit." },
    { text: "SUMMARY-1: the user asked a first question and got an answer." },
    { text: "second answer" },
    { text: "SUMMARY-2, which carries SUMMARY-1 forward." },
    { text: "third answer" },
  ]);

  await client.request("session/prompt", { id, text: "first question" });
  await waitFor(client, id, turnsEnded(1));
  await client.request("session/prompt", { id, text: "second question" });
  const e = await waitFor(client, id, turnsEnded(2));

  const summarize = fake!.requests[1];
  expect(JSON.stringify(summarize.system)).toContain("Summarize");
  expect(JSON.stringify(summarize.messages)).toContain("first question");
  const next = fake!.requests[2].messages.map((m: any) => JSON.stringify(m.content));
  expect(next[0]).toContain("SUMMARY-1");
  expect(next.at(-1)).toContain("second question");
  expect(next.join("")).not.toContain("The first answer");
  expect(e.find((x) => x.type === "compacted")).toMatchObject({
    type: "compacted",
    summary: "SUMMARY-1: the user asked a first question and got an answer.",
  });

  daemon!.strive("stop");
  daemon!.strive("status");
  fake!.requests.length = 0;
  const again = await connect();
  await again.request("session/prompt", { id, text: "third question" });
  await waitFor(again, id, turnsEnded(3));

  const resumed = fake!.requests
    .at(-1)
    .messages.map((m: any) => JSON.stringify(m.content))
    .join("");

  expect(resumed).toContain("SUMMARY-1");
  expect(resumed).not.toContain("first question");
});

test("a short conversation is not summarized", async () => {
  const { client, id } = await setupWith({}, [{ text: "one" }, { text: "two" }]);
  await client.request("session/prompt", { id, text: "first" });
  await waitFor(client, id, turnsEnded(1));
  await client.request("session/prompt", { id, text: "second" });
  const e = await waitFor(client, id, turnsEnded(2));
  expect(e.some((x) => x.type === "compacted")).toBe(false);
  expect(fake!.requests.length).toBe(2);
});

/** A turn whose model asks to run a command that then waits for approval. */
async function waitingOnApproval(settings: SettingsFile) {
  const s = await setupWith(settings, [
    { toolCalls: [{ id: "toolu_1", name: "bash", input: { command: "touch made.txt" } }] },
    { text: "never reached" },
  ]);

  await s.client.request("session/approvals", { id: s.id, mode: "ask" });
  await s.client.request("session/attach", { id: s.id }); // a person, so the request waits
  await s.client.request("session/prompt", { id: s.id, text: "make a file" });
  await waitFor(s.client, s.id, (e) => e.some((x) => x.type === "approvalRequested"));

  return s;
}

const effectOutcome = (e: Event[]) => e.findLast((x) => x.type === "effectFinished");

test("interrupting a turn cancels the command waiting for approval, and ends the turn", async () => {
  const { client, id, cwd } = await waitingOnApproval({});
  await client.request("session/interrupt", { id });
  const e = await waitFor(client, id, turnsEnded(1), 5_000);
  expect(lastTurnEnd(e)?.reason).toEqual({ kind: "interrupted" });
  expect(effectOutcome(e)).toMatchObject({ outcome: { kind: "refused", reason: "interrupted: run: touch made.txt" } });
  const late = await client.request("approval/respond", { id, effect: 1, decision: "allow" }).catch((err) => err);
  expect(late).toBeInstanceOf(Error);
  expect(existsSync(join(cwd, "made.txt"))).toBe(false);
});

test("a turn's time limit also stops a command waiting for approval", async () => {
  const { client, id, cwd } = await waitingOnApproval({ turnSeconds: 2 });
  const e = await waitFor(client, id, turnsEnded(1), 8_000);
  expect(lastTurnEnd(e)?.reason).toEqual({ kind: "timedOut", seconds: 2 });
  expect(effectOutcome(e)).toMatchObject({ outcome: { kind: "refused", reason: "interrupted: run: touch made.txt" } });
  expect(existsSync(join(cwd, "made.txt"))).toBe(false);
});

/** The fake MCP server `cargo test` builds from crates/strived/examples/fake_mcp.rs. */
const FAKE_MCP = resolve(import.meta.dir, "../../../target/debug/examples/fake_mcp");

test("the model can call an MCP server's tool, and the result comes back to it", async () => {
  const { client, id } = await setupWith({ mcpServers: { fake: { command: FAKE_MCP } } }, [
    { toolCalls: [{ id: "toolu_1", name: "mcp__fake__echo", input: { text: "hello" } }] },
    { text: "It said hello." },
  ]);

  await client.request("session/approvals", { id, mode: "fullAuto" });
  await client.request("session/prompt", { id, text: "use the echo tool" });
  const e = await waitFor(client, id, turnsEnded(1));
  expect(lastTurnEnd(e)?.reason).toEqual({ kind: "done" });
  const tools = fake!.requests[0].tools.map((t: { name: string }) => t.name);
  expect(tools).toContain("mcp__fake__echo");
  const echo = fake!.requests[0].tools.find((t: { name: string }) => t.name === "mcp__fake__echo");
  expect(echo.input_schema.required).toEqual(["text"]);
  expect(e.find((x) => x.type === "effectStarted")).toMatchObject({
    record: { kind: "mcp", server: "fake", tool: "echo" },
  });
  const result = fake!.requests[1].messages.at(-1).content[0];
  expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
  expect(JSON.stringify(result.content)).toContain("echo: hello");
});

test("the model can propose a layout change, which is journaled and changes nothing else", async () => {
  const ops = [{ op: "move", panel: "spend", column: "main" }];

  const { client, id } = await setup([
    { toolCalls: [{ id: "toolu_1", name: "propose_layout", input: { label: "spend next to the chat", ops } }] },
    { text: "Proposed." },
  ]);

  await client.request("session/prompt", { id, text: "put spend by the chat" });
  const e = await waitFor(client, id, turnsEnded(1));
  expect(e.find((x) => x.type === "layoutProposed")).toEqual({
    type: "layoutProposed",
    callId: "toolu_1",
    label: "spend next to the chat",
    ops,
  });
  expect(e.some((x) => x.type === "effectStarted")).toBe(false);
  expect(JSON.stringify(fake!.requests[1].messages.at(-1))).toContain("the desktop app");
});

test("summarizing before a turn is part of the turn: it can be interrupted, and it has the time limit", async () => {
  for (const stop of ["interrupt", "time limit"] as const) {
    const { client, id } = await setupWith({ compactAtTokens: 5, turnSeconds: stop === "time limit" ? 2 : 60 }, [
      { text: "The first answer, long enough to push the conversation past the tiny limit." },
      { text: "a summary that takes too long", delayMs: 20_000 },
      { text: "never sent" },
    ]);

    await client.request("session/prompt", { id, text: "first question" });
    await waitFor(client, id, turnsEnded(1));
    await client.request("session/prompt", { id, text: "second question" });
    await waitFor(client, id, (e) => e.filter((x) => x.type === "modelCallStarted").length === 2);
    const started = Date.now();

    if (stop === "interrupt") await client.request("session/interrupt", { id });
    const e = await waitFor(client, id, turnsEnded(2), 8000);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lastTurnEnd(e)?.reason.kind).toBe(stop === "interrupt" ? "interrupted" : "timedOut");
    await Bun.sleep(300);
    expect(fake!.requests.length).toBe(2); // the prompt wasn't run after all
    daemon!.dispose();
    fake!.stop();
  }
});

function writeCheck(cwd: string, name: string, run: string, paths?: string) {
  mkdirSync(join(cwd, ".strive/checks"), { recursive: true });
  const scope = paths === undefined ? "" : `paths: ${paths}\n`;
  writeFileSync(
    join(cwd, ".strive/checks", `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} passes\nrun: ${run}\n${scope}---\nb.txt marks the work done.\n`,
  );
}

/** A person attached to the session, who allows each check for the session when asked. */
async function allowChecks(id: string) {
  const person = await connect();

  person.on("session/entry", ({ entry }) => {
    const e = entry.event;

    if (e.type === "approvalRequested" && e.sessionFile?.startsWith("check:"))
      void person.request("approval/respond", { id, effect: e.effect, decision: "allowSession" });
  });
  await person.request("session/attach", { id });
}

const checkRuns = (e: Event[]) =>
  e.flatMap((x) => (x.type === "effectStarted" && x.record.kind === "check" ? [x.record] : []));

test("a failing check goes back to the agent, which fixes it before the turn ends, and resumes the same", async () => {
  const { client, id, cwd } = await setup([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "a.txt", content: "a" } }] },
    { text: "Wrote a.txt." },
    { toolCalls: [{ id: "toolu_2", name: "write", input: { path: "b.txt", content: "b" } }] },
    { text: "Wrote b.txt too." },
    { text: "second answer" },
  ]);

  writeCheck(cwd, "done", "test -f b.txt");
  await allowChecks(id);

  await client.request("session/prompt", { id, text: "make a.txt" });
  const e = await waitFor(client, id, turnsEnded(1));

  expect(checkRuns(e).map((r) => r.command)).toEqual(["test -f b.txt", "test -f b.txt"]);
  expect(e.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "done" } });
  // The third request is the agent told what failed.
  const told = fake!.requests[2].messages.at(-1);
  expect(told.role).toBe("user");
  const report = JSON.stringify(told.content);
  expect(report).toContain("strive ran this project's checks on your changes, and one failed");
  expect(report).toContain("## done: `test -f b.txt` (exit 1)");
  expect(report).toContain("b.txt marks the work done.");
  expect(fake!.requests).toHaveLength(4);

  // A restarted host rebuilds the conversation with the report where it was.
  daemon!.strive("stop");
  daemon!.strive("status");
  const again = await connect();
  await again.request("session/prompt", { id, text: "anything else?" });
  await waitFor(again, id, turnsEnded(2));
  const live = fake!.requests[3].messages;
  const resumed = fake!.requests[4].messages.slice(0, live.length);
  expect(resumed.map((m: any) => m.role)).toEqual(live.map((m: any) => m.role));
  const at = live.findIndex((m: any) => JSON.stringify(m.content).includes("strive ran this project's checks"));
  expect(at).toBeGreaterThan(0);
  expect(resumed[at].content).toEqual(live[at].content);
});

test("checks run only when a file they cover changed", async () => {
  const { client, id, cwd } = await setup([
    { text: "Nothing to change." },
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "docs/a.md", content: "a" } }] },
    { text: "Wrote docs." },
  ]);

  writeCheck(cwd, "src", "false", "src/**");
  writeCheck(cwd, "docs", "true", "docs/**");
  await allowChecks(id);

  await client.request("session/prompt", { id, text: "look around" });
  await waitFor(client, id, turnsEnded(1));
  await client.request("session/prompt", { id, text: "write docs" });
  const e = await waitFor(client, id, turnsEnded(2));

  // Nothing ran after the first turn; after the second, only the docs check.
  expect(checkRuns(e).map((r) => r.name)).toEqual(["docs"]);
  expect(fake!.requests).toHaveLength(3);
});

test("a check that keeps failing ends the turn after the last round, as it is", async () => {
  const { client, id, cwd } = await setup([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "a.txt", content: "a" } }] },
    { text: "Done." },
    { text: "Still done." },
    { text: "Really done." },
  ]);

  writeCheck(cwd, "never", "false");
  await allowChecks(id);

  await client.request("session/prompt", { id, text: "make a.txt" });
  const e = await waitFor(client, id, turnsEnded(1));

  // Checked after each answer; told twice, then the turn ends.
  expect(checkRuns(e)).toHaveLength(CHECK_ROUNDS + 1);
  expect(fake!.requests).toHaveLength(2 + CHECK_ROUNDS);
  expect(e.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "done" } });
});

test("a check no one has accepted isn't sent to the agent, which can't fix that", async () => {
  const { client, id, cwd } = await setup([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "a.txt", content: "a" } }] },
    { text: "Done." },
  ]);

  mkdirSync(join(cwd, ".strive/checks"), { recursive: true });
  writeFileSync(join(cwd, ".strive/checks/new.md"), "---\nname: new\ndescription: d\nrun: false\n---\n");
  await client.request("session/prompt", { id, text: "make a.txt" });
  const e = await waitFor(client, id, turnsEnded(1));

  // Asked, and with no one attached to answer, refused: the turn just ends.
  expect(checkRuns(e)).toHaveLength(1);
  expect(fake!.requests).toHaveLength(2);
  expect(e.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "done" } });
});
