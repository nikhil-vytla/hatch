// strive's desktop app: the main process. It connects to the daemon as a
// person's client, opens the session, and bridges a fixed set of requests
// to the renderer, which has no Node and no direct access to the daemon.
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Digest,
  describeError,
  type Event,
  type MethodName,
  type Methods,
  type SessionInfo,
  StriveClient,
} from "@strive/protocol";
import { HistorySchema, parseJson } from "@strive/workspace";
import { app, BrowserWindow, session as electronSession, type IpcMainInvokeEvent, ipcMain, protocol } from "electron";
import type { Opened, StriveEvent } from "../shared/bridge";
import { loadWorkspace, saveWorkspace } from "./store";

/** What the renderer may ask the daemon for: a person's actions on this session. */
const ALLOWED: ReadonlySet<MethodName> = new Set<MethodName>([
  "session/prompt",
  "session/interrupt",
  "session/approvals",
  "session/budget",
  "session/rewind",
  "approval/respond",
  "daemon/status",
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

  const { client, init } = await StriveClient.connect(args.socket, {
    name: "strive-desktop",
    version: app.getVersion(),
  });

  const id = await openSession(client, args);
  // Listening before attaching, and holding events until the page asks for
  // the session: anything journaled meanwhile still reaches it.
  let forward: ((event: StriveEvent) => void) | undefined;
  const early: StriveEvent[] = [];

  // The blobs the window may read: ones its own session's journal names.
  // The content store holds every session's, found by digest alone.
  const readable = new Set<Digest>();
  const deliver = (event: StriveEvent) => (forward ? forward(event) : early.push(event));
  client.on("session/entry", (params) => {
    if (params.sessionId === id) for (const d of digestsOf(params.entry.event)) readable.add(d);
    deliver({ method: "session/entry", params });
  });
  client.on("session/delta", (params) => deliver({ method: "session/delta", params }));
  client.on("session/interrupt", (params) => deliver({ method: "session/interrupt", params }));

  const { session, entries } = await client.request("session/attach", { id });

  for (const entry of entries) for (const d of digestsOf(entry.event)) readable.add(d);
  const opened: Opened = { init, session, entries, home: app.getPath("home"), platform: process.platform };

  await app.whenReady();
  serveWidgets();
  // Nothing loads from the network: the renderer is local files, and agent
  // widgets are sandboxed documents with their own policy.
  electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, cb) =>
    cb({ cancel: true }),
  );
  await refuseProxiedTraffic();

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: `strive · ${session.cwd}`,
    backgroundColor: "#141218",
    ...(process.platform === "darwin" && { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 17 } }),
    webPreferences: {
      preload: join(built(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const page = pathToFileURL(join(built(), "renderer", "index.html")).href;

  // The app's own page, in its main frame: not a widget, not a navigated frame.
  const fromOurPage = (e: IpcMainInvokeEvent) =>
    e.sender === window.webContents && e.senderFrame === window.webContents.mainFrame && e.senderFrame.url === page;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // WebRTC in every frame, nested widget frames included, may use only the
  // proxy, which refuses it (see NO_WEBRTC).
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  window.webContents.on("will-navigate", (e) => e.preventDefault());

  ipcMain.handle("strive:opened", (e) => {
    if (!fromOurPage(e)) return undefined;

    // The page listens before it asks, so what was held can go now.
    forward = (event) => {
      if (!window.isDestroyed()) window.webContents.send("strive:event", event);
    };

    for (const event of early.splice(0)) forward(event);

    return opened;
  });
  // The daemon parses and checks every request's params itself.
  ipcMain.handle("strive:request", async (e, method: MethodName, params: Methods[MethodName]["params"]) => {
    if (!fromOurPage(e) || !ALLOWED.has(method)) throw new Error(`${method} isn't available to the window`);

    // The window acts on its own session only, whatever id it sends.
    const bound = method === "daemon/status" ? params : { ...params, id: session.id };

    return client.request<MethodName>(method, bound);
  });

  ipcMain.handle("strive:blob", async (e, digest: Digest) => {
    if (!fromOurPage(e) || !readable.has(digest)) throw new Error("that output isn't this session's");

    return (await client.request("blob/get", { digest })).text;
  });

  ipcMain.handle("workspace:load", (e) => (fromOurPage(e) ? loadWorkspace(app.getPath("userData")) : undefined));

  ipcMain.handle("workspace:save", (e, text: string) => {
    if (!fromOurPage(e)) return;

    // Only what parses is kept, so a bad save can't break the next start.
    const parsed = parseJson(HistorySchema, text);

    if (!parsed.ok) throw new Error(`not saved: ${parsed.error}`);
    saveWorkspace(app.getPath("userData"), parsed.value);
  });

  client.onClose(() => {
    if (!window.isDestroyed()) window.webContents.send("strive:closed");
  });

  window.on("closed", () => client.close());
  await window.loadFile(join(built(), "renderer", "index.html"));
}

/** A TCP listener's address: a string only for a pipe, null before it listens. */
function isInet(a: AddressInfo | string | null): a is AddressInfo {
  return a !== null && typeof a === "object";
}

/** The content-store blobs an event names that the window shows: tool inputs and outputs. */
function digestsOf(event: Event): Digest[] {
  switch (event.type) {
    case "effectStarted": {
      const r = event.record;

      return r.kind === "write"
        ? [r.content]
        : r.kind === "edit"
          ? [r.oldText, r.newText]
          : r.kind === "mcp"
            ? [r.arguments]
            : [];
    }

    case "effectFinished":
      return event.outcome.kind === "done" ? [event.outcome.output] : [];
    default:
      return [];
  }
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
