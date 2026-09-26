// strive's desktop app: the main process. It connects to the daemon as a
// person's client, opens the session, and bridges a fixed set of requests
// to the renderer, which has no Node and no direct access to the daemon.
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Digest,
  describeError,
  type MethodName,
  type Methods,
  type SessionInfo,
  type StriveClient,
} from "@strive/protocol";
import { HistorySchema, parseJson } from "@strive/workspace";
import {
  app,
  BrowserWindow,
  session as electronSession,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  protocol,
} from "electron";
import type { StriveEvent } from "../shared/bridge";
import { type Cited, cut, OUTPUT_LIMIT, outputsOf, pick } from "../shared/cited";
import { Connection } from "./connection";
import { Learning } from "./learning";
import { learnedNotice, type Notice, noticeFor } from "./notify";
import { loadWorkspace, saveWorkspace } from "./store";

/** What the renderer may ask the daemon for: a person's actions on this session. */
const ALLOWED: ReadonlySet<MethodName> = new Set<MethodName>([
  "session/prompt",
  "session/interrupt",
  "session/approvals",
  "session/budget",
  "session/rewind",
  "session/changes",
  "session/model",
  "approval/respond",
  "daemon/status",
  "model/list",
  "auth/status",
  "proposal/list",
  "proposal/decide",
  "proposal/rollback",
  "learning/run",
]);

/** Allowed requests that aren't about a session: read-only facts about the daemon. */
const UNBOUND: ReadonlySet<MethodName> = new Set<MethodName>(["daemon/status", "model/list", "auth/status"]);

/** Allowed requests about the window's project rather than its session: learning, and what it proposed. */
const PROJECT: ReadonlySet<MethodName> = new Set<MethodName>([
  "proposal/list",
  "proposal/decide",
  "proposal/rollback",
  "learning/run",
]);

type Mode = { kind: "new" } | { kind: "continue" } | { kind: "resume"; id: string };

type Args = { socket: string; cwd: string; mode: Mode };

type Parsed = { ok: true; args: Args } | { ok: false; error: string };

function parseArgs(argv: string[]): Parsed {
  const socket = process.env.STRIVE_SOCKET;

  if (!socket) return { ok: false, error: "strive-desktop is started by `strive app`; run that instead." };

  const flag = (name: string) => {
    const i = argv.indexOf(name);

    return i >= 0 ? argv[i + 1] : undefined;
  };

  const resume = flag("--resume");

  const mode: Mode = resume
    ? { kind: "resume", id: resume }
    : { kind: argv.includes("--continue") ? "continue" : "new" };

  return { ok: true, args: { socket, cwd: flag("--cwd") ?? process.cwd(), mode } };
}

async function openSession(client: StriveClient, args: Args): Promise<SessionInfo["id"]> {
  if (args.mode.kind === "resume") return args.mode.id;

  if (args.mode.kind === "continue") {
    const { sessions } = await client.request("session/list", { cwd: args.cwd });

    if (sessions[0]) return sessions[0].id;
  }

  return (await client.request("session/create", { cwd: args.cwd })).id;
}

/** Where the build put the preload script and renderer (bundling fixes `__dirname` at the source). */
function built(): string {
  return join(app.getAppPath(), "out");
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (!parsed.ok) {
    console.error(parsed.error);
    app.exit(2);

    return;
  }

  const { args } = parsed;

  const open = (pick: (c: StriveClient) => Promise<string>) =>
    Connection.open(args.socket, app.getVersion(), app.getPath("home"), pick);

  let current = await open((c) => openSession(c, args));
  // The window's project: it lists, and switches between, sessions started here only.
  const cwd = current.snapshot.session.cwd;

  await app.whenReady();
  // Tests and screenshot runs drive the window over CDP, which needs no OS
  // focus: in the background it opens behind what the person is doing, with
  // no Dock icon or menu bar, and never takes the keyboard.
  const background = process.env.STRIVE_DESKTOP_BACKGROUND === "1";

  if (background && process.platform === "darwin") app.setActivationPolicy("accessory");
  serveWidgets();
  // Nothing loads from the network: the renderer is local files, and agent
  // widgets are sandboxed documents with their own policy.
  electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, cb) =>
    cb({ cancel: true }),
  );
  await refuseProxiedTraffic();
  // No name lookups at all: the app needs none, and a lookup is itself a way
  // out (WebRTC resolves a TURN server's hostname before any proxy is
  // involved, so data could ride in the name). Secure DNS through a server
  // that isn't there makes every lookup fail without sending anything.
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: "secure",
    secureDnsServers: ["https://127.0.0.1:9/dns-query"],
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: `strive · ${cwd}`,
    backgroundColor: "#0b0b0c",
    show: !background,
    ...(process.platform === "darwin" && { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 17 } }),
    webPreferences: {
      preload: join(built(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Behind other windows a page is otherwise throttled, and runs slow.
      backgroundThrottling: !background,
    },
  });

  if (background) window.showInactive();

  const page = pathToFileURL(join(built(), "renderer", "index.html")).href;

  // The app's own page, in its main frame: not a widget, not a navigated frame.
  const fromOurPage = (e: IpcMainInvokeEvent) =>
    e.sender === window.webContents && e.senderFrame === window.webContents.mainFrame && e.senderFrame.url === page;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // WebRTC in every frame, nested widget frames included, may use only the
  // proxy, which refuses it (see NO_WEBRTC).
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.on("will-navigate", (e) => e.preventDefault());

  const send = (event: StriveEvent) => {
    if (!window.isDestroyed()) window.webContents.send("strive:event", event);
  };

  // A person not looking at the window hears when the agent needs them or stops, and when the learner has proposals.
  const notify = (notice: Notice | undefined) => {
    // In the background the window is never focused: no notices then, or
    // every test would post them to the person's screen.
    if (!notice || background || window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return;

    const note = new Notification({ title: notice.title, body: notice.body });
    note.on("click", () => {
      window.show();
      window.focus();
    });
    note.show();
  };

  const watch = (c: Connection) => {
    c.onLost(() => {
      if (!window.isDestroyed() && c === current) window.webContents.send("strive:closed");
    });
    c.onEntry = (entry) => notify(noticeFor(entry.event, sessionName(c)));
  };

  watch(current);

  const learning = new Learning(args.socket, app.getVersion(), cwd, (entry, seen) => {
    if (!window.isDestroyed()) window.webContents.send("strive:learning-entry", entry);
    notify(learnedNotice(seen, entry, basename(cwd)));
  });

  // Followed from the start if the project has a learning session, so a run started elsewhere is heard too.
  learning
    .follow()
    .catch((e) => console.error(`strive-desktop: can't follow the learning session: ${describeError(e)}`));

  ipcMain.handle("strive:opened", (e) => {
    if (!fromOurPage(e)) return undefined;

    // The page listens before it asks, so what was held can go now.
    current.attachPage(send);

    return current.snapshot;
  });

  ipcMain.handle("strive:sessions", async (e) => {
    if (!fromOurPage(e)) return [];

    return (await current.client.request("session/list", { cwd })).sessions;
  });

  // To another session of this project, or a new one (no id).
  ipcMain.handle("strive:switch", async (e, target: string | undefined) => {
    if (!fromOurPage(e)) throw new Error("not available to this frame");

    // Anything but one of this project's session ids (whatever the page sent) is refused here.
    if (target !== undefined) {
      const { sessions } = await current.client.request("session/list", { cwd });

      if (!sessions.some((s) => s.id === target)) throw new Error("that session isn't one of this project's");
    }

    const next = await open(async (c) => target ?? (await c.request("session/create", { cwd })).id);
    const left = current;
    current = next;
    watch(next);
    left.close();
    next.attachPage(send);

    return next.snapshot;
  });

  // The daemon parses and checks every request's params itself.
  ipcMain.handle("strive:request", async (e, method: MethodName, params: Methods[MethodName]["params"]) => {
    if (!fromOurPage(e) || !ALLOWED.has(method)) throw new Error(`${method} isn't available to the window`);

    // The window acts on the session it shows, and its project, only, whatever id or directory it sends.
    const bound = UNBOUND.has(method)
      ? params
      : PROJECT.has(method)
        ? { ...params, cwd }
        : { ...params, id: current.id };

    // The daemon's own words reach the page, not the client's wrapping of them.
    const result = await current.client.request<MethodName>(method, bound).catch((err: Error) => {
      throw new Error(describeError(err));
    });

    // A run, a person's or the daemon's own, may have made the project's learning session: follow it from here.
    if (method === "learning/run" || method === "proposal/list") await learning.follow();

    return result;
  });

  ipcMain.handle("strive:blob", async (e, digest: Digest) => {
    if (!fromOurPage(e) || !current.readable.has(digest)) throw new Error("that output isn't this session's");

    return (await current.client.request("blob/get", { digest })).text;
  });

  ipcMain.handle("strive:learning", (e) => {
    if (!fromOurPage(e)) throw new Error("not available to this frame");

    return learning.read();
  });

  // A proposal's "before" by its id among this project's proposals: blob/get stays limited to the shown session's digests.
  ipcMain.handle("strive:proposal-before", async (e, proposal: number) => {
    if (!fromOurPage(e)) throw new Error("not available to this frame");

    const { proposals } = await current.client.request("proposal/list", { cwd });
    const found = proposals.find((p) => p.id === proposal);

    if (!found) throw new Error(`there's no proposal #${proposal} for ${cwd}`);

    return found.before === undefined
      ? null
      : (await current.client.request("blob/get", { digest: found.before })).text;
  });

  // The entries a proposal's evidence cites, from one of this project's sessions only, with their outputs.
  // Whatever the page sends: the session must be one the project lists, and seqs only select among its entries.
  ipcMain.handle("strive:cited", async (e, session: string, seqs: number[]): Promise<Cited> => {
    if (!fromOurPage(e)) throw new Error("not available to this frame");

    const { sessions } = await current.client.request("session/list", { cwd });

    if (!sessions.some((s) => s.id === session)) throw new Error("that session isn't one of this project's");

    const { entries } = await current.client.request("session/read", { id: session });
    const picked = pick(entries, seqs);
    const outputs: Cited["outputs"] = {};

    for (const digest of new Set(outputsOf(picked))) {
      // An output that's gone from the store is shown as missing, not as a failure of the whole read.
      const text = await current.client.request("blob/get", { digest }).then(
        (r) => r.text,
        () => undefined,
      );

      if (text !== undefined) outputs[digest] = cut(text, OUTPUT_LIMIT);
    }

    return { entries: picked, outputs };
  });

  ipcMain.handle("workspace:load", (e) => (fromOurPage(e) ? loadWorkspace(app.getPath("userData")) : undefined));

  ipcMain.handle("workspace:save", (e, text: string) => {
    if (!fromOurPage(e)) return;

    // Only what parses is kept, so a bad save can't break the next start.
    const parsed = parseJson(HistorySchema, text);

    if (!parsed.ok) throw new Error(`not saved: ${parsed.error}`);
    saveWorkspace(app.getPath("userData"), parsed.value);
  });

  window.on("closed", () => {
    current.close();
    learning.close();
  });
  await window.loadFile(join(built(), "renderer", "index.html"));
}

/** What a notice calls a session: its first prompt, or its directory. */
function sessionName(c: Connection): string {
  const first = c.snapshot.entries.find((e) => e.event.type === "userMessage")?.event;
  const text = first?.type === "userMessage" ? first.text : (c.snapshot.session.cwd.split("/").at(-1) ?? "strive");

  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** A TCP listener's address: a string only for a pipe, null before it listens. */
function isInet(a: AddressInfo | string | null): a is AddressInfo {
  return a !== null && typeof a === "object";
}

/**
 * Points the window's traffic at a proxy of our own that closes every
 * connection. Requests are cancelled before they get there; this is for what
 * webRequest doesn't see, WebRTC's TCP. Loopback goes through it too, not
 * around it as Chromium's default would.
 */
async function refuseProxiedTraffic(): Promise<void> {
  const refuser = createServer((c) => c.destroy());
  await new Promise<void>((ok) => refuser.listen(0, "127.0.0.1", ok));
  refuser.unref();
  const address = refuser.address();

  if (!isInet(address)) throw new Error("the refusing proxy has no port");
  await electronSession.defaultSession.setProxy({
    proxyRules: `http://127.0.0.1:${address.port}`,
    proxyBypassRules: "<-loopback>",
  });
}

/** Agent widgets: pages the agent wrote, served with a policy of their own. */
const WIDGET_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; webrtc 'block'";

protocol.registerSchemesAsPrivileged([{ scheme: "strive-widget", privileges: { standard: true } }]);

/**
 * CSP doesn't stop WebRTC, and a peer connection is a way out: a STUN (UDP)
 * or TURN (TCP) server named in a widget carries data to it. What stops it,
 * in every frame, is the window's WebRTC policy: no UDP except through a
 * proxy, and TCP only through the proxy, which refuses everything. Removing
 * WebRTC from the widget page is a second layer; it can't reach a srcdoc
 * frame the widget makes, which gets a fresh realm. The e2e test tries all
 * three ways, over UDP and TCP, against listeners of their own.
 */
const NO_WEBRTC = `<script>for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"])
  Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false });</script>`;

function serveWidgets() {
  protocol.handle("strive-widget", (request) => {
    const encoded = new URL(request.url).pathname.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    const html = Buffer.from(encoded, "base64").toString("utf8");

    return new Response(NO_WEBRTC + html, {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": WIDGET_POLICY },
    });
  });
}

app.on("window-all-closed", () => app.quit());

main().catch((e) => {
  console.error(`strive-desktop: ${describeError(e)}`);
  app.exit(1);
});
