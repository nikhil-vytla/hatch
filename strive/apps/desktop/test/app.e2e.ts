// The desktop app, driven as a person would, against a real daemon. Runs
// under Node (`node --test`): Playwright's Electron driver needs it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { type ElectronApplication, _electron as electron, type Locator, type Page } from "playwright";

const ROOT = resolve(import.meta.dirname, "../../..");

const STRIVE = join(ROOT, "target/debug/strive");

const APP = resolve(import.meta.dirname, "..");

const electronPath: string = createRequire(import.meta.url)("electron");

let home: string;

/**
 * strive's environment here: no provider keys, so the daemon these tests start
 * never holds a real one, and upstreams at a dead port, so a call made with the
 * stand-in key a test sets (the judge's, say) never leaves the machine.
 */
function keyless(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, ...rest } = process.env;

  return { ...rest, STRIVE_UPSTREAM_ANTHROPIC: "http://127.0.0.1:9", STRIVE_UPSTREAM_OPENAI: "http://127.0.0.1:9" };
}

function strive(...args: string[]): string {
  return execFileSync(STRIVE, args, { env: { ...keyless(), STRIVE_HOME: home, STRIVE_HOST: "none" } }).toString();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "strv-desk-"));
  strive("status"); // starts the daemon
});

after(() => {
  try {
    strive("stop");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Every app a test opened: closed after it, pass or fail, or the run never ends. */
const launched = new Set<ElectronApplication>();

afterEach(async () => {
  await Promise.all([...launched].map((a) => a.close().catch(() => undefined)));
  launched.clear();
});

async function launch(args: string[], at = home, env: NodeJS.ProcessEnv = {}): Promise<ElectronApplication> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [APP, ...args],
    // Behind the person's windows, without taking focus (see main.ts).
    env: { ...keyless(), STRIVE_SOCKET: join(at, "run/strived.sock"), STRIVE_DESKTOP_BACKGROUND: "1", ...env },
  });

  launched.add(app);

  return app;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Reply = { id: number; result?: Json; error?: { message: string } };

function isReply(v: unknown): v is Reply {
  return typeof v === "object" && v !== null && "id" in v && typeof v.id === "number";
}

/** A plain JSON-RPC connection to the daemon, standing in for the agent. */
class Rpc {
  private buffer = "";
  private waiting = new Map<number, (reply: Reply) => void>();
  private next = 1;
  private readonly socket: Socket;

  // Plain fields, not parameter properties: Node strips types but doesn't transform.
  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");

      while (nl >= 0) {
        const msg = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf("\n");

        if (isReply(msg)) this.waiting.get(msg.id)?.(msg);
      }
    });
  }

  /** A connection to the daemon whose home is `at`: the shared one unless a test starts its own. */
  static async open(at = home): Promise<Rpc> {
    const socket = connect(join(at, "run/strived.sock"));
    await new Promise((ok) => socket.once("connect", ok));
    const rpc = new Rpc(socket);
    await rpc.call("initialize", { protocolVersion: 3, client: { name: "e2e", version: "0" } });

    return rpc;
  }

  call(method: string, params: { [key: string]: Json }): Promise<Reply> {
    const id = this.next++;
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    return new Promise((ok) => this.waiting.set(id, ok));
  }

  close() {
    this.socket.end();
  }
}

type Opened = { app: ElectronApplication; page: Page; cwd: string; userData: string };

async function openApp(at = home, env: NodeJS.ProcessEnv = {}): Promise<Opened> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-ws-")));
  const userData = mkdtempSync(join(tmpdir(), "strv-desk-data-"));

  const app = await launch([`--user-data-dir=${userData}`, "--cwd", cwd], at, env);

  const page = await app.firstWindow();
  await page.getByText(`Session started in ${cwd}`).waitFor();

  return { app, page, cwd, userData };
}

/** Waits for the checkpoint taken before the last prompt: the prompt offers a rewind to it. */
async function checkpointed(page: Page): Promise<void> {
  await page.locator(".msg.user").last().getByRole("button", { name: "rewind to before this prompt" }).waitFor();
}

/** Runs a palette command by typing its name. */
async function command(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  await page.keyboard.type(name);
  await palette.getByRole("option", { name, exact: true }).waitFor();
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "detached" });
}

function sessionId(cwd: string): string {
  const sessions: { id: string; cwd: string }[] = JSON.parse(strive("sessions", "--all", "--json"));
  const s = sessions.find((x) => x.cwd === cwd);
  assert.ok(s, `a session in ${cwd}`);

  return s.id;
}

test("a prompt typed in the window is journaled and shown", async () => {
  const { app, page, cwd } = await openApp();
  await page.getByPlaceholder("Ask strive to do anything…").fill("tidy the readme");
  await page.keyboard.press("Enter");
  await page.locator(".msg.user", { hasText: "tidy the readme" }).waitFor();
  const log = JSON.parse(strive("log", sessionId(cwd), "--json"));
  assert.ok(log.entries.some((e: { event: { type: string; text?: string } }) => e.event.text === "tidy the readme"));
  await app.close();
});

test("code in a reply is highlighted in the window, under its CSP", async () => {
  const { page, cwd } = await openApp();
  const host = await Rpc.open();
  const id = sessionId(cwd);
  await host.call("host/register", { id });
  const text = "Here:\n\n```ts\nconst answer: number = 42;\n```";
  await host.call("host/record", {
    id,
    event: { type: "assistantMessage", turn: 1, text, toolCalls: [], message: {} },
  });
  const code = page.locator(".code-block pre.code code");
  await code.getByText("42").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".code-block pre.code code span[style]").length > 3);

  const colours = await code
    .locator("span[style]")
    .evaluateAll((spans) => new Set(spans.map((s) => getComputedStyle(s).color)).size);

  assert.ok(colours >= 3, `tokens in ${colours} colours`);
  host.close();
});

test("the window's own fonts load under its CSP", async () => {
  const { page } = await openApp();
  await page.evaluate(() => document.fonts.ready);

  const loaded = await page.evaluate(() =>
    [...document.fonts].flatMap((f) => (f.status === "loaded" ? [f.family.replaceAll('"', "")] : [])),
  );

  assert.ok(loaded.includes("Geist"), `loaded: ${loaded.join(", ")}`);
  const family = await page.getByText("What should we work on?").evaluate((h) => getComputedStyle(h).fontFamily);
  assert.match(family, /^"?Geist"?,/);
});

test("a fork opens with its parent's conversation up to where it forked, and says so", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-fork-")));
  const rpc = await Rpc.open();
  const created = await rpc.call("session/create", { cwd });
  const id = JSON.parse(JSON.stringify(created.result)).id;

  await rpc.call("session/prompt", { id, text: "the first task" });
  const second = await rpc.call("session/prompt", { id, text: "the second task" });
  const at = JSON.parse(JSON.stringify(second.result)).seq - 1;
  const fork = await rpc.call("session/fork", { id, at });
  const forkId = JSON.parse(JSON.stringify(fork.result)).id;
  const userData = mkdtempSync(join(tmpdir(), "strv-desk-data-"));
  const app = await launch([`--user-data-dir=${userData}`, "--cwd", cwd, "--resume", forkId]);
  const page = await app.firstWindow();

  await page.getByText(`Forked from session ${id}`).waitFor();
  await page.locator(".msg.user", { hasText: "the first task" }).waitFor();
  assert.equal(await page.locator(".msg.user", { hasText: "the second task" }).count(), 0);
});

test("a new session starts from the sidebar, and the old one is a click away", async () => {
  const { page } = await openApp();
  await page.getByPlaceholder("Ask strive to do anything…").fill("the first task");
  await page.keyboard.press("Enter");
  await page.locator(".msg.user", { hasText: "the first task" }).waitFor();
  await page.getByRole("button", { name: "new session", exact: true }).click();
  await page.getByText("What should we work on?").waitFor();
  const first = page.locator(".session", { hasText: "the first task" });
  await first.waitFor();
  assert.equal(await page.locator(".session").count(), 2);
  await first.click();
  await page.locator(".msg.user", { hasText: "the first task" }).waitFor();
  assert.equal(await page.locator(".session.current", { hasText: "the first task" }).count(), 1);
});

test("the window switches only to its own project's sessions", async () => {
  const { page } = await openApp();
  const rpc = await Rpc.open();

  const other = await rpc.call("session/create", {
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-other-"))),
  });

  const otherId = JSON.parse(JSON.stringify(other.result)).id;

  const r = await page.evaluate(
    (id) =>
      Object.getOwnPropertyDescriptor(window, "strive")
        ?.value.switchTo(id)
        .then(
          () => "switched",
          (e: Error) => e.message,
        ),
    otherId,
  );

  assert.match(String(r), /isn't one of this project's/);
  rpc.close();
});

test("a session the window has left doesn't wait on it for approvals", async () => {
  const { page, cwd } = await openApp();
  const left = sessionId(cwd);
  await page.getByRole("button", { name: "new session", exact: true }).click();
  await page.getByText("What should we work on?").waitFor();
  const agent = await Rpc.open();
  const run = agent.call("effect/run", { id: left, callId: "c1", request: { kind: "bash", command: "echo hi" } });
  const r = await Promise.race([run, new Promise((ok) => setTimeout(() => ok("still waiting"), 8000))]);
  assert.match(JSON.stringify(r), /no client is attached/);
  agent.close();
});

/** Waits for `what` in `pane`; a timeout says what the pane showed instead. */
async function shows(pane: Locator, what: Locator, cwd?: string): Promise<void> {
  try {
    await what.waitFor();
  } catch (e) {
    const text = (await pane.textContent().catch(() => null)) ?? "(no pane)";
    const why = e instanceof Error ? e.message : "the wait failed";
    throw new Error(
      `${why}\nthe pane showed: ${text.slice(0, 2000)}${cwd === undefined ? "" : `\n${checkpointState(cwd)}`}`,
    );
  }
}

/** The checkpoints' git view of `cwd`, for a failure message: what the index recorded and what's on disk. */
function checkpointState(cwd: string): string {
  const gitDir = join(home, "sessions", sessionId(cwd), "checkpoints.git");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd, GIT_CONFIG_GLOBAL: "/dev/null" };

  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, env }).toString();
    } catch (e) {
      return e instanceof Error ? e.message : "git failed";
    }
  };

  const files = readdirSync(cwd).map((f) => {
    const s = statSync(join(cwd, f));

    return `${f} size=${s.size} mtime=${s.mtimeMs} ctime=${s.ctimeMs}`;
  });

  const index = statSync(join(gitDir, "index"));

  return [
    git("--version").trim(),
    `index mtime=${index.mtimeMs}`,
    ...files,
    "ls-files --debug:",
    git("ls-files", "--debug"),
    "diff-files:",
    git("diff-files", "--stat"),
    "log:",
    git("log", "--format=%h %s", "-5"),
  ].join("\n");
}

test("the changes pane shows what changed since the last prompt, file by file", async () => {
  const { page, cwd } = await openApp();
  writeFileSync(join(cwd, "notes.ts"), "const a = 1;\n");
  await page.getByPlaceholder("Ask strive to do anything…").fill("change things");
  await page.keyboard.press("Enter");
  await checkpointed(page);
  writeFileSync(join(cwd, "notes.ts"), "const a = 2;\n");
  writeFileSync(join(cwd, "new.txt"), "hello\n");
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "changes" });
  await shows(pane, pane.getByText("2 changed files"), cwd);
  assert.deepEqual(await pane.locator(".file-head .path").allTextContents(), ["new.txt", "notes.ts"]);
  const notes = pane.locator(".file", { hasText: "notes.ts" });
  assert.equal(await notes.locator(".row.remove").textContent(), "1−const a = 1;");
  assert.equal(await notes.locator(".row.add").textContent(), "1+const a = 2;");
});

test("the model chip picks the model for the next turns, and waits while a turn runs", async () => {
  const { page, cwd } = await openApp();
  const chip = page.getByRole("button", { name: "model: claude-sonnet-4-5" });
  await chip.click();
  const menu = page.getByRole("dialog", { name: "models" });
  await menu.getByRole("option", { name: /gpt-5-mini/ }).waitFor();
  await menu.getByRole("option", { name: /claude-haiku-4-5/ }).click();
  await page.getByRole("button", { name: "model: claude-haiku-4-5" }).waitFor();
  const id = sessionId(cwd);

  const chosen = () =>
    JSON.parse(strive("log", id, "--json"))
      .entries.filter((e: { event: { type: string } }) => e.event.type === "modelSet")
      .map((e: { event: { model: string } }) => e.event.model);

  assert.deepEqual(chosen(), ["claude-haiku-4-5"]);
  await page.getByPlaceholder("Ask strive to do anything…").fill("go");
  await page.keyboard.press("Enter");
  await page.locator(".msg.user", { hasText: "go" }).waitFor();
  // A turn runs (the tests' hosts are off; this stands in for one): the choice waits.
  const host = await Rpc.open();
  await host.call("host/register", { id });
  await host.call("host/record", { id, event: { type: "turnStarted", turn: 1 } });
  await page.getByRole("button", { name: "model: claude-haiku-4-5" }).click();
  await menu.getByText("The agent is working on this model.", { exact: false }).waitFor();
  const opus = menu.getByRole("option", { name: /claude-opus-4-5/ });
  assert.equal(await opus.getAttribute("aria-disabled"), "true");
  await opus.click({ force: true });
  assert.deepEqual(chosen(), ["claude-haiku-4-5"], "the disabled pick changed nothing");
  // Once it ends, the next turns can run on another.
  await host.call("host/record", { id, event: { type: "turnEnded", turn: 1, reason: { kind: "done" } } });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "model: claude-haiku-4-5" }).click();
  await menu.getByRole("option", { name: /claude-opus-4-5/ }).click();
  await page.getByRole("button", { name: "model: claude-opus-4-5" }).waitFor();
  assert.deepEqual(chosen(), ["claude-haiku-4-5", "claude-opus-4-5"]);
  host.close();
});

test("the palette starts a new session that Claude Code runs", async () => {
  const { page, cwd } = await openApp();
  const first = sessionId(cwd);
  await command(page, "New Claude Code session");
  await page.getByText("Claude Code runs this session; strive gates its tools.").waitFor();
  const sessions: { id: string; cwd: string }[] = JSON.parse(strive("sessions", "--all", "--json"));
  const made = sessions.find((s) => s.cwd === cwd && s.id !== first);
  assert.ok(made, JSON.stringify(sessions));

  const events: { type: string }[] = JSON.parse(strive("log", made.id, "--json")).entries.map(
    (e: { event: { type: string } }) => e.event,
  );

  assert.deepEqual(
    events.filter((e) => e.type === "engineSet"),
    [{ type: "engineSet", engine: "claude-code" }],
  );
});

test("a new session with no key for its model says how to add one, and sees one once it's added", async () => {
  const { page } = await openApp();
  const setup = page.getByRole("status").filter({ hasText: "Add an Anthropic API key to start." });
  await setup.getByText("strive auth anthropic").waitFor();
  const rpc = await Rpc.open();
  // A stand-in: the tests' hosts are off, and upstreams point at a dead port.
  const set = await rpc.call("auth/set", { provider: "anthropic", apiKey: "sk-ant-e2e-not-a-key" });
  assert.equal(set.error, undefined, JSON.stringify(set));
  await setup.getByRole("button", { name: "Check again" }).click();
  await setup.waitFor({ state: "detached" });
  await page.getByText("What should we work on?").waitFor();
  rpc.close();
});

test("a narrow window puts the sessions away and opens them over the conversation, and the changes pane covers it", async () => {
  const { app, page } = await openApp();
  const sidebar = page.getByRole("complementary", { name: "sessions sidebar" });
  await sidebar.waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(780, 700));
  await sidebar.waitFor({ state: "detached" });
  const composer = page.getByPlaceholder("Ask strive to do anything…");
  const wide = await composer.boundingBox();
  assert.ok(wide && wide.width > 600, `the conversation has the width: ${JSON.stringify(wide)}`);
  await page.getByRole("button", { name: "show sessions" }).click();
  await sidebar.waitFor();
  assert.deepEqual(await composer.boundingBox(), wide, "over the conversation, not beside it");
  await page.getByRole("button", { name: "close sessions" }).click();
  await sidebar.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = await page.getByRole("complementary", { name: "changes" }).boundingBox();
  const viewport = await page.evaluate(() => innerWidth);
  assert.ok(pane && pane.x < 1 && pane.width >= viewport - 1, `the pane covers the width: ${JSON.stringify(pane)}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 820));
  await sidebar.waitFor();
});

test("the command palette finds an action by a few letters and runs it", async () => {
  const { page, cwd } = await openApp();
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor();
  await page.keyboard.type("full-a");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "detached" });
  const log = JSON.parse(strive("log", sessionId(cwd), "--json"));
  const modes = log.entries.filter((e: { event: { type: string } }) => e.event.type === "approvalModeSet");
  assert.equal(modes.at(-1)?.event.mode, "fullAuto");
});

test("a long prompt folds, and each prompt has a tick on the rail, named by it", async () => {
  const { page } = await openApp();
  const composer = page.getByPlaceholder("Ask strive to do anything…");
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a long prompt`).join("\n");
  await composer.fill(long);
  await page.keyboard.press("Enter");
  await composer.fill("a short second prompt");
  await page.keyboard.press("Enter");
  await page.locator(".msg.user", { hasText: "a short second prompt" }).waitFor();
  const folded = page.locator(".bubble.folded");
  await folded.getByRole("button", { name: "Show more" }).click();
  await folded.waitFor({ state: "detached" });
  const ticks = page.getByRole("navigation", { name: "prompts" }).getByRole("button");
  assert.equal(await ticks.count(), 2);
  assert.equal(await ticks.nth(1).getAttribute("aria-label"), "a short second prompt");
});

test("the changes pane follows a rewind", async () => {
  const { page, cwd } = await openApp();
  writeFileSync(join(cwd, "a.txt"), "v1\n");
  await page.getByPlaceholder("Ask strive to do anything…").fill("first");
  await page.keyboard.press("Enter");
  await checkpointed(page);
  writeFileSync(join(cwd, "a.txt"), "v2\n");
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "changes" });
  await pane.getByRole("tab", { name: "Whole session" }).click();
  await shows(pane, pane.getByText("1 changed file"), cwd);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Rewind to 1");
  await page.keyboard.press("Enter");
  await pane.getByText("No changes").waitFor();
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "v1\n");
});

test("a change deep in a long file shows in the pane, with the unchanged lines folded", async () => {
  const { page, cwd } = await openApp();
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(cwd, "long.txt"), `${lines.join("\n")}\n`);
  await page.getByPlaceholder("Ask strive to do anything…").fill("first");
  await page.keyboard.press("Enter");
  await checkpointed(page);
  lines[449] = "LINE 450";
  writeFileSync(join(cwd, "long.txt"), `${lines.join("\n")}\n`);
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "changes" });
  await shows(pane, pane.locator(".row.add", { hasText: "LINE 450" }), cwd);
  await pane.getByRole("button", { name: "⋯ 446 unchanged lines" }).click();
  await pane.locator(".row.keep", { hasText: "line 1" }).first().waitFor();
});

test("a change at line 2,000 stays in view when the lines above it are opened", async () => {
  const { page, cwd } = await openApp();
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(cwd, "big.txt"), `${lines.join("\n")}\n`);
  await page.getByPlaceholder("Ask strive to do anything…").fill("first");
  await page.keyboard.press("Enter");
  await checkpointed(page);
  lines[1999] = "LINE 2000";
  writeFileSync(join(cwd, "big.txt"), `${lines.join("\n")}\n`);
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "changes" });
  await shows(pane, pane.locator(".row.add", { hasText: "LINE 2000" }), cwd);
  await pane.getByRole("button", { name: "⋯ 1996 unchanged lines" }).click();
  await pane.locator(".row.keep", { hasText: "line 1996" }).waitFor();
  assert.equal(await pane.locator(".row.add", { hasText: "LINE 2000" }).count(), 1, "the change is still drawn");
});

test("a reloaded window shows what happened since it opened", async () => {
  const { page, cwd } = await openApp();
  const rpc = await Rpc.open();
  await rpc.call("session/prompt", { id: sessionId(cwd), text: "sent after the window opened" });
  await page.locator(".msg.user", { hasText: "sent after the window opened" }).waitFor();
  await page.reload();
  await page.locator(".msg.user", { hasText: "sent after the window opened" }).waitFor({ timeout: 5000 });
  rpc.close();
});

test("an approval waits in the conversation and Allow lets the command run", async () => {
  const { app, page, cwd } = await openApp();
  const agent = await Rpc.open();
  const id = sessionId(cwd);
  const run = agent.call("effect/run", { id, callId: "c1", request: { kind: "bash", command: "echo allowed" } });
  await page.getByText("Allow the agent to run: echo allowed?").waitFor();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  const r = await run;
  assert.deepEqual({ text: "allowed\n" }, { text: JSON.parse(JSON.stringify(r.result)).text });
  // Done, the group closes; opening it shows how it was decided.
  await page.locator(".tools-head", { hasText: "Ran 1 command" }).click();
  await page.locator(".tool .badge", { hasText: "Allowed" }).waitFor();
  const log = JSON.parse(strive("log", id, "--json"));
  const decided = log.entries.find((e: { event: { type: string } }) => e.event.type === "approvalDecided");
  assert.deepEqual([decided?.event.decision, decided?.event.by], ["allow", "strive-desktop"]);
  agent.close();
  await app.close();
});

test("Rewind in the checkpoints panel puts the files back", async () => {
  const { app, page, cwd } = await openApp();
  writeFileSync(join(cwd, "notes.txt"), "v1");
  await page.getByPlaceholder("Ask strive to do anything…").fill("first");
  await page.keyboard.press("Enter");
  await command(page, "Show checkpoints");
  await page.locator(".checkpoints li", { hasText: "before “first”" }).waitFor();
  writeFileSync(join(cwd, "notes.txt"), "v2");
  await page.locator(".checkpoints li", { hasText: "before “first”" }).getByRole("button", { name: "Rewind" }).click();
  await page.getByText("Rewound to checkpoint 1.").waitFor();
  assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "v1");
  await app.close();
});

test("Rewind on a prompt asks first, then puts the files back as they were before it", async () => {
  const { page, cwd } = await openApp();
  writeFileSync(join(cwd, "notes.txt"), "v1");
  await page.getByPlaceholder("Ask strive to do anything…").fill("first");
  await page.keyboard.press("Enter");
  await checkpointed(page);
  writeFileSync(join(cwd, "notes.txt"), "v2");
  const prompt = page.locator(".msg.user", { hasText: "first" });
  await prompt.hover();
  await prompt.getByRole("button", { name: "rewind to before this prompt" }).click();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "v2", "cancelled: nothing restored");
  await prompt.hover();
  await prompt.getByRole("button", { name: "rewind to before this prompt" }).click();
  await prompt.getByRole("button", { name: "Restore files" }).click();
  await page.getByText("Rewound to checkpoint 1.").waitFor();
  assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "v1");
});

test("the conversation has the window to itself until a panel is shown, which is saved and can be hidden", async () => {
  const { page, userData } = await openApp();
  assert.equal(await page.locator("[data-panel]").count(), 1, "only the conversation");
  assert.equal(await page.locator('[data-panel="transcript"] .handle').count(), 0, "nowhere to drag it");
  await command(page, "Show spend");
  await page.locator('[data-column="side"] [data-panel="spend"]').waitFor();
  await page.locator('[data-panel="transcript"] .handle').waitFor({ state: "attached" });
  const saved = JSON.parse(readFileSync(join(userData, "workspace.json"), "utf8"));
  assert.deepEqual(saved.edits.at(-1).ops, [{ op: "move", panel: "spend", column: "side" }]);
  await page.locator('[data-panel="spend"]').hover();
  await page.getByRole("button", { name: "hide spend" }).click();
  await page.locator('[data-panel="spend"]').waitFor({ state: "detached" });
  await command(page, "Show spend");
  await page.locator('[data-panel="spend"]').waitFor();
});

test("a panel dragged to another column stays there, and is saved", async () => {
  const { app, page, userData } = await openApp();
  await command(page, "Show spend");
  const spend = page.locator('[data-panel="spend"] .handle');
  const main = page.locator('[data-column="main"]');
  const from = await spend.boundingBox();
  const to = await main.boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 10, { steps: 10 });
  await page.mouse.up();
  await page.locator('[data-column="main"] [data-panel="spend"]').waitFor();

  const order = await page
    .locator('[data-column="main"] [data-panel]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));

  assert.deepEqual(order, ["transcript", "spend"], "dropped on the lower half of the transcript: after it");
  const saved = JSON.parse(readFileSync(join(userData, "workspace.json"), "utf8"));
  assert.deepEqual(saved.edits.at(-1).ops, [{ op: "move", panel: "spend", column: "main" }]);
  await app.close();
});

test("the window has no Node, only the app's bridge", async () => {
  const { app, page } = await openApp();

  const seen = await page.evaluate(() => ({
    require: "require" in globalThis,
    process: "process" in globalThis,
    bridge: Object.keys(Object.getOwnPropertyDescriptor(window, "strive")?.value ?? {}).sort(),
  }));

  assert.deepEqual(seen, {
    require: false,
    process: false,
    bridge: [
      "blob",
      "cited",
      "close",
      "learning",
      "loadWorkspace",
      "onClosed",
      "onClosing",
      "onEvent",
      "onLearning",
      "opened",
      "proposalBefore",
      "request",
      "saveWorkspace",
      "sessions",
      "switchTo",
    ],
  });
  await app.close();
});

/** A widget that reports what it can reach from inside its sandbox. */
const PROBE = `<body><p id="out">starting</p><script>
const seen = [];
const probe = (name, f) => { try { f(); seen.push(name + ": reached"); } catch { seen.push(name + ": blocked"); } };
probe("parent", () => parent.document.title);
probe("bridge", () => { if (!top.strive) throw new Error(); });
probe("storage", () => localStorage.getItem("x"));
document.getElementById("out").textContent = seen.join(", ");
fetch("https://example.com").then(() => document.body.append(" network: reached"), () => document.body.append(" network: blocked"));
</script></body>`;

/** Registers as the session's host (only it may propose) and proposes. */
async function propose(cwd: string, label: string, ops: Json[]): Promise<Rpc> {
  const host = await Rpc.open();
  const id = sessionId(cwd);
  await host.call("host/register", { id });
  const r = await host.call("host/record", { id, event: { type: "layoutProposed", label, ops } });
  assert.equal(r.error, undefined, JSON.stringify(r));

  return host;
}

test("an agent's layout proposal changes nothing until accepted, and can be undone", async () => {
  const { app, page, cwd } = await openApp();

  const host = await propose(cwd, "show a probe", [
    { op: "add", panel: { id: "probe", kind: "html", title: "Probe", html: PROBE }, column: "side" },
  ]);

  await page.getByText("The agent proposes: show a probe").waitFor();
  assert.equal(await page.locator('[data-panel="probe"]').count(), 0, "not applied yet");
  await page.getByRole("button", { name: "Accept" }).click();
  const widget = page.frameLocator("iframe.widget");
  await widget.getByText("parent: blocked, bridge: blocked, storage: blocked").waitFor();
  await widget.getByText("network: blocked").waitFor();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.locator('[data-panel="probe"]').waitFor({ state: "detached" });
  host.close();
  await app.close();
});

test("a rejected proposal isn't offered again, even after reopening", async () => {
  const first = await openApp();
  const host = await propose(first.cwd, "show spend", [{ op: "move", panel: "spend", column: "side" }]);
  await first.page.getByText("The agent proposes: show spend").waitFor();
  await first.page.getByRole("button", { name: "Reject" }).click();
  await first.page.getByText("The agent proposes: show spend").waitFor({ state: "detached" });
  host.close();
  await first.app.close();

  const again = await launch([`--user-data-dir=${first.userData}`, "--cwd", first.cwd, "--continue"]);

  const page = await again.firstWindow();
  await page.getByText("The agent proposed a layout change: show spend").waitFor();
  assert.equal(await page.getByText("The agent proposes: show spend").count(), 0);
  assert.equal(await page.locator('[data-panel="spend"]').count(), 0, "the rejected change isn't applied");
  await again.close();
});

test("the window can act only on its own session", async () => {
  const { app, page, cwd } = await openApp();
  const other = realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-other-")));
  const rpc = await Rpc.open();
  const created = await rpc.call("session/create", { cwd: other });
  const otherId = JSON.parse(JSON.stringify(created.result)).id;
  // What code in the window could try: the bridge, with another session's id.
  await page.evaluate(
    (id) =>
      Object.getOwnPropertyDescriptor(window, "strive")?.value.request("session/approvals", { id, mode: "fullAuto" }),
    otherId,
  );
  const log = JSON.parse(strive("log", otherId, "--json"));
  const modes = log.entries.filter((e: { event: { type: string } }) => e.event.type === "approvalModeSet");
  assert.deepEqual(
    modes.map((e: { event: { mode: string } }) => e.event.mode),
    ["autoEdit"],
    "the other session is untouched",
  );
  const own = JSON.parse(strive("log", sessionId(cwd), "--json"));
  assert.ok(own.entries.some((e: { event: { type: string; mode?: string } }) => e.event.mode === "fullAuto"));
  rpc.close();
  await app.close();
});

/** Writes `content` to a file in the session as its host would; the write's content digest. */
async function written(id: string, content: string): Promise<string> {
  const host = await Rpc.open();
  await host.call("host/register", { id });
  const r = await host.call("effect/run", { id, callId: "w1", request: { kind: "write", path: "w.txt", content } });
  assert.equal(r.error, undefined, JSON.stringify(r));
  host.close();
  const log = JSON.parse(strive("log", id, "--json"));
  const started = log.entries.find((e: { event: { type: string } }) => e.event.type === "effectStarted");

  return started.event.record.content;
}

test("the window reads tool output its own session names, and no other session's", async () => {
  const { app, page, cwd } = await openApp();
  const rpc = await Rpc.open();

  const other = await rpc.call("session/create", {
    cwd: realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-other-"))),
  });

  const theirs = await written(JSON.parse(JSON.stringify(other.result)).id, "the other session's secret");
  const ours = await written(sessionId(cwd), "ours");
  await page.locator(".tools-head", { hasText: "Edited 1 file" }).click(); // the window has seen the entry
  await page.locator(".tool .label", { hasText: "w.txt" }).waitFor();

  // What code in the window could try: the bridge, with any digest.
  const blob = (digest: string) =>
    page.evaluate(
      (d) =>
        Object.getOwnPropertyDescriptor(window, "strive")
          ?.value.blob(d)
          .then(
            (text: string) => ({ text }),
            (e: Error) => ({ error: e.message }),
          ),
      digest,
    );

  assert.deepEqual(await blob(ours), { text: "ours" });
  const refused = await blob(theirs);
  assert.ok("error" in refused && /isn't this session's/.test(refused.error), JSON.stringify(refused));
  rpc.close();
  await app.close();
});

/**
 * A widget that tries WebRTC three ways, each against its own STUN (UDP) and
 * TURN (TCP) "servers": directly, from an about:blank frame's realm, and from
 * a srcdoc frame running its own script.
 */
const rtcProbe = (direct: Listener, blank: Listener, nested: Listener) => `<body><p id="out">trying</p><script>
const out = document.getElementById("out");
const offer = (w, udp, tcp) => {
  const pc = new w.RTCPeerConnection({ iceServers: [
    { urls: "stun:127.0.0.1:" + udp },
    { urls: "turn:127.0.0.1:" + tcp + "?transport=tcp", username: "u", credential: "p" },
  ] });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o));
};
try { offer(window, ${direct.udp}, ${direct.tcp}); out.append(" direct: created"); } catch { out.append(" direct: blocked"); }
const f = document.createElement("iframe");
document.body.append(f);
try { offer(f.contentWindow, ${blank.udp}, ${blank.tcp}); out.append(" blank: created"); } catch { out.append(" blank: blocked"); }
const nested = document.createElement("iframe");
nested.srcdoc = "<script>" + offer.toString().replace("(w, udp, tcp) =>", "const go = (w, udp, tcp) =>") + "; try { go(window, ${nested.udp}, ${nested.tcp}); } catch {}<\\/script>";
document.body.append(nested);
setTimeout(() => out.append(" done"), 2500);
</script></body>`;

type Listener = { udp: number; tcp: number; reached: () => number; close: () => void };

/** A TCP listener's address: a string only for a pipe, null before it listens. */
function isInet(a: AddressInfo | string | null): a is AddressInfo {
  return a !== null && typeof a === "object";
}

/** A UDP and a TCP listener that count what reaches them. */
async function listener(): Promise<Listener> {
  let reached = 0;
  const udp = createSocket("udp4", () => reached++);
  await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", () => ok()));

  const tcp = createServer((c) => {
    reached++;
    c.destroy();
  });

  await new Promise<void>((ok) => tcp.listen(0, "127.0.0.1", () => ok()));
  const address = tcp.address();
  assert.ok(isInet(address));

  return {
    udp: udp.address().port,
    tcp: address.port,
    reached: () => reached,
    close: () => {
      udp.close();
      tcp.close();
    },
  };
}

test("a widget can't reach the network through WebRTC", async () => {
  const listeners = await Promise.all([listener(), listener(), listener()]);
  const [direct, blank, nested] = listeners;
  const { page, cwd } = await openApp();
  const html = rtcProbe(direct, blank, nested);

  const host = await propose(cwd, "rtc probe", [
    { op: "add", panel: { id: "rtc", kind: "html", title: "RTC", html }, column: "side" },
  ]);

  try {
    await page.getByRole("button", { name: "Accept" }).click();
    await page.frameLocator("iframe.widget").getByText("done").waitFor();
    await new Promise((ok) => setTimeout(ok, 500));
    const reached = { direct: direct.reached(), blank: blank.reached(), nested: nested.reached() };
    assert.deepEqual(reached, { direct: 0, blank: 0, nested: 0 }, "no STUN or TURN request reached any listener");
  } finally {
    for (const l of listeners) l.close();
    host.close();
  }
});

test("a decision made in one window survives another window's save", async () => {
  const a = await openApp();

  const b = await launch([`--user-data-dir=${a.userData}`, "--cwd", a.cwd, "--continue"]);

  const pageB = await b.firstWindow();
  await pageB.getByText(`Session started in ${a.cwd}`).waitFor();
  const host = await propose(a.cwd, "drop spend", [{ op: "remove", panel: "spend" }]);
  await a.page.getByRole("button", { name: "Reject" }).click();
  await a.page.getByText("The agent proposes: drop spend").waitFor({ state: "detached" });
  // B still offers it, but saves from B (showing a panel, a drag) must not undo A's rejection.
  await command(pageB, "Show spend");
  const spend = pageB.locator('[data-panel="spend"] .handle');
  const main = pageB.locator('[data-column="main"]');
  const from = await spend.boundingBox();
  const to = await main.boundingBox();
  assert.ok(from && to);
  await pageB.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await pageB.mouse.down();
  await pageB.mouse.move(to.x + to.width / 2, to.y + to.height - 10, { steps: 10 });
  await pageB.mouse.up();
  await pageB.locator('[data-column="main"] [data-panel="spend"]').waitFor();
  const saved = JSON.parse(readFileSync(join(a.userData, "workspace.json"), "utf8"));
  assert.equal(saved.decided.length, 1, JSON.stringify(saved.decided));
  host.close();
  await b.close();
  await a.app.close();
});

// --- The Learned pane (ADR-0016): the tests stand in for the learner, as
// the project's learning session's host, and propose over RPC.

/** A reply's result, once it's known to have succeeded. */
function resultOf(r: Reply) {
  assert.equal(r.error, undefined, JSON.stringify(r));

  return JSON.parse(JSON.stringify(r.result));
}

type Learner = { host: Rpc; id: string };

/**
 * A connection registered as the project's learner. Registering shows it
 * the project's memory as it is now: a proposal's "before".
 */
async function learner(cwd: string, at = home): Promise<Learner> {
  const rpc = await Rpc.open(at);
  const id = String(resultOf(await rpc.call("learning/open", { cwd })).id);
  rpc.close();
  const host = await Rpc.open(at);
  resultOf(await host.call("host/register", { id }));

  return { host, id };
}

/** A memory proposal: adding the bullet `text`, or changing the bullet `bullet` names to it. */
type Proposed = { summary: string; text: string; bullet?: string; evidence?: string; seqs?: number[]; note?: string };

/** Proposes a change to the project's memory, citing a work session's entries (its first by default); its id. */
async function proposeMemory(l: Learner, cwd: string, p: Proposed): Promise<number> {
  const change: Json =
    p.bullet === undefined
      ? { kind: "memory", op: "add", text: p.text }
      : { kind: "memory", op: "change", bullet: p.bullet, text: p.text };

  const proposal = {
    change,
    summary: p.summary,
    rationale: `Why: ${p.summary}.`,
    evidence: [
      { session: p.evidence ?? sessionId(cwd), seqs: p.seqs ?? [1], note: p.note ?? "the session began here" },
    ],
    prediction: `Later sessions follow: ${p.summary}.`,
  };

  const r = await l.host.call("host/record", { id: l.id, event: { type: "proposalMade", proposal } });

  return Number(resultOf(r).seq);
}

function memoryFile(cwd: string): string {
  return join(cwd, ".strive/memory.md");
}

function writeMemory(cwd: string, text: string) {
  mkdirSync(join(cwd, ".strive"), { recursive: true });
  writeFileSync(memoryFile(cwd), text);
}

/** The learning session's events, by type. */
async function learningEvents(cwd: string, type: string): Promise<{ [key: string]: Json }[]> {
  const rpc = await Rpc.open();
  const id = String(resultOf(await rpc.call("learning/open", { cwd })).id);

  const read: { entries: { seq: number; event: { [key: string]: Json } }[] } = resultOf(
    await rpc.call("session/read", { id }),
  );

  rpc.close();

  return read.entries.flatMap((e) => (e.event.type === type ? [{ ...e.event, seq: e.seq }] : []));
}

/** Opens the Learned pane with ⌘L. */
async function learnedPane(page: Page) {
  await page.keyboard.press("Meta+l");
  const pane = page.getByRole("complementary", { name: "learned" });
  await pane.waitFor();

  return pane;
}

/** Opens a proposal from the pane's list. */
async function openProposal(page: Page, id: number) {
  const pane = await learnedPane(page);
  await pane.locator(`.learned-item[data-proposal="${id}"]`).click();
  await pane.locator(`.learned-detail[data-proposal="${id}"]`).waitFor();

  return pane;
}

test("the Learned pane lists proposals newest first, and shows one with its diff, reasons, evidence and checks", async () => {
  const { page, cwd } = await openApp();
  const rpc = await Rpc.open();
  const other = String(resultOf(await rpc.call("session/create", { cwd })).id);
  await rpc.call("session/prompt", { id: other, text: "tidy the changelog" });
  rpc.close();
  const l = await learner(cwd);
  await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });

  const second = await proposeMemory(l, cwd, {
    summary: "Keep the changelog sorted",
    text: "Sort the changelog by date, newest first.",
    evidence: other,
    note: "the user asked to tidy it",
  });

  const pane = await learnedPane(page);
  await pane.locator(".learned-item").nth(1).waitFor();

  assert.deepEqual(await pane.locator(".learned-item .summary").allTextContents(), [
    "Keep the changelog sorted",
    "Run the tests with bun",
  ]);

  assert.deepEqual(await pane.locator(".learned-item .badge").allTextContents(), ["ready", "ready"]);
  assert.deepEqual(await pane.locator(".learned-item .mono").allTextContents(), ["memory", "memory"]);
  await pane.locator(`.learned-item[data-proposal="${second}"]`).click();
  const detail = pane.locator(`.learned-detail[data-proposal="${second}"]`);
  await detail.getByText("Adds a bullet").waitFor();
  await detail.locator(".row.add").waitFor();

  assert.deepEqual(await detail.locator(".row.add").allTextContents(), [
    `1+- Sort the changelog by date, newest first. <!-- strive:#${second} -->`,
  ]);

  await detail.getByText("Why: Keep the changelog sorted.").waitFor();
  await detail.getByText("Later sessions follow: Keep the changelog sorted.").waitFor();
  await detail.getByText("the user asked to tidy it").waitFor();
  await detail.locator("[data-gate=static] .badge", { hasText: "passed" }).waitFor();
  // What the judge said depends on whether an earlier test stored a key in
  // this shared daemon; the pane shows whatever the daemon recorded.
  const lister = await Rpc.open();
  const listed = resultOf(await lister.call("proposal/list", { cwd }));
  lister.close();

  const judged = listed.proposals
    .find((p: { id: number }) => p.id === second)
    ?.gates.find((g: { gate: string }) => g.gate === "judge");

  assert.ok(judged?.detail, JSON.stringify(listed));
  await detail.locator("[data-gate=judge] .detail", { hasText: judged.detail }).waitFor();

  // The evidence's session is one of this project's: a click shows it, and the proposal stays open.
  await detail.getByRole("button", { name: "tidy the changelog" }).click();
  await page.locator(".msg.user", { hasText: "tidy the changelog" }).waitFor();
  await page.locator(`.learned-detail[data-proposal="${second}"]`).getByText("(shown)").waitFor();
  l.host.close();
});

test("the Learned button counts the proposals waiting for a decision", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const button = page.getByRole("button", { name: "learned", exact: true });
  const count = button.locator(".count");
  await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });
  const second = await proposeMemory(l, cwd, { summary: "Keep it short", text: "Short." });
  // The person comes back to the window from the terminal where the learner ran.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await count.getByText("2", { exact: true }).waitFor();
  assert.equal(await button.getAttribute("title"), "Learned (⌘L): 2 to review");

  const rpc = await Rpc.open();
  resultOf(await rpc.call("proposal/decide", { cwd, proposal: second, decision: "reject" }));
  rpc.close();
  await count.getByText("1", { exact: true }).waitFor();
  l.host.close();
});

test("Accept in the Learned pane asks first, then writes the proposal's file", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const id = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });
  const pane = await openProposal(page, id);
  await pane.getByRole("button", { name: "Accept" }).click();
  const confirm = pane.getByRole("group", { name: "confirm accept" });
  await confirm.getByText("Write .strive/memory.md?").waitFor();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.equal(existsSync(memoryFile(cwd)), false, "cancelled: nothing written");
  await pane.getByRole("button", { name: "Accept" }).click();
  await confirm.getByRole("button", { name: "Write it" }).click();
  await pane.locator(".learned-title .badge", { hasText: "applied" }).waitFor();
  assert.equal(readFileSync(memoryFile(cwd), "utf8"), `- Run \`bun test\`. <!-- strive:#${id} -->\n`);
  const decided = await learningEvents(cwd, "proposalDecided");
  assert.deepEqual(
    decided.map((e) => [e.proposal, e.decision, e.by]),
    [[id, "accept", "strive-desktop"]],
  );
  l.host.close();
});

test("Reject in the Learned pane writes nothing and says so", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const id = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });
  const pane = await openProposal(page, id);
  await pane.getByRole("button", { name: "Reject" }).click();
  await pane.locator(".learned-title .badge", { hasText: "rejected" }).waitFor();
  await pane.getByText("Rejected. Nothing was written.").waitFor();
  assert.equal(await pane.getByRole("button", { name: "Accept" }).count(), 0, "a rejected proposal can't be accepted");
  assert.equal(existsSync(memoryFile(cwd)), false);
  const decided = await learningEvents(cwd, "proposalDecided");
  assert.deepEqual(
    decided.map((e) => [e.proposal, e.decision]),
    [[id, "reject"]],
  );
  l.host.close();
});

test("Roll back in the Learned pane asks first, then puts the bullet back as it was", async () => {
  const { page, cwd } = await openApp();
  writeMemory(cwd, "- The old rule.\n- Another rule.\n");
  const l = await learner(cwd);

  const id = await proposeMemory(l, cwd, {
    summary: "Replace the rule",
    bullet: "The old rule.",
    text: "The new rule.",
  });

  const pane = await openProposal(page, id);
  // The diff is one bullet.
  await pane.getByText("Changes a bullet").waitFor();
  await pane.locator(".row.remove").waitFor();
  assert.deepEqual(await pane.locator(".row.remove").allTextContents(), ["1−- The old rule."]);
  assert.deepEqual(await pane.locator(".row.add").allTextContents(), [`1+- The new rule. <!-- strive:#${id} -->`]);
  await pane.getByRole("button", { name: "Accept" }).click();
  await pane.getByRole("button", { name: "Write it" }).click();
  await pane.locator(".learned-title .badge", { hasText: "applied" }).waitFor();
  assert.equal(readFileSync(memoryFile(cwd), "utf8"), `- The new rule. <!-- strive:#${id} -->\n- Another rule.\n`);
  // An edit elsewhere doesn't stand in the way.
  writeMemory(cwd, `- The new rule. <!-- strive:#${id} -->\n- Another rule, edited.\n`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pane.getByRole("button", { name: "Roll back" }).click();
  const confirm = pane.getByRole("group", { name: "confirm rollback" });
  await confirm.getByText("Put its bullet back as it was before this proposal?").waitFor();
  await confirm.getByRole("button", { name: "Roll back" }).click();
  await pane.locator(".learned-title .badge", { hasText: "rolled back" }).waitFor();
  assert.equal(readFileSync(memoryFile(cwd), "utf8"), "- The old rule.\n- Another rule, edited.\n");
  assert.equal((await learningEvents(cwd, "proposalRolledBack")).length, 1);
  l.host.close();
});

test("a proposal that failed its safety checks can't be accepted, and Accept says why", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const nowhere = "01J8ZZZZZZZZZZZZZZZZZZZZZZ";
  const id = await proposeMemory(l, cwd, { summary: "Cite nothing", text: "Rule.", evidence: nowhere });
  const pane = await openProposal(page, id);
  await pane.getByText("It failed its safety checks, so it can't be accepted.").waitFor();
  const accept = pane.getByRole("button", { name: "Accept" });
  assert.equal(await accept.isDisabled(), true);
  assert.equal(await accept.getAttribute("title"), "It failed its safety checks, so it can't be accepted");
  l.host.close();
});

test("Roll back isn't offered once a later accept changed the proposal's bullet or a person did", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const first = await proposeMemory(l, cwd, { summary: "First rule", text: "First." });
  const rpc = await Rpc.open();
  resultOf(await rpc.call("proposal/decide", { cwd, proposal: first, decision: "accept" }));
  // Registered again, the learner is shown the file as the first accept left it.
  resultOf(await l.host.call("host/register", { id: l.id }));
  const second = await proposeMemory(l, cwd, { summary: "Second rule", bullet: `#${first}`, text: "Second." });
  resultOf(await rpc.call("proposal/decide", { cwd, proposal: second, decision: "accept" }));
  rpc.close();

  const pane = await openProposal(page, first);
  await pane.locator(".learned-title .badge", { hasText: `replaced by #${second}` }).waitFor();
  await pane.getByText(`#${second} changed or removed its bullet`, { exact: false }).waitFor();
  assert.equal(await pane.getByRole("button", { name: "Roll back" }).count(), 0);

  await pane.getByRole("button", { name: "all proposals" }).click();
  await pane.locator(`.learned-item[data-proposal="${second}"]`).click();
  const detail = pane.locator(`.learned-detail[data-proposal="${second}"]`);
  await detail.getByRole("button", { name: "Roll back" }).waitFor();
  writeMemory(cwd, `- Second, by hand. <!-- strive:#${second} -->\n`);
  // Back from the editor, the window looks at the file again.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await detail.getByText("Its bullet has changed since, so it can't be rolled back", { exact: false }).waitFor();
  assert.equal(await detail.getByRole("button", { name: "Roll back" }).count(), 0);
  l.host.close();
});

test("a proposal whose file changed since it was proposed isn't written, and the pane says so", async () => {
  const { page, cwd } = await openApp();
  writeMemory(cwd, "- The old rule.\n");
  const l = await learner(cwd);

  const id = await proposeMemory(l, cwd, {
    summary: "Replace the rule",
    bullet: "The old rule.",
    text: "The new rule.",
  });

  writeMemory(cwd, "- The old rule, as a person rewrote it meanwhile.\n");
  const pane = await openProposal(page, id);
  await pane.getByRole("button", { name: "Accept" }).click();
  await pane.getByRole("button", { name: "Write it" }).click();
  await pane.locator(".learned-title .badge", { hasText: "file changed" }).waitFor();

  await pane
    .getByText("The bullet it changes was edited since this was proposed, so nothing was written.", { exact: false })
    .waitFor();

  await pane.getByRole("button", { name: "Learn from recent sessions" }).waitFor();
  assert.equal(readFileSync(memoryFile(cwd), "utf8"), "- The old rule, as a person rewrote it meanwhile.\n");
  assert.equal((await learningEvents(cwd, "proposalApplied")).length, 0);
  l.host.close();
});

test("the window acts only on its own project's proposals, and reads their files only through them", async () => {
  const { page, cwd } = await openApp();
  writeMemory(cwd, "- Ours.\n");
  const ours = await learner(cwd);
  const mine = await proposeMemory(ours, cwd, { summary: "Ours", text: "Ours, better." });
  // Another project, with a proposal of its own.
  const theirs = realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-other-")));
  const rpc = await Rpc.open();
  const theirWork = String(resultOf(await rpc.call("session/create", { cwd: theirs })).id);
  const l = await learner(theirs);
  await proposeMemory(l, theirs, { summary: "Theirs, first", text: "Theirs.", evidence: theirWork });
  // Ids are seqs in each project's own learning session: this one names nothing in ours.
  const id = await proposeMemory(l, theirs, { summary: "Theirs", text: "Theirs.", evidence: theirWork });
  const ourIds = JSON.stringify(resultOf(await rpc.call("proposal/list", { cwd })));
  assert.ok(!ourIds.includes(`"id":${id},`), "their proposal's id isn't one of ours");

  // What code in the window could try: the bridge, naming the other project.
  const tried = await page.evaluate(
    async ([dir, proposal]) => {
      const bridge = Object.getOwnPropertyDescriptor(window, "strive")?.value;

      const outcome = (p: Promise<unknown>) =>
        p.then(
          (r) => ({ ok: JSON.stringify(r) }),
          (e: Error) => ({ error: e.message }),
        );

      return {
        decide: await outcome(bridge.request("proposal/decide", { cwd: dir, proposal, decision: "accept" })),
        list: await outcome(bridge.request("proposal/list", { cwd: dir })),
        before: await outcome(bridge.proposalBefore(proposal)),
        learning: await outcome(bridge.learning()),
      };
    },
    [theirs, id] as const,
  );

  assert.ok("error" in tried.decide, `the decision was refused: ${JSON.stringify(tried.decide)}`);
  assert.ok("error" in tried.before, `their file wasn't read: ${JSON.stringify(tried.before)}`);
  assert.ok("ok" in tried.list && !tried.list.ok.includes("Theirs"), `our list only: ${JSON.stringify(tried.list)}`);
  assert.ok("ok" in tried.learning && !tried.learning.ok.includes(theirs), "our learning session only");
  assert.equal(existsSync(memoryFile(theirs)), false, "nothing written in the other project");
  const listed = resultOf(await rpc.call("proposal/list", { cwd: theirs }));
  assert.match(JSON.stringify(listed), /"status":"ready"/, "theirs is still undecided");

  // Our proposal's "before" is readable through the proposal, but not as a blob: it isn't the shown session's.
  const reads = await page.evaluate(async (proposal) => {
    const bridge = Object.getOwnPropertyDescriptor(window, "strive")?.value;
    const text = await bridge.proposalBefore(proposal);
    const { proposals } = await bridge.request("proposal/list", { cwd: "" });
    const digest = proposals.find((p: { id: number }) => p.id === proposal)?.before;

    const blob = await bridge.blob(digest).then(
      () => "read",
      (e: Error) => e.message,
    );

    return { text, blob };
  }, mine);

  assert.equal(reads.text, "- Ours.\n");
  assert.match(reads.blob, /isn't this session's/);
  rpc.close();
  l.host.close();
  ours.host.close();
});

test("Learn from recent sessions starts a run that the pane follows until its proposals arrive", async () => {
  const { page, cwd } = await openApp();
  const pane = await learnedPane(page);
  await pane.getByText("The learner reads this project's recent sessions").waitFor();
  await pane.getByRole("button", { name: "Learn from recent sessions" }).click();
  const learning = pane.getByRole("status").filter({ hasText: "Learning…" });
  await learning.waitFor();
  const asked = await learningEvents(cwd, "learnRequested");
  assert.equal(asked.length, 1, "the run was requested");
  // The learner takes the request, reads, proposes, and ends its turn.
  const l = await learner(cwd);
  const took = { type: "turnStarted", turn: 1, throughSeq: Number(asked[0]?.seq) };
  resultOf(await l.host.call("host/record", { id: l.id, event: took }));

  const reading = {
    type: "assistantMessage",
    turn: 1,
    text: "",
    toolCalls: [{ id: "c1", name: "read_session" }],
    message: {},
  };

  resultOf(await l.host.call("host/record", { id: l.id, event: reading }));
  await learning.getByText("Reading a session").waitFor();
  const id = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });

  const ended = { type: "turnEnded", turn: 1, reason: { kind: "done" } };
  resultOf(await l.host.call("host/record", { id: l.id, event: ended }));
  await learning.waitFor({ state: "detached" });
  await pane.locator(`.learned-item[data-proposal="${id}"]`, { hasText: "Run the tests with bun" }).waitFor();
  l.host.close();
});

/** Closes the Learned pane and opens it again, as a person coming back to it does. */
async function reopenLearned(page: Page) {
  await page.keyboard.press("Meta+l");
  await page.getByRole("complementary", { name: "learned" }).waitFor({ state: "detached" });

  return learnedPane(page);
}

test("a learned file edited by hand after an accept shows as changed outside review", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const id = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });
  const older = await proposeMemory(l, cwd, { summary: "Sort the changelog", text: "Sort it." });
  let pane = await openProposal(page, id);
  await pane.getByRole("button", { name: "Accept" }).click();
  await pane.getByRole("button", { name: "Write it" }).click();
  await pane.locator(".learned-title .badge", { hasText: "applied" }).waitFor();
  // As the accepted proposal left it: nothing to say.
  await pane.getByRole("button", { name: "all proposals" }).click();
  await pane.locator(`.learned-item[data-proposal="${older}"]`).waitFor();
  const notice = pane.getByRole("region", { name: "changed outside review" });
  assert.equal(await notice.count(), 0);

  // A bullet a person adds is theirs; a learned bullet they rewrite isn't what review saw.
  writeMemory(cwd, `- Run \`bun test\`. <!-- strive:#${id} -->\n- A rule a person wrote.\n`);
  pane = await reopenLearned(page);
  await pane.locator(`.learned-item[data-proposal="${older}"]`).waitFor();
  assert.equal(await notice.count(), 0);
  const edited = `- Run \`bun test\` with no flags. <!-- strive:#${id} -->\n- A rule a person wrote.\n`;
  writeMemory(cwd, edited);
  pane = await reopenLearned(page);
  await notice.waitFor();
  assert.deepEqual(await notice.locator("li").allTextContents(), [".strive/memory.md"]);
  await notice.getByText("New sessions read it as it is, unreviewed.", { exact: false }).waitFor();
  // The proposal says so too, and offers no rollback: the daemon would refuse one over the edit.
  await pane.locator(`.learned-item[data-proposal="${id}"]`).click();
  const detail = pane.locator(`.learned-detail[data-proposal="${id}"]`);
  await detail.locator(".status-note.outside", { hasText: ".strive/memory.md has changed outside review" }).waitFor();
  await detail.getByText("Its bullet has changed since, so it can't be rolled back", { exact: false }).waitFor();
  assert.equal(await detail.getByRole("button", { name: "Roll back" }).count(), 0);
  assert.equal(readFileSync(memoryFile(cwd), "utf8"), edited);
  l.host.close();
});

test("the Learned pane shows what every session reads now, each bullet with its source", async () => {
  const { page, cwd } = await openApp();
  writeMemory(cwd, "# Notes\n\n- Use bun.\n");
  const l = await learner(cwd);
  const id = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test src`." });
  const rpc = await Rpc.open();
  resultOf(await rpc.call("proposal/decide", { cwd, proposal: id, decision: "accept" }));
  rpc.close();
  const pane = await learnedPane(page);
  const now = pane.getByRole("region", { name: "what every session reads now" });
  await now.getByRole("button", { name: /What every session reads now/ }).click();
  const bullets = now.locator(".memory-bullets > li[data-source]");
  await bullets.nth(1).waitFor();
  assert.deepEqual(
    await bullets.evaluateAll((els) =>
      els.map((e) => [e.querySelector(".text")?.textContent, e.querySelector(".source")?.textContent]),
    ),
    [
      ["Use bun.", "hand-written"],
      ["Run `bun test src`.", `#${id}`],
    ],
  );
  await now.locator(".memory-line", { hasText: "# Notes" }).waitFor();
  await page.screenshot({ path: join(tmpdir(), "strive-memory-now.png") });
  // Its source is a click away.
  await now.getByRole("button", { name: `#${id}` }).click();
  await pane.locator(`.learned-detail[data-proposal="${id}"]`).waitFor();
  l.host.close();
});

test("evidence opens to the entries it cites, and a click on one shows it in its session", async () => {
  const { page, cwd } = await openApp();
  const rpc = await Rpc.open();
  const work = String(resultOf(await rpc.call("session/create", { cwd })).id);
  const text = "run the tests and tell me what fails";
  const asked = Number(resultOf(await rpc.call("session/prompt", { id: work, text })).seq);

  // Enough after the prompt that it starts out of view.
  for (let i = 1; i <= 16; i++)
    resultOf(await rpc.call("session/prompt", { id: work, text: `later note ${i}\nsecond line\nthird line` }));

  resultOf(await rpc.call("session/approvals", { id: work, mode: "fullAuto" }));
  const host = await Rpc.open();
  resultOf(await host.call("host/register", { id: work }));
  const command = "echo 1 test failed; exit 3";
  resultOf(await host.call("effect/run", { id: work, callId: "b1", request: { kind: "bash", command } }));
  host.close();
  const log: { entries: { seq: number; event: { type: string } }[] } = JSON.parse(strive("log", work, "--json"));
  const ran = log.entries.find((e) => e.event.type === "effectStarted")?.seq;
  const finished = log.entries.find((e) => e.event.type === "effectFinished")?.seq;
  assert.ok(ran !== undefined && finished !== undefined, JSON.stringify(log));
  const l = await learner(cwd);

  const id = await proposeMemory(l, cwd, {
    summary: "Say which test failed",
    text: "Name the failing test.",
    evidence: work,
    seqs: [asked, finished],
    note: "the user asked, and one test failed",
  });

  const pane = await openProposal(page, id);
  const item = pane.locator(".evidence > li");
  await item.getByText("the user asked, and one test failed").waitFor();
  assert.equal(await item.getByRole("list", { name: "cited entries" }).count(), 0, "closed until asked for");
  await item.getByRole("button", { name: "Show what the 2 entries say" }).click();
  const cited = item.getByRole("list", { name: "cited entries" });
  await cited.locator(`[data-seq="${asked}"]`, { hasText: text }).waitFor();
  // The cited result brings its command along.
  assert.equal(await cited.locator(`[data-seq="${ran}"] .code`).textContent(), command);
  await cited.locator(`[data-seq="${finished}"] .who`, { hasText: `Result of #${ran}` }).waitFor();
  await cited.locator(`[data-seq="${finished}"]`, { hasText: "Exit 3" }).waitFor();
  assert.equal(await cited.locator(`[data-seq="${finished}"] .output`).textContent(), "1 test failed");

  // Only this project's sessions: code in the window naming another project's session is refused.
  const theirs = String(
    resultOf(await rpc.call("session/create", { cwd: realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-other-"))) }))
      .id,
  );

  const tried = await page.evaluate(
    (session) =>
      Object.getOwnPropertyDescriptor(window, "strive")
        ?.value.cited(session, [1])
        .then(
          () => ({ ok: "read" }),
          (e: Error) => ({ error: e.message }),
        ),
    theirs,
  );

  assert.ok("error" in tried && /isn't one of this project's/.test(tried.error), JSON.stringify(tried));
  rpc.close();

  // A click on the prompt shows its session, scrolled to the prompt.
  await cited.getByRole("button", { name: `#${asked}` }).click();
  await page.locator(`.msg.user[data-seq="${asked}"]`).waitFor();

  await page.waitForFunction((seq) => {
    const el = document.querySelector(`.msg.user[data-seq="${seq}"]`);
    const view = el?.closest(".scroller");

    if (!el || !view) return false;

    const a = el.getBoundingClientRect();
    const b = view.getBoundingClientRect();

    return a.top >= b.top && a.bottom <= b.bottom;
  }, asked);

  // Away from the latest, which is where a session opens otherwise.
  await page.getByRole("button", { name: "Jump to latest" }).waitFor();
  l.host.close();
});

/** A fake Anthropic API answering every call with `body`: the judge's model, for a daemon of a test's own. */
async function fakeAnthropic(body: Json): Promise<{ url: string; close: () => void }> {
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const address = server.address();
  assert.ok(isInet(address));

  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

test("the judge's reasons show by criterion, and a judge fail is advice a person can accept past", async () => {
  const mark = (pass: boolean, reason: string) => ({ pass, reason });

  const verdict = {
    criteria: {
      supported: mark(true, "The cited prompt asks for exactly this."),
      generalizes: mark(true, "Nothing held out contradicts it."),
      novel: mark(false, "Memory already says to run `bun test`."),
      safe: mark(true, "It weakens no safeguard."),
      checkable: mark(true, "A later journal shows which command ran."),
    },
    verdict: "fail",
    summary: "Sound, but memory already covers it.",
  };

  const model = await fakeAnthropic({
    id: "msg_judge",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "record_verdict", input: verdict }],
    stop_reason: "tool_use",
    usage: { input_tokens: 900, output_tokens: 120 },
  });

  // A daemon of its own, whose judge is the fake above with a stand-in key: the shared one's upstreams are dead.
  const own = mkdtempSync(join(tmpdir(), "strv-desk-judge-"));
  writeFileSync(join(own, "settings.json"), JSON.stringify({ judgeModel: "claude-haiku-4-5" }));

  const env = {
    ...keyless(),
    STRIVE_HOME: own,
    STRIVE_HOST: "none",
    STRIVE_UPSTREAM_ANTHROPIC: model.url,
    ANTHROPIC_API_KEY: "sk-test-judge",
  };

  execFileSync(STRIVE, ["status"], { env });

  try {
    const { app, page, cwd } = await openApp(own);
    const rpc = await Rpc.open(own);
    const work = String(resultOf(await rpc.call("session/create", { cwd })).id);
    const seq = Number(resultOf(await rpc.call("session/prompt", { id: work, text: "run the tests with bun" })).seq);
    // A session the judge can hold out.
    const held = String(resultOf(await rpc.call("session/create", { cwd })).id);
    resultOf(await rpc.call("session/prompt", { id: held, text: "fix the parser" }));
    rpc.close();
    const l = await learner(cwd, own);

    const id = await proposeMemory(l, cwd, {
      summary: "Run the tests with bun",
      text: "Run `bun test`.",
      evidence: work,
      seqs: [seq],
    });

    const pane = await openProposal(page, id);
    const judge = pane.locator("[data-gate=judge]");
    const criteria = judge.getByRole("list", { name: "criteria" });
    await criteria.locator("li").nth(4).waitFor();

    const marks = await criteria
      .locator("li")
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute("data-criterion"), e.querySelector(".mark")?.getAttribute("aria-label")]),
      );

    assert.deepEqual(marks, [
      ["supported", "passed"],
      ["generalizes", "passed"],
      ["novel", "failed"],
      ["safe", "passed"],
      ["checkable", "passed"],
    ]);

    await judge
      .locator("[data-criterion=novel] .reason", { hasText: "Memory already says to run `bun test`." })
      .waitFor();
    await judge.locator(".judge-summary", { hasText: "Sound, but memory already covers it." }).waitFor();
    await judge.locator(".judge-head", { hasText: "failed novel (claude-haiku-4-5, held out session" }).waitFor();
    await judge.locator(".badge", { hasText: "failed" }).waitFor();

    // Its fail is advice, shown at the top with the reasons, and doesn't block Accept.
    const advice = pane.locator(".learned-head .judge-advice");
    await advice.getByText("The second opinion advises against it.", { exact: false }).waitFor();
    await advice.getByText("Memory already says to run `bun test`.", { exact: false }).waitFor();
    await pane.locator(".learned-title .badge", { hasText: "ready" }).waitFor();
    await pane.getByRole("button", { name: "Accept" }).click();
    await pane.getByRole("button", { name: "Write it" }).click();
    await pane.locator(".learned-title .badge", { hasText: "applied" }).waitFor();
    assert.equal(readFileSync(memoryFile(cwd), "utf8"), `- Run \`bun test\`. <!-- strive:#${id} -->\n`);
    l.host.close();
    await app.close();
  } finally {
    execFileSync(STRIVE, ["stop"], { env });
    model.close();
    rmSync(own, { recursive: true, force: true });
  }
});

test("a proposal shows the other proposals for its file, and one is a click away", async () => {
  const { page, cwd } = await openApp();
  const l = await learner(cwd);
  const first = await proposeMemory(l, cwd, { summary: "Run the tests with bun", text: "Run `bun test`." });
  const pane = await openProposal(page, first);
  await pane.getByRole("button", { name: "Reject" }).click();
  await pane.locator(".learned-title .badge", { hasText: "rejected" }).waitFor();
  // Alone, it has no history to show.
  assert.equal(await pane.getByRole("list", { name: "proposals for this file" }).count(), 0);

  const skill = {
    change: {
      kind: "skill",
      name: "release",
      content: "---\nname: release\ndescription: How to cut a release.\n---\nTag, then push.\n",
    },
    summary: "How to release",
    rationale: "Asked twice.",
    evidence: [{ session: sessionId(cwd), seqs: [1], note: "the session began here" }],
    prediction: "Releases follow it.",
  };

  resultOf(await l.host.call("host/record", { id: l.id, event: { type: "proposalMade", proposal: skill } }));

  const second = await proposeMemory(l, cwd, {
    summary: "Run the tests with bun, in src",
    text: "`bun test src`.",
  });

  await pane.getByRole("button", { name: "all proposals" }).click();
  await pane.locator(`.learned-item[data-proposal="${second}"]`).click();
  const history = pane.getByRole("list", { name: "proposals for this file" });
  await history.locator("li").nth(1).waitFor();

  // Memory's proposals only, newest first, the one shown marked; the skill's isn't among them.
  assert.deepEqual(await history.locator("li .summary").allTextContents(), [
    "Run the tests with bun, in src",
    "Run the tests with bun",
  ]);

  assert.deepEqual(await history.locator("li .badge").allTextContents(), ["ready", "rejected"]);
  assert.equal(await history.locator("[aria-current]").textContent(), "Run the tests with bun, in src");
  await history.getByRole("button", { name: "Run the tests with bun", exact: true }).click();
  await pane.locator(`.learned-detail[data-proposal="${first}"]`).waitFor();
  l.host.close();
});

/** Resolves once `ready` holds, checking every 50ms, or fails after `ms`. */
async function until(what: string, ready: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

test("a proposal from an automatic run is badged, and says which signs started the run", async () => {
  // A daemon of its own that scans a session a second after its turn ends, with a stand-in key.
  const own = mkdtempSync(join(tmpdir(), "strv-desk-auto-"));
  writeFileSync(join(own, "settings.json"), JSON.stringify({ learning: { mode: "suggest", idleSeconds: 1 } }));
  const env = { ...keyless(), STRIVE_HOME: own, STRIVE_HOST: "none", ANTHROPIC_API_KEY: "sk-test-trigger" };
  execFileSync(STRIVE, ["status"], { env });

  try {
    const { app, page, cwd } = await openApp(own);
    const rpc = await Rpc.open(own);
    const work = String(resultOf(await rpc.call("session/create", { cwd })).id);
    const l = await learner(cwd, own);
    // A person's run first: its proposal has no badge.
    const asked = await proposeMemory(l, cwd, { summary: "Asked for", text: "One.", evidence: work });

    // The work session's host records two turns; the second prompt corrects the first.
    const host = await Rpc.open(own);
    resultOf(await host.call("host/register", { id: work }));
    let fix = 0;

    for (const [turn, text] of [
      [1, "run the tests"],
      [2, "no, use bun test"],
    ] as const) {
      fix = Number(resultOf(await rpc.call("session/prompt", { id: work, text })).seq);
      resultOf(await host.call("host/record", { id: work, event: { type: "turnStarted", turn } }));
      const ended = { type: "turnEnded", turn, reason: { kind: "done" } };
      resultOf(await host.call("host/record", { id: work, event: ended }));
    }

    await until("the automatic request", async () => {
      const read = resultOf(await rpc.call("session/read", { id: l.id }));

      return read.entries.some(
        (e: { event: { type: string; trigger?: Json } }) => e.event.type === "learnRequested" && e.event.trigger,
      );
    });

    const automatic = await proposeMemory(l, cwd, { summary: "Use bun", text: "Use bun.", evidence: work });
    const pane = await learnedPane(page);
    await pane.locator(`.learned-item[data-proposal="${automatic}"]`).waitFor();

    assert.deepEqual(
      await pane.locator(`.learned-item[data-proposal="${automatic}"] .badge.automatic`).allTextContents(),
      ["Automatic"],
    );
    assert.equal(await pane.locator(`.learned-item[data-proposal="${asked}"] .badge.automatic`).count(), 0);

    await pane.locator(`.learned-item[data-proposal="${automatic}"]`).click();
    const detail = pane.locator(`.learned-detail[data-proposal="${automatic}"]`);
    await detail.locator(".learned-title .badge.automatic").waitFor();
    const trigger = detail.locator("[data-trigger=idle]");
    await trigger.getByText(`Automatic run, after a session went idle: a correction in session ${work}.`).waitFor();
    assert.deepEqual(await trigger.locator("li").allTextContents(), [`a correction, entry ${fix}: no, use bun test`]);

    rpc.close();
    host.close();
    l.host.close();
    await app.close();
  } finally {
    execFileSync(STRIVE, ["stop"], { env });
    rmSync(own, { recursive: true, force: true });
  }
});

/**
 * A daemon of its own with a stand-in key, so it offers runs (automatic ones
 * stay off), and a window on it whose idle wait before an offer is `idleMs`;
 * stopped after `body`, pass or fail.
 */
async function withOffers(
  body: (o: Opened & { own: string; rpc: Rpc; host: Rpc; id: string }) => Promise<void>,
  idleMs = 60_000,
) {
  const own = mkdtempSync(join(tmpdir(), "strv-desk-offer-"));
  const env = { ...keyless(), STRIVE_HOME: own, STRIVE_HOST: "none", ANTHROPIC_API_KEY: "sk-test-offer" };
  execFileSync(STRIVE, ["status"], { env });

  try {
    const opened = await openApp(own, { STRIVE_DESKTOP_OFFER_IDLE_MS: String(idleMs) });
    const rpc = await Rpc.open(own);
    const { sessions } = resultOf(await rpc.call("session/list", { cwd: opened.cwd }));
    const id = String(sessions[0].id);
    const host = await Rpc.open(own);
    resultOf(await host.call("host/register", { id }));
    await body({ ...opened, own, rpc, host, id });
    rpc.close();
    host.close();
  } finally {
    execFileSync(STRIVE, ["stop"], { env });
    rmSync(own, { recursive: true, force: true });
  }
}

/** A prompt in `id` and, unless `open`, a turn that takes it and ends. */
async function exchange(o: { rpc: Rpc; host: Rpc; id: string }, turn: number, text: string, open = false) {
  resultOf(await o.rpc.call("session/prompt", { id: o.id, text }));

  if (open) return;
  resultOf(await o.host.call("host/record", { id: o.id, event: { type: "turnStarted", turn } }));
  const ended = { type: "turnEnded", turn, reason: { kind: "done" } };
  resultOf(await o.host.call("host/record", { id: o.id, event: ended }));
}

/** The project's learning session's events of `type`; none if it has no learning session. */
async function learningOf(rpc: Rpc, cwd: string, type: string): Promise<{ [key: string]: Json }[]> {
  const { sessions } = resultOf(await rpc.call("session/list", { cwd, kind: "learning" }));

  if (sessions.length === 0) return [];

  const read: { entries: { event: { [key: string]: Json } }[] } = resultOf(
    await rpc.call("session/read", { id: sessions[0].id }),
  );

  return read.entries.flatMap((e) => (e.event.type === type ? [e.event] : []));
}

test("a session with a correction is offered once it has been idle a while, and the button asks for a run", async () => {
  await withOffers(async (o) => {
    await exchange(o, 1, "run the tests");
    await exchange(o, 2, "no, use bun test");
    const offer = o.page.locator(".learn-offer");
    // Not at the turn's end: the product's idle timer (shortened for the test) makes it.
    assert.equal(await offer.count(), 0);
    await offer
      .getByText("This session had a correction. Learn from it? It costs a learner run, about $0.21.", { exact: true })
      .waitFor();
    assert.equal(await offer.getAttribute("data-session"), o.id);
    await offer.getByRole("button", { name: "Learn from this session" }).click();
    await offer.waitFor({ state: "detached" });

    await until("the run", async () => (await learningOf(o.rpc, o.cwd, "learnRequested")).length > 0);
    const asked = await learningOf(o.rpc, o.cwd, "learnRequested");
    assert.deepEqual(asked[0]?.sessions, [o.id]);
    assert.equal(asked[0]?.offer, true, "review says the run came from the offer");
  }, 1500);
});

test("closing the window offers a session with signs first, and closes once the offer is answered", async () => {
  await withOffers(async (o) => {
    await exchange(o, 1, "run the tests");
    await exchange(o, 2, "no, use bun test");
    await o.page.locator(".msg.user", { hasText: "no, use bun test" }).waitFor();
    // The minute's idle wait hasn't passed; closing doesn't wait for it.
    assert.equal(await o.page.locator(".learn-offer").count(), 0);
    const closed = o.page.waitForEvent("close");
    await o.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const offer = o.page.locator(".learn-offer");
    await offer.getByText("This session had a correction.", { exact: false }).waitFor();
    await offer.getByRole("button", { name: "Dismiss" }).click();
    await closed;
    await until("the dismissal", async () => (await learningOf(o.rpc, o.cwd, "learnDismissed")).length > 0);
  });
});

test("switching away from a session with signs offers it, and Dismiss records that without a run", async () => {
  await withOffers(async (o) => {
    await exchange(o, 1, "run the tests");
    // The correction's turn hasn't ended: nothing is offered until the window leaves it.
    await exchange(o, 2, "no, use bun test", true);
    await o.page.locator(".msg.user", { hasText: "no, use bun test" }).waitFor();
    assert.equal(await o.page.locator(".learn-offer").count(), 0);

    await o.page.getByRole("button", { name: "new session", exact: true }).click();
    await o.page.getByText("What should we work on?").waitFor();
    const offer = o.page.locator(".learn-offer");
    await offer.getByText("The session you left had a correction. Learn from it?", { exact: false }).waitFor();
    assert.equal(await offer.getAttribute("data-session"), o.id);
    await offer.getByRole("button", { name: "Dismiss" }).click();
    await offer.waitFor({ state: "detached" });

    await until("the dismissal", async () => (await learningOf(o.rpc, o.cwd, "learnDismissed")).length > 0);
    assert.deepEqual(await learningOf(o.rpc, o.cwd, "learnRequested"), []);
    assert.equal((await learningOf(o.rpc, o.cwd, "learnDismissed"))[0]?.session, o.id);
  });
});
