import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { type Entry, StriveClient } from "@strive/protocol";
import { startDaemon, type TestDaemon, VirtualTerminal } from "@strive/testkit";
import { App, parseSessionMode, type SessionMode } from "./app";

const CWD = "/tmp/some-repo";

type Ui = { term: VirtualTerminal; exits: number[]; app: App; stop(): void };

let daemon: TestDaemon;
let uis: Ui[];

async function openUi(mode: SessionMode = "new"): Promise<Ui> {
  const term = new VirtualTerminal(100, 30);
  const tui = new TuiMainScreen(term);
  const exits: number[] = [];
  const { client, init } = await StriveClient.connect(daemon.socket, { name: "tui-test", version: "0" });
  const app = new App(tui, client, init, (code) => exits.push(code), CWD);
  tui.start();
  await app.open(mode);
  const ui = { term, exits, app, stop: () => (tui.stop(), client.close()) };
  uis.push(ui);
  return ui;
}

beforeEach(() => {
  daemon = startDaemon();
  uis = [];
  rmSync(CWD, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
});

afterEach(() => {
  for (const ui of uis) ui.stop();
  daemon.dispose();
});

const enter = async (ui: Ui, text: string) => {
  ui.term.type(text);
  await Bun.sleep(20);
  ui.term.type("\x1b");
  ui.term.type("\r");
};

const sessions = () =>
  JSON.parse(daemon.strive("sessions", "--all", "--json").stdout) as { id: string; cwd: string }[];
const daemonClients = () => JSON.parse(daemon.strive("status", "--json").stdout).clients as number;

test("a new session is created in the working directory and named in the header", async () => {
  const ui = await openUi();
  const [s] = sessions();
  expect(s?.cwd).toBe(CWD);
  const screen = await ui.term.waitFor("session …");
  expect(screen[0]).toContain(`${CWD}  session …${s?.id.slice(-6)}`);
  expect(screen.some((l) => l.includes(`Session started in ${CWD}`))).toBe(true);
});

test("a prompt is shown from the journal and is in `strive log`", async () => {
  const ui = await openUi();
  await enter(ui, "fix the flaky test");
  await ui.term.waitFor("› fix the flaky test");
  await ui.term.waitFor("Saved to this session. No agent is connected yet");
  const log = daemon.strive("log", sessions()[0]!.id);
    expect(log.stdout).toMatch(/\n#\d+ \d\d:\d\d:\d\d {2}you: fix the flaky test\n/);
});

test("the missing-agent note appears once, not per prompt", async () => {
  const ui = await openUi();
  await enter(ui, "one");
  await ui.term.waitFor("› one");
  await enter(ui, "two");
  const screen = await ui.term.waitFor("› two");
  expect(screen.filter((l) => l.includes("No agent is connected yet")).length).toBe(1);
});

test("continue reopens the latest session here with its history", async () => {
  const first = await openUi();
  await enter(first, "remember me");
  await first.term.waitFor("› remember me");
  first.app.quit(0);

  const second = await openUi("continue");
  const screen = await second.term.waitFor("› remember me");
  expect(screen[0]).toContain(`session …${sessions()[0]!.id.slice(-6)}`);
  expect(sessions().length).toBe(1);
});

test("continue with no session here starts a new one", async () => {
  await openUi("continue");
  expect(sessions().map((s) => s.cwd)).toEqual([CWD]);
});

test("two clients on one session see each other's prompts", async () => {
  const a = await openUi();
  const id = sessions()[0]!.id;
  const b = await openUi({ resume: id });
  await enter(a, "hello from a");
  await b.term.waitFor("› hello from a");
  await enter(b, "hello from b");
  await a.term.waitFor("› hello from b");
});

test("resuming a tampered session explains why and saves nothing", async () => {
  const first = await openUi();
  await enter(first, "original");
  await first.term.waitFor("› original");
  first.app.quit(0);
    const id = sessions()[0]!.id;
  const logged = JSON.parse(daemon.strive("log", id, "--json").stdout) as { entries: Entry[] };
  const seq = logged.entries.find((e) => e.event.type === "userMessage")!.seq;
  daemon.strive("stop");
  const journal = join(daemon.home, "sessions", id, "journal.jsonl");
  writeFileSync(journal, readFileSync(journal, "utf8").replace("original", "tampered"));
  const before = readFileSync(journal, "utf8");
  daemon.strive("status");

  const ui = await openUi({ resume: id });
      await ui.term.waitFor(`This session's journal failed verification: entry ${seq} was modified, removed or moved.`);
  await enter(ui, "should not be saved");
  await Bun.sleep(100);
  expect(readFileSync(journal, "utf8")).toBe(before);
});

test("resuming an unknown session says so", async () => {
  const ui = await openUi({ resume: "01J8ZZZZZZZZZZZZZZZZZZZZZZ" });
  await ui.term.waitFor("No session 01J8ZZZZZZZZZZZZZZZZZZZZZZ.");
});

test("/status reports the daemon the TUI is attached to", async () => {
  const ui = await openUi();
  await enter(ui, "/status");
  const screen = await ui.term.waitFor("daemon pid");
  const line = screen.find((l) => l.includes("daemon pid"));
  expect(line).toContain(`daemon pid ${daemon.pid()} ·`);
  expect(line).toContain("· 1 client");
});

test("/session prints the full id and the resume command", async () => {
  const ui = await openUi();
  await enter(ui, "/session");
  const id = sessions()[0]!.id;
  await ui.term.waitFor(`session ${id} · resume with strive -r ${id}`);
});

test("an unknown command is named in the error", async () => {
  const ui = await openUi();
  await enter(ui, "/nope");
  await ui.term.waitFor("Unknown command /nope. Type /help.");
});

test("Ctrl+C exits with status 0 and disconnects without reporting a lost connection", async () => {
  const ui = await openUi();
  ui.term.type("\x03");
  await Bun.sleep(50);
  expect(ui.exits).toEqual([0]);
  expect(daemonClients()).toBe(1);
  expect((await ui.term.screen()).some((l) => l.includes("Lost the connection"))).toBe(false);
});

test("/quit exits with status 0 and disconnects", async () => {
  const ui = await openUi();
  await enter(ui, "/quit");
  await Bun.sleep(50);
  expect(ui.exits).toEqual([0]);
  expect(daemonClients()).toBe(1);
});

test("losing the daemon is reported and exits with status 1", async () => {
  const ui = await openUi();
  daemon.strive("stop");
  await ui.term.waitFor("Lost the connection to the daemon.");
  expect(ui.exits).toEqual([1]);
});

test("STRIVE_SESSION values map to session modes", () => {
  expect(parseSessionMode(undefined)).toBe("new");
  expect(parseSessionMode("new")).toBe("new");
  expect(parseSessionMode("continue")).toBe("continue");
  expect(parseSessionMode("01J8ZZZZZZZZZZZZZZZZZZZZZZ")).toEqual({ resume: "01J8ZZZZZZZZZZZZZZZZZZZZZZ" });
});

const footer = async (ui: Ui) => (await ui.term.screen()).at(-1)?.trim();

test("the footer shows spend against the session's budget", async () => {
  const ui = await openUi();
  await ui.term.waitFor("$0.0000 of $5.0000");
  expect(await footer(ui)).toBe("$0.0000 of $5.0000");
});

test("/budget changes the session's limit, in the journal too", async () => {
  const ui = await openUi();
  await enter(ui, "/budget 2.5");
  await ui.term.waitFor("$0.0000 of $2.5000");
  expect(await footer(ui)).toBe("$0.0000 of $2.5000");
    expect(daemon.strive("log", sessions()[0]!.id).stdout).toMatch(/\n#\d+ \d\d:\d\d:\d\d {2}budget: \$2\.5000\n/);
  await enter(ui, "/budget off");
  await ui.term.waitFor("$0.0000 spent · no budget");
});

test("/budget explains its arguments", async () => {
  const ui = await openUi();
  await enter(ui, "/budget lots");
  await ui.term.waitFor("Use /budget <dollars>, for example /budget 10, or /budget off.");
});

/** Starts an effect for the session from another client, as the agent would. */
async function agentRuns(request: Record<string, unknown>) {
  const { client } = await StriveClient.connect(daemon.socket, { name: "agent", version: "0" });
  const id = sessions()[0]!.id;
  const done = client.request("effect/run", { id, callId: "call_1", request: request as never });
  return { done, close: () => client.close() };
}

test("a command waiting for approval is shown and y allows it", async () => {
  const ui = await openUi();
  const agent = await agentRuns({ kind: "bash", command: "echo approved" });
  await ui.term.waitFor("Allow run: echo approved?  y yes · a yes for this session · n no");
  ui.term.type("y");
  const r = await agent.done;
  expect(r.text).toBe("approved\n");
  await ui.term.waitFor("Allowed by tui-test");
  const screen = await ui.term.screen();
  expect(screen.some((l) => l.includes("y yes · a yes for this session"))).toBe(false);
  agent.close();
});

test("n declines a command, which then doesn't run", async () => {
  const ui = await openUi();
  const agent = await agentRuns({ kind: "bash", command: "touch nope.txt" });
  await ui.term.waitFor("Allow run: touch nope.txt?");
  ui.term.type("n");
  const r = await agent.done;
  expect(r.outcome).toEqual({ kind: "refused", reason: "declined: run: touch nope.txt" });
  await ui.term.waitFor("Declined by tui-test");
  agent.close();
});

test("a allows for the rest of the session", async () => {
  const ui = await openUi();
  const first = await agentRuns({ kind: "bash", command: "echo one" });
  await ui.term.waitFor("Allow run: echo one?");
  ui.term.type("a");
  expect((await first.done).text).toBe("one\n");
  await ui.term.waitFor("Approvals: full-auto");
  const second = await agentRuns({ kind: "bash", command: "echo two" });
  expect((await second.done).text).toBe("two\n");
  first.close();
  second.close();
});

test("/approvals switches the mode", async () => {
  const ui = await openUi();
  await ui.term.waitFor("Approvals: auto-edit");
  await enter(ui, "/approvals ask");
  await ui.term.waitFor("Approvals: ask");
  await enter(ui, "/approvals sometimes");
  await ui.term.waitFor("Use /approvals ask, /approvals auto-edit or /approvals full-auto.");
});

test("/rewind lists checkpoints and puts the files back", async () => {
  const ui = await openUi();
  const file = join(CWD, "notes.txt");
  writeFileSync(file, "v1");
  await enter(ui, "first");
  await ui.term.waitFor("› first");
  writeFileSync(file, "v2");
  await enter(ui, "second");
  await ui.term.waitFor("› second");
  writeFileSync(file, "v3");

  await enter(ui, "/rewind");
  await ui.term.waitFor("1  before “first”");
  await ui.term.waitFor("2  before “second”");

  await enter(ui, "/rewind 1");
  await ui.term.waitFor("Rewound to checkpoint 1. Undo with /rewind 3.");
  expect(readFileSync(file, "utf8")).toBe("v1");

  await enter(ui, "/rewind 3");
  await ui.term.waitFor("Rewound to checkpoint 3.");
  expect(readFileSync(file, "utf8")).toBe("v3");
});

test("/rewind to a checkpoint that doesn't exist says so", async () => {
  const ui = await openUi();
  await enter(ui, "/rewind 99");
  await ui.term.waitFor("No checkpoint 99 in this session.");
});
