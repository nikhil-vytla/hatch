import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import {
  type DaemonStatusResult,
  type EffectRequest,
  type Proposal,
  type SessionInfo,
  type SessionReadResult,
  StriveClient,
} from "@strive/protocol";
import { startDaemon, type TestDaemon, VirtualTerminal } from "@strive/testkit";
import { App, parseSessionMode, type SessionMode } from "./app";

/**
 * The session's working directory, fresh for each test. Never a fixed path:
 * test runs in other checkouts share /tmp, and one deleting another's
 * directory mid-test loses its checkpoints.
 */
let CWD: string;

/**
 * How long to wait for a line the daemon shows only after running git: a
 * prompt is journaled after its checkpoint (about 8 git processes), and a
 * rewind runs about 16 in sequence. A rewind takes 0.4s on an idle machine
 * and took 11s beside two `cargo test` runs, far past `waitFor`'s default.
 */
const GIT_MS = 20_000;

// Room for a test's several GIT_MS waits, so a timeout shows the screen.
setDefaultTimeout(60_000);

/** Where sessions say they are: the daemon keeps a directory's real path. */
const real = () => realpathSync(CWD);

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
  CWD = mkdtempSync("/tmp/strv-tui-app-");
});

afterEach(() => {
  for (const ui of uis) ui.stop();
  daemon.dispose();
  rmSync(CWD, { recursive: true, force: true });
});

/** Waits until the app has exited: quitting first asks the daemon whether to offer a learner run. */
const exited = async (ui: Ui) => {
  for (let i = 0; ui.exits.length === 0; i++) {
    if (i > 500) throw new Error("the app never exited");
    await Bun.sleep(10);
  }
};

const enter = async (ui: Ui, text: string) => {
  ui.term.type(text);
  await Bun.sleep(20);
  ui.term.type("\x1b");
  ui.term.type("\r");
};

// SAFETY: `--json` commands print the daemon's protocol result, serialized from the same
// Rust types the TS types are generated from.
const sessions = () => JSON.parse(daemon.strive("sessions", "--all", "--json").stdout) as SessionInfo[];

// SAFETY: as for `sessions`.
const daemonClients = () => (JSON.parse(daemon.strive("status", "--json").stdout) as DaemonStatusResult).clients;

test("a new session is created in the working directory and named in the header", async () => {
  const ui = await openUi();
  const [s] = sessions();
  expect(s?.cwd).toBe(real());
  const screen = await ui.term.waitFor("session …");
  expect(screen[0]).toContain(`${CWD}  session …${s?.id.slice(-6)}`);
  expect(screen.some((l) => l.includes(`Session started in ${real()}`))).toBe(true);
});

test("a prompt is shown from the journal and is in `strive log`", async () => {
  const ui = await openUi();
  await enter(ui, "fix the flaky test");
  await ui.term.waitFor("› fix the flaky test", GIT_MS);
  const log = daemon.strive("log", sessions()[0]!.id);
  expect(log.stdout).toMatch(/\n#\d+ \d\d:\d\d:\d\d {2}you: fix the flaky test\n/);
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
  expect(sessions().map((s) => s.cwd)).toEqual([real()]);
});

test("two clients on one session see each other's prompts", async () => {
  const a = await openUi();
  const id = sessions()[0]!.id;
  const b = await openUi({ resume: id });
  await enter(a, "hello from a");
  await b.term.waitFor("› hello from a", GIT_MS);
  await enter(b, "hello from b");
  await a.term.waitFor("› hello from b", GIT_MS);
});

test("resuming a tampered session explains why and saves nothing", async () => {
  const first = await openUi();
  await enter(first, "original");
  await first.term.waitFor("› original", GIT_MS);
  first.app.quit(0);
  const id = sessions()[0]!.id;
  // SAFETY: as for `sessions`.
  const logged = JSON.parse(daemon.strive("log", id, "--json").stdout) as SessionReadResult;
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

test("/model lists the models, marks this session's, and chooses one for the next turns", async () => {
  const ui = await openUi();
  await enter(ui, "/model");
  const screen = await ui.term.waitFor("Choose one with /model <name>");
  // Settings' model, until one is chosen; the test daemon holds no keys.
  expect(screen.find((l) => l.includes("●"))).toContain("claude-sonnet-4-5");
  expect(screen.find((l) => l.includes(" gpt-5 "))).toContain("no key: strive auth openai");
  await enter(ui, "/model claude-imaginary-9");
  await ui.term.waitFor("no price is known for claude-imaginary-9");
  await enter(ui, "/model gpt-5");
  await ui.term.waitFor("Model: gpt-5");
  await enter(ui, "/model");
  await ui.term.waitFor("● gpt-5");
});

test("/effort sets how much the model thinks, Shift+Tab steps it, and Ctrl+P needs a keyed model", async () => {
  const ui = await openUi();
  await enter(ui, "/effort extreme");
  await ui.term.waitFor("Effort is off. Use /effort off, low, medium or high.");
  await enter(ui, "/effort high");
  await ui.term.waitFor("Effort: high");
  // From high, round to off.
  ui.term.type("\x1b[Z");
  await ui.term.waitFor("Effort: off");
  // The test daemon holds no keys.
  ui.term.type("\x10");
  await ui.term.waitFor("No model has a key yet");
});

test("Ctrl+P in a Claude Code session steps only through Claude models", async () => {
  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  // Stand-ins: the test daemon's upstreams are a dead port.
  for (const provider of ["anthropic", "openai"])
    await client.request("auth/set", { provider, apiKey: "sk-test-not-a-key" });
  client.close();
  process.env.STRIVE_ENGINE = "claude-code";

  try {
    const ui = await openUi();
    await ui.term.waitFor("Claude Code runs this session");
    // After the last Claude model, back to the first, past every GPT one.
    await enter(ui, "/model claude-sonnet-4-5");
    await ui.term.waitFor("Model: claude-sonnet-4-5");
    ui.term.type("\x10");
    await ui.term.waitFor("Model: claude-haiku-4-5");
    expect((await ui.term.screen()).some((l) => l.includes("isn't a Claude model"))).toBe(false);
  } finally {
    delete process.env.STRIVE_ENGINE;
  }
});

test("a session forked from a Claude Code one is strive's again: Ctrl+P reaches every keyed model", async () => {
  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  for (const provider of ["anthropic", "openai"])
    await client.request("auth/set", { provider, apiKey: "sk-test-not-a-key" });
  client.close();
  process.env.STRIVE_ENGINE = "claude-code";

  try {
    const ui = await openUi();
    await ui.term.waitFor("Claude Code runs this session");
    await enter(ui, "hello");
    await ui.term.waitFor("› hello", GIT_MS);
    await enter(ui, "/fork 1");
    await ui.term.waitFor("Forked from session", GIT_MS);
    // Settings' model, then the next with a key: past the Claude models.
    ui.term.type("\x10");
    await ui.term.waitFor("Model: gpt-4.1");
  } finally {
    delete process.env.STRIVE_ENGINE;
  }
});

test("/effort says when the model doesn't think", async () => {
  const ui = await openUi();
  await enter(ui, "/model gpt-4.1");
  await ui.term.waitFor("Model: gpt-4.1");
  await enter(ui, "/effort high");
  await ui.term.waitFor("gpt-4.1 doesn't think, so effort applies once a model that does runs.");
});

test("an unknown command is named in the error", async () => {
  const ui = await openUi();
  await enter(ui, "/nope");
  await ui.term.waitFor("Unknown command /nope. Type /help.");
});

test("Ctrl+C exits with status 0 and disconnects without reporting a lost connection", async () => {
  const ui = await openUi();
  ui.term.type("\x03");
  await exited(ui);
  expect(ui.exits).toEqual([0]);
  expect(daemonClients()).toBe(1);
  expect((await ui.term.screen()).some((l) => l.includes("Lost the connection"))).toBe(false);
});

test("/quit exits with status 0 and disconnects", async () => {
  const ui = await openUi();
  await enter(ui, "/quit");
  await exited(ui);
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
  expect(parseSessionMode("safe")).toBe("safe");
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
async function agentRuns(request: EffectRequest) {
  const { client } = await StriveClient.connect(daemon.socket, { name: "agent", version: "0" });
  const id = sessions()[0]!.id;
  const done = client.request("effect/run", { id, callId: "call_1", request });

  return { done, close: () => client.close() };
}

test("a command waiting for approval is shown and y allows it", async () => {
  const ui = await openUi();
  const agent = await agentRuns({ kind: "bash", command: "echo approved" });
  await ui.term.waitFor("Allow the agent to run: echo approved?  y yes · a yes to everything (full-auto) · n no");
  const asked = await ui.term.screen();
  expect(asked.filter((l) => l.includes("Allow the agent to")).length).toBe(1); // asked once, not twice
  expect(asked.some((l) => l.includes("The agent asked to run: echo approved"))).toBe(true);
  ui.term.type("y");
  const r = await agent.done;
  expect(r.text).toBe("approved\n");
  await ui.term.waitFor("Allowed by tui-test");
  const screen = await ui.term.screen();
  expect(screen.some((l) => l.includes("y yes · a yes to everything"))).toBe(false);
  agent.close();
});

test("a allows an instruction file for the session, and says that is all it allows", async () => {
  writeFileSync(`${CWD}/AGENTS.md`, "one\n");
  const ui = await openUi();
  const agent = await agentRuns({ kind: "edit", path: "AGENTS.md", oldText: "one", newText: "two" });
  await ui.term.waitFor("y yes · a yes to this file for the session · n no");
  ui.term.type("a");
  expect((await agent.done).text).toBe("edited AGENTS.md");
  agent.close();
  const again = await agentRuns({ kind: "edit", path: "AGENTS.md", oldText: "two", newText: "three" });
  expect((await again.done).text).toBe("edited AGENTS.md");
  again.close();
  expect(readFileSync(`${CWD}/AGENTS.md`, "utf8")).toBe("three\n");
  expect((await ui.term.screen()).some((l) => l.includes("Approvals: full-auto"))).toBe(false);
});

test("n declines a command, which then doesn't run", async () => {
  const ui = await openUi();
  const agent = await agentRuns({ kind: "bash", command: "touch nope.txt" });
  await ui.term.waitFor("Allow the agent to run: touch nope.txt?");
  ui.term.type("n");
  const r = await agent.done;
  expect(r.outcome).toEqual({ kind: "refused", reason: "declined: run: touch nope.txt" });
  await ui.term.waitFor("Declined by tui-test");
  agent.close();
});

test("a allows for the rest of the session", async () => {
  const ui = await openUi();
  const first = await agentRuns({ kind: "bash", command: "echo one" });
  await ui.term.waitFor("Allow the agent to run: echo one?");
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
  await ui.term.waitFor("› first", GIT_MS);
  writeFileSync(file, "v2");
  await enter(ui, "second");
  await ui.term.waitFor("› second", GIT_MS);
  writeFileSync(file, "v3");

  await enter(ui, "/rewind");
  await ui.term.waitFor("1  before “first”");
  await ui.term.waitFor("2  before “second”");

  await enter(ui, "/rewind 1");
  await ui.term.waitFor("Rewound to checkpoint 1. Undo with /rewind 3.", GIT_MS);
  expect(readFileSync(file, "utf8")).toBe("v1");

  await enter(ui, "/rewind 3");
  await ui.term.waitFor("Rewound to checkpoint 3.", GIT_MS);
  expect(readFileSync(file, "utf8")).toBe("v3");
});

test("/rewind says which nested repositories it left alone", async () => {
  const ui = await openUi();
  mkdirSync(join(CWD, "vendor/lib"), { recursive: true });
  writeFileSync(join(CWD, "vendor/lib/x.txt"), "v1");
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: join(CWD, "vendor/lib") }).exitCode).toBe(0);
  await enter(ui, "first");
  await ui.term.waitFor("› first", GIT_MS);
  await enter(ui, "/rewind 1");
  await ui.term.waitFor("Left as they were (checkpoints don't hold nested repositories): vendor/lib", GIT_MS);
});

test("/rewind to a checkpoint that doesn't exist says so", async () => {
  const ui = await openUi();
  await enter(ui, "/rewind 99");
  await ui.term.waitFor("No checkpoint 99 in this session.");
});

test("an MCP server that didn't start is shown", async () => {
  writeFileSync(
    join(daemon.home, "settings.json"),
    JSON.stringify({ mcpServers: { broken: { command: "/no/such/server" } } }),
  );
  daemon.strive("stop"); // settings are read at start
  daemon.strive("status");
  const ui = await openUi();
  await ui.term.waitFor("Session started");
  // What an agent host does when it starts for the session.
  const { client } = await StriveClient.connect(daemon.socket, { name: "agent", version: "0" });
  await client.request("host/register", { id: sessions()[0]!.id });
  client.close();
  await ui.term.waitFor("MCP server broken didn't start: can't run /no/such/server");
});

// The model's text is shown, never obeyed: terminal controls in a reply
// could clear the screen and forge the header or earlier prompts.
test("terminal control sequences in a reply are shown as text, not run", async () => {
  const ui = await openUi();
  await enter(ui, "first prompt");
  await ui.term.waitFor("› first prompt", GIT_MS);
  const { client } = await StriveClient.connect(daemon.socket, { name: "agent", version: "0" });
  const id = sessions()[0]!.id;
  await client.request("host/register", { id });
  await client.request("host/record", {
    id,
    event: { type: "assistantMessage", turn: 1, text: "\x1b[2J\x1b[HFORGED HEADER", toolCalls: [], message: {} },
  });
  client.close();
  const screen = await ui.term.waitFor("FORGED HEADER");
  expect(screen[0]).toContain("strive");
  expect(screen.some((l) => l.includes("› first prompt"))).toBe(true);
  expect(screen.some((l) => l.includes("^[[2J^[[HFORGED HEADER"))).toBe(true);
});

/** Proposes changes to the project's memory as its learner would, citing `work`'s first entry; their ids. */
async function propose(work: string, summaries: string[]): Promise<number[]> {
  const { client } = await StriveClient.connect(daemon.socket, { name: "learner", version: "0" });

  try {
    const { id } = await client.request("learning/open", { cwd: real() });
    await client.request("host/register", { id });
    const ids: number[] = [];

    for (const summary of summaries) {
      const proposal: Proposal = {
        change: { kind: "memory", op: "add", text: `${summary}.` },
        summary,
        rationale: "The user said so.",
        evidence: [{ session: work, seqs: [1], note: "the session began here" }],
        prediction: "Later sessions do it.",
      };

      ids.push((await client.request("host/record", { id, event: { type: "proposalMade", proposal } })).seq);
    }

    return ids;
  } finally {
    client.close();
  }
}

test("a session starting where proposals wait for review says how many, counting only those ready", async () => {
  const first = await openUi();
  await first.term.waitFor("Session started in");
  const [, rejected] = await propose(sessions()[0]!.id, ["Use bun", "Keep it short"]);
  first.app.quit(0);

  const two = await openUi();
  await two.term.waitFor("2 proposals are waiting: `strive review`");

  const { client } = await StriveClient.connect(daemon.socket, { name: "reviewer", version: "0" });
  await client.request("proposal/decide", { cwd: real(), proposal: rejected!, decision: "reject" });
  client.close();
  const one = await openUi();
  await one.term.waitFor("1 proposal is waiting: `strive review`");
});

test("a project's slash command is listed, sent as the prompt it stands for, and shown as typed", async () => {
  mkdirSync(join(CWD, ".strive/commands"), { recursive: true });
  writeFileSync(
    join(CWD, ".strive/commands/review.md"),
    "---\ndescription: Review a PR\n---\nReview PR $1 carefully.\n",
  );
  // A project command can't take a built-in's name: /status stays the TUI's.
  writeFileSync(join(CWD, ".strive/commands/status.md"), "Not the daemon's status.\n");
  const ui = await openUi();

  await enter(ui, "/help");
  await ui.term.waitFor("This project's commands:");
  await ui.term.waitFor("Review a PR");
  await enter(ui, "/status");
  await ui.term.waitFor(`daemon pid ${daemon.pid()}`);

  await enter(ui, "/review 42");
  await ui.term.waitFor("› /review 42", GIT_MS);
  // SAFETY: `strive log --json` prints the daemon's journal entries, from the protocol's own types.
  const read = JSON.parse(daemon.strive("log", sessions()[0]!.id, "--json").stdout) as SessionReadResult;
  const prompt = read.entries.map((e) => e.event).find((e) => e.type === "userMessage");
  expect(prompt).toEqual({
    type: "userMessage",
    text: "Review PR 42 carefully.",
    command: { name: "review", arguments: "42" },
    requestId: expect.any(String),
  });
});
