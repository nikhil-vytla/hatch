// strive's desktop app: the main process. It connects to the daemon as a
// person's client, opens the session, and bridges a fixed set of requests
// to the renderer, which has no Node and no direct access to the daemon.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeError, type MethodName, type Methods, type SessionInfo, StriveClient } from "@strive/protocol";
import { HistorySchema, parseJson } from "@strive/workspace";
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, session as electronSession, protocol } from "electron";
import type { Opened } from "../shared/bridge";

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

/** The workspace layout is the user's, kept with the app's own data. */
function workspaceFile(): string {
  return join(app.getPath("userData"), "workspace.json");
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
  const { session, entries } = await client.request("session/attach", { id });
  const opened: Opened = { init, session, entries, home: app.getPath("home") };

  await app.whenReady();
  serveWidgets();
  // Nothing loads from the network: the renderer is local files, and agent
  // widgets are sandboxed documents with their own policy.
  electronSession.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, cb) =>
    cb({ cancel: true }),
  );

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: `strive · ${session.cwd}`,
    backgroundColor: "#15171a",
    webPreferences: {
      preload: join(built(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const fromOurPage = (e: IpcMainInvokeEvent) =>
    e.senderFrame?.url.startsWith("file://") && e.sender === window.webContents;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());

  ipcMain.handle("strive:opened", (e) => (fromOurPage(e) ? opened : undefined));
  // The daemon parses and checks every request's params itself.
  ipcMain.handle("strive:request", async (e, method: MethodName, params: Methods[MethodName]["params"]) => {
    if (!fromOurPage(e) || !ALLOWED.has(method)) throw new Error(`${method} isn't available to the window`);

    return client.request<MethodName>(method, params);
  });

  ipcMain.handle("workspace:load", (e) => {
    if (!fromOurPage(e)) return undefined;

    try {
      const parsed = parseJson(HistorySchema, readFileSync(workspaceFile(), "utf8"));

      return parsed.ok ? parsed.value : undefined;
    } catch {
      return undefined; // none saved yet
    }
  });

  ipcMain.handle("workspace:save", (e, text: string) => {
    if (!fromOurPage(e)) return;

    // Only what parses is kept, so a bad save can't break the next start.
    const parsed = parseJson(HistorySchema, text);

    if (!parsed.ok) throw new Error(`not saved: ${parsed.error}`);
    const file = workspaceFile();
    writeFileSync(`${file}.tmp`, JSON.stringify(parsed.value));
    renameSync(`${file}.tmp`, file);
  });

  for (const method of ["session/entry", "session/delta", "session/interrupt"] as const) {
    client.on(method, (params) => {
      if (!window.isDestroyed()) window.webContents.send("strive:event", { method, params });
    });
  }

  client.onClose(() => {
    if (!window.isDestroyed()) window.webContents.send("strive:closed");
  });

  window.on("closed", () => client.close());
  await window.loadFile(join(built(), "renderer", "index.html"));
}

/** Agent widgets: pages the agent wrote, served with a policy of their own. */
const WIDGET_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

protocol.registerSchemesAsPrivileged([{ scheme: "strive-widget", privileges: { standard: true } }]);

function serveWidgets() {
  protocol.handle("strive-widget", (request) => {
    const encoded = new URL(request.url).pathname.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    const html = Buffer.from(encoded, "base64").toString("utf8");

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": WIDGET_POLICY },
    });
  });
}

app.on("window-all-closed", () => app.quit());

main().catch((e) => {
  console.error(`strive-desktop: ${describeError(e)}`);
  app.exit(1);
});
