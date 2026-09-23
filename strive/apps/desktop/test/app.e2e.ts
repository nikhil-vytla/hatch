// The desktop app, driven as a person would, against a real daemon. Runs
// under Node (`node --test`): Playwright's Electron driver needs it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type AddressInfo, connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";

const ROOT = resolve(import.meta.dirname, "../../..");

const STRIVE = join(ROOT, "target/debug/strive");

const APP = resolve(import.meta.dirname, "..");

const electronPath: string = createRequire(import.meta.url)("electron");

let home: string;

function strive(...args: string[]): string {
  return execFileSync(STRIVE, args, { env: { ...process.env, STRIVE_HOME: home, STRIVE_HOST: "none" } }).toString();
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

async function launch(args: string[]): Promise<ElectronApplication> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [APP, ...args],
    env: { ...process.env, STRIVE_SOCKET: join(home, "run/strived.sock") },
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

  static async open(): Promise<Rpc> {
    const socket = connect(join(home, "run/strived.sock"));
    await new Promise((ok) => socket.once("connect", ok));
    const rpc = new Rpc(socket);
    await rpc.call("initialize", { protocolVersion: 1, client: { name: "e2e", version: "0" } });

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

async function openApp(): Promise<Opened> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "strv-desk-ws-")));
  const userData = mkdtempSync(join(tmpdir(), "strv-desk-data-"));

  const app = await launch([`--user-data-dir=${userData}`, "--cwd", cwd]);

  const page = await app.firstWindow();
  await page.getByText(`Session started in ${cwd}`).waitFor();

  return { app, page, cwd, userData };
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

test("the changes pane shows what changed since the last prompt, file by file", async () => {
  const { page, cwd } = await openApp();
  writeFileSync(join(cwd, "notes.ts"), "const a = 1;\n");
  await page.getByPlaceholder("Ask strive to do anything…").fill("change things");
  await page.keyboard.press("Enter");
  await page.locator(".checkpoints li").first().waitFor();
  writeFileSync(join(cwd, "notes.ts"), "const a = 2;\n");
  writeFileSync(join(cwd, "new.txt"), "hello\n");
  await page.getByRole("button", { name: "changes", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "changes" });
  await pane.getByText("2 changed files").waitFor();
  assert.deepEqual(await pane.locator(".file-head .path").allTextContents(), ["new.txt", "notes.ts"]);
  const notes = pane.locator(".file", { hasText: "notes.ts" });
  assert.equal(await notes.locator(".row.remove").textContent(), "1−const a = 1;");
  assert.equal(await notes.locator(".row.add").textContent(), "1+const a = 2;");
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
  await page.locator(".checkpoints li", { hasText: "before “first”" }).waitFor();
  writeFileSync(join(cwd, "notes.txt"), "v2");
  await page.locator(".checkpoints li", { hasText: "before “first”" }).getByRole("button", { name: "Rewind" }).click();
  await page.getByText("Rewound to checkpoint 1.").waitFor();
  assert.equal(readFileSync(join(cwd, "notes.txt"), "utf8"), "v1");
  await app.close();
});

test("a panel dragged to another column stays there, and is saved", async () => {
  const { app, page, userData } = await openApp();
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
      "loadWorkspace",
      "onClosed",
      "onEvent",
      "opened",
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
  const host = await propose(first.cwd, "drop spend", [{ op: "remove", panel: "spend" }]);
  await first.page.getByText("The agent proposes: drop spend").waitFor();
  await first.page.getByRole("button", { name: "Reject" }).click();
  await first.page.getByText("The agent proposes: drop spend").waitFor({ state: "detached" });
  host.close();
  await first.app.close();

  const again = await launch([`--user-data-dir=${first.userData}`, "--cwd", first.cwd, "--continue"]);

  const page = await again.firstWindow();
  await page.getByText("The agent proposed a layout change: drop spend").waitFor();
  assert.equal(await page.getByText("The agent proposes: drop spend").count(), 0);
  assert.equal(await page.locator('[data-panel="spend"]').count(), 1);
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
  // B still offers it, but a save from B (a drag) must not undo A's rejection.
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
