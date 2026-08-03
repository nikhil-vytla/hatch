import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { access } from "node:fs/promises";
import { GitSandboxManager, type GitAuthor } from "../sandbox/git-sandbox.js";
import { OpenCodeBridge } from "../agent/opencode-bridge.js";
import { listModels, resolveModel } from "../agent/models.js";
import { createMemoryEventBus } from "../control/event-bus.js";
import { SessionQueues } from "../control/session-queues.js";
import { ResourceLifecycle } from "../control/resource-lifecycle.js";
import type { SessionEventEnvelope } from "../session/index.js";
import { brandNumber, brandString } from "../kernel/index.js";

export type SessionRow = {
  id: string;
  title: string;
  sandboxId: string;
  repoDir: string;
  branch: string;
  opencodeSessionId: string | null;
  author: GitAuthor;
  createdAt: number;
  lastActiveAt: number;
  status: "idle" | "running" | "error";
  lastError?: string;
  /** Soft archive: hidden from default list, disk kept, prompts rejected until restore. */
  archivedAt: number | null;
  /** Set when created via POST .../fork. */
  parentSessionId: string | null;
};

export type ControlPlaneOptions = {
  readonly rootDir?: string;
  readonly port?: number;
  readonly host?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly sessionTtlMs?: number;
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export async function startControlPlane(opts: ControlPlaneOptions = {}) {
  const rootDir = opts.rootDir ?? path.join("/tmp", "hatch-inspect");
  const sandboxes = new GitSandboxManager(path.join(rootDir, "sandboxes"));
  await sandboxes.ensureBase();

  const model = resolveModel(opts.modelId ?? process.env.OPENCODE_MODEL, opts.modelProvider ?? process.env.OPENCODE_PROVIDER);
  const bridge = new OpenCodeBridge({ model });
  await bridge.start();

  const sessions = new Map<string, SessionRow>();
  const bus = createMemoryEventBus();
  const queues = new SessionQueues();
  const lifecycle = new ResourceLifecycle(sandboxes, {
    ttlMs: opts.sessionTtlMs ?? 30 * 60_000,
  });
  const reapTimer = setInterval(() => {
    void lifecycle.reap(sessions);
  }, 60_000);
  reapTimer.unref?.();

  let seq = 0;

  function emit(
    sessionId: string,
    origin: SessionEventEnvelope["origin"],
    event: SessionEventEnvelope["event"],
  ) {
    seq += 1;
    const envelope: SessionEventEnvelope = {
      seq: brandNumber<"EventSeq">(seq),
      at: brandNumber<"Timestamp">(Date.now()),
      origin,
      event,
    };
    bus.publish(brandString<"SessionId">(sessionId), envelope);
    return envelope;
  }

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      sessions: sessions.size,
      service: "@hatch/inspect",
      model,
    }),
  );

  app.get("/api/models", (c) => c.json({ models: listModels(), selected: model }));

  app.get("/api/sessions", (c) => {
    const includeArchived = c.req.query("include") === "archived";
    const rows = [...sessions.values()].filter((s) => includeArchived || !s.archivedAt);
    rows.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return c.json({
      sessions: rows.map((s) => ({
        id: s.id,
        title: s.title,
        branch: s.branch,
        status: s.status,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        archivedAt: s.archivedAt,
        parentSessionId: s.parentSessionId,
        lastError: s.lastError ?? null,
      })),
    });
  });

  app.post("/api/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      cloneUrl?: string;
      authorName?: string;
      authorEmail?: string;
      prompt?: string;
    };
    const author: GitAuthor = {
      name: body.authorName ?? "Inspect User",
      email: body.authorEmail ?? "user@localhost",
    };
    const sandbox = await sandboxes.create({
      ...(body.cloneUrl ? { cloneUrl: body.cloneUrl } : {}),
      ...(!body.cloneUrl
        ? {
            seedFiles: {
              "README.md": "# Hatch Inspect sandbox\n\nTell the agent what to build.\n",
              "src/index.ts":
                'export function greet(name: string) {\n  return `hello ${name}`;\n}\n',
            },
          }
        : {}),
    });
    await sandboxes.setAuthor(sandbox.repoDir, author);
    const ocSession = await bridge.createSession(sandbox.repoDir);
    const row: SessionRow = {
      id: id("ses"),
      title: body.title ?? body.prompt?.slice(0, 72) ?? "Untitled session",
      sandboxId: sandbox.id,
      repoDir: sandbox.repoDir,
      branch: sandbox.branch,
      opencodeSessionId: ocSession,
      author,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status: "idle",
      archivedAt: null,
      parentSessionId: null,
    };
    sessions.set(row.id, row);
    emit(row.id, "system", {
      kind: "session.started",
      repo: { owner: "local", name: sandbox.id },
      by: {
        id: brandString<"ActorId">(author.email),
        display: author.name,
        github: null,
      },
    });

    if (body.prompt) {
      void queues.enqueue(row.id, () => runPrompt(row.id, body.prompt!));
    }
    return c.json({
      id: row.id,
      branch: row.branch,
      repoDir: row.repoDir,
      status: row.status,
    });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const row = sessions.get(c.req.param("id") ?? "");
    if (!row) return c.json({ error: "not found" }, 404);
    await queues.drain(row.id);
    const sandboxId = row.sandboxId;
    await lifecycle.destroy(row, sessions);
    let gone = false;
    try {
      await access(path.join(rootDir, "sandboxes", sandboxId));
    } catch {
      gone = true;
    }
    return c.json({ ok: true, destroyed: sandboxId, diskGone: gone });
  });

  app.post("/api/sessions/:id/archive", async (c) => {
    const row = sessions.get(c.req.param("id") ?? "");
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status === "running") return c.json({ error: "session running" }, 409);
    row.archivedAt = Date.now();
    lifecycle.touch(row);
    emit(row.id, "system", { kind: "session.closed", reason: "archived" });
    return c.json({ ok: true, id: row.id, archivedAt: row.archivedAt });
  });

  app.post("/api/sessions/:id/restore", async (c) => {
    const row = sessions.get(c.req.param("id") ?? "");
    if (!row) return c.json({ error: "not found" }, 404);
    row.archivedAt = null;
    lifecycle.touch(row);
    return c.json({ ok: true, id: row.id, archivedAt: null });
  });

  app.post("/api/sessions/:id/fork", async (c) => {
    const parent = sessions.get(c.req.param("id") ?? "");
    if (!parent) return c.json({ error: "not found" }, 404);
    if (parent.archivedAt) return c.json({ error: "archived; restore first" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      prompt?: string;
      commitDirty?: boolean;
    };
    if (body.commitDirty !== false) {
      const dirty = await sandboxes.status(parent.repoDir);
      if (dirty) {
        await sandboxes.commitAll(
          parent.repoDir,
          "inspect: snapshot before fork",
          parent.author,
        );
      }
    }
    const sandbox = await sandboxes.forkFrom({ sourceRepoDir: parent.repoDir });
    await sandboxes.setAuthor(sandbox.repoDir, parent.author);
    const ocSession = await bridge.createSession(sandbox.repoDir);
    const row: SessionRow = {
      id: id("ses"),
      title: body.title ?? `Fork of ${parent.title}`.slice(0, 72),
      sandboxId: sandbox.id,
      repoDir: sandbox.repoDir,
      branch: sandbox.branch,
      opencodeSessionId: ocSession,
      author: parent.author,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status: "idle",
      archivedAt: null,
      parentSessionId: parent.id,
    };
    sessions.set(row.id, row);
    emit(row.id, "system", {
      kind: "session.started",
      repo: { owner: "local", name: sandbox.id },
      by: {
        id: brandString<"ActorId">(parent.author.email),
        display: parent.author.name,
        github: null,
      },
    });
    if (body.prompt) {
      void queues.enqueue(row.id, () => runPrompt(row.id, body.prompt!));
    }
    return c.json({
      id: row.id,
      branch: row.branch,
      repoDir: row.repoDir,
      status: row.status,
      parentSessionId: parent.id,
    });
  });

  app.get("/api/sessions/:id", async (c) => {
    const row = sessions.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const status = await sandboxes.status(row.repoDir);
    const diff = await sandboxes.diff(row.repoDir);
    return c.json({ ...row, gitStatus: status, diff });
  });

  app.post("/api/sessions/:id/prompt", async (c) => {
    const row = sessions.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.archivedAt) return c.json({ error: "archived; restore first" }, 409);
    const body = (await c.req.json()) as { text?: string };
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    void queues.enqueue(row.id, () => runPrompt(row.id, body.text!.trim()));
    return c.json({ ok: true, status: "queued" });
  });

  app.post("/api/sessions/:id/commit", async (c) => {
    const row = sessions.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    const sha = await sandboxes.commitAll(
      row.repoDir,
      body.message ?? `inspect: ${row.title}`,
      row.author,
    );
    emit(row.id, "sandbox", {
      kind: "git.pushed",
      branch: brandString<"BranchName">(row.branch),
      head: brandString<"CommitSha">(sha),
    });
    return c.json({ sha, branch: row.branch });
  });

  app.get(
    "/api/sessions/:id/events",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id") ?? "";
      return {
        onOpen(_evt, ws) {
          const unsub = bus.subscribe(brandString<"SessionId">(sessionId), (envelope) => {
            ws.send(JSON.stringify(envelope));
          });
          (ws as unknown as { __unsub?: () => void }).__unsub = unsub;
          ws.send(JSON.stringify({ type: "hello", sessionId }));
        },
        onClose(_evt, ws) {
          const u = (ws as unknown as { __unsub?: () => void }).__unsub;
          u?.();
        },
      };
    }),
  );

  // Static web UI
  app.get("/", (c) => c.html(webUiHtml()));
  app.get("/ui", (c) => c.html(webUiHtml()));

  async function runPrompt(sessionId: string, text: string) {
    const row = sessions.get(sessionId);
    if (!row || !row.opencodeSessionId || row.archivedAt) return;
    row.status = "running";
    lifecycle.touch(row);
    const turnId = brandString<"TurnId">(id("trn"));
    emit(sessionId, "user", {
      kind: "turn.queued",
      turn: {
        id: turnId,
        author: {
          id: brandString<"ActorId">(row.author.email),
          display: row.author.name,
          github: null,
        },
        text,
        state: { kind: "queued" },
      },
    });
    emit(sessionId, "system", { kind: "turn.started", turnId });

    try {
      let summary = "";
      for await (const delta of bridge.runPrompt({
        sessionId: row.opencodeSessionId,
        directory: row.repoDir,
        text,
      })) {
        if (delta.kind === "text") {
          summary += delta.text;
          emit(sessionId, "agent", {
            kind: "agent.delta",
            turnId,
            text: delta.text,
          });
        } else if (delta.kind === "tool") {
          emit(sessionId, "agent", {
            kind: "agent.delta",
            turnId,
            text: `\n[tool:${delta.name} ${delta.status}]\n`,
          });
        } else if (delta.kind === "error") {
          row.status = "error";
          row.lastError = delta.message;
          lifecycle.touch(row);
          emit(sessionId, "system", {
            kind: "turn.finished",
            turnId,
            summary: `error: ${delta.message}`,
          });
          return;
        } else if (delta.kind === "idle") {
          break;
        }
      }
      row.status = "idle";
      lifecycle.touch(row);
      const gitStatus = await sandboxes.status(row.repoDir);
      emit(sessionId, "agent", {
        kind: "turn.finished",
        turnId,
        summary: summary.slice(0, 500) || (gitStatus ? "done (dirty tree)" : "done"),
      });
    } catch (e) {
      row.status = "error";
      row.lastError = e instanceof Error ? e.message : String(e);
      lifecycle.touch(row);
      emit(sessionId, "system", {
        kind: "turn.finished",
        turnId,
        summary: `error: ${row.lastError}`,
      });
    }
  }

  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  return {
    app,
    server,
    port,
    host,
    sessions,
    sandboxes,
    bridge,
    bus,
    async close() {
      clearInterval(reapTimer);
      for (const session of [...sessions.values()]) {
        await queues.drain(session.id);
        await lifecycle.destroy(session, sessions);
      }
      await bridge.close();
      server.close();
    },
  };
}

function webUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hatch Inspect</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg0: #0f1410;
      --bg1: #1a221c;
      --ink: #e8f0e9;
      --muted: #9bb09e;
      --accent: #c4f542;
      --line: #2c3a30;
      --danger: #ff6b6b;
      --agent: #121814;
      --code: #080b09;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font-family: "IBM Plex Sans", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, #243528 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #1e2a40 0%, transparent 50%),
        var(--bg0);
    }
    header {
      padding: 28px 32px 12px;
      border-bottom: 1px solid var(--line);
    }
    header h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: -0.02em;
    }
    header p { margin: 8px 0 0; color: var(--muted); max-width: 60ch; }
    main {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 0;
      min-height: calc(100vh - 110px);
    }
    aside, section { padding: 20px 24px; }
    aside { border-right: 1px solid var(--line); background: color-mix(in oklab, var(--bg1) 80%, transparent); }
    label { display:block; font-size: 12px; color: var(--muted); margin: 12px 0 6px; text-transform: uppercase; letter-spacing: 0.06em; }
    textarea, input, button {
      width: 100%;
      font: inherit;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--bg0);
      color: var(--ink);
      padding: 10px 12px;
    }
    textarea { min-height: 120px; resize: vertical; font-family: "IBM Plex Mono", monospace; font-size: 13px; }
    button {
      margin-top: 14px;
      background: var(--accent);
      color: #111;
      font-weight: 600;
      border: none;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:disabled { opacity: 0.5; cursor: wait; }
    .meta { font-family: "IBM Plex Mono", monospace; font-size: 12px; color: var(--muted); margin-top: 14px; white-space: pre-wrap; }
    #log {
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #0b0f0c;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      height: calc(100vh - 170px);
      overflow: auto;
    }
    #log:empty::before { content: "Waiting…"; color: var(--muted); font-family: "IBM Plex Mono", monospace; font-size: 12.5px; }
    .entry-sys {
      color: var(--muted);
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      line-height: 1.4;
    }
    .entry-turn {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .entry-turn .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--line);
      flex: 0 0 auto;
    }
    .entry-turn.running .dot { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 25%, transparent); }
    .entry-turn.done .dot { background: #5a8f66; }
    .entry-turn.err { color: var(--danger); }
    .entry-turn.err .dot { background: var(--danger); }
    .entry-agent {
      background: var(--agent);
      border-left: 3px solid var(--accent);
      padding: 12px 14px;
      border-radius: 0 10px 10px 0;
      font-size: 13.5px;
      line-height: 1.5;
    }
    .entry-agent .md-text { white-space: pre-wrap; word-break: break-word; }
    .entry-agent code {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12.5px;
      background: color-mix(in oklab, var(--code) 80%, #1a2a1c);
      padding: 1px 5px;
      border-radius: 4px;
    }
    .entry-agent pre {
      margin: 10px 0 0;
      padding: 12px 14px;
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow-x: auto;
    }
    .entry-agent pre code {
      background: none;
      padding: 0;
      font-size: 12.5px;
      line-height: 1.45;
      color: #d7e6d9;
      white-space: pre;
    }
    .entry-agent .lang {
      display: block;
      font-family: "IBM Plex Mono", monospace;
      font-size: 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .entry-tool {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      color: #b7c9a0;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: color-mix(in oklab, var(--bg1) 70%, transparent);
    }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 11px;
      color: var(--muted);
      margin-right: 6px;
    }
    .pill.live { border-color: var(--accent); color: var(--accent); }
    .session-list {
      list-style: none; margin: 14px 0 0; padding: 0;
      max-height: 220px; overflow: auto;
      border: 1px solid var(--line); border-radius: 10px;
    }
    .session-list li {
      display: grid;
      grid-template-columns: 8px 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
      font-size: 12.5px;
    }
    .session-list li:last-child { border-bottom: none; }
    .session-list li:hover { background: color-mix(in oklab, var(--bg0) 55%, transparent); }
    .session-list li.active { background: color-mix(in oklab, var(--accent) 12%, transparent); }
    .session-list li.archived { opacity: 0.55; }
    .session-list .st {
      width: 8px; height: 8px; border-radius: 50%; margin-top: 5px;
      background: var(--line);
    }
    .session-list .st.idle { background: #5a8f66; }
    .session-list .st.running { background: var(--accent); }
    .session-list .st.error { background: var(--danger); }
    .session-list .title {
      font-weight: 600; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .session-list .sub {
      color: var(--muted); font-family: "IBM Plex Mono", monospace; font-size: 10.5px;
      margin-top: 2px;
    }
    .session-list .badge {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 0.04em; margin-top: 4px;
    }
    .row-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .row-actions button { margin-top: 8px; }
    .show-archived {
      display: flex; align-items: center; gap: 8px;
      margin-top: 8px; color: var(--muted); font-size: 12px;
    }
    .show-archived input { width: auto; }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: none; border-bottom: 1px solid var(--line); }
      #log { height: 55vh; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Hatch Inspect</h1>
    <p>Local background coding agent. Real git sandbox + OpenCode free models. Inspired by Ramp Inspect / Open-Inspect, not a clone.</p>
  </header>
  <main>
    <aside>
      <div><span class="pill" id="health">…</span><span class="pill" id="sesspill">no session</span></div>
      <label>Sessions</label>
      <ul class="session-list" id="sessionList"></ul>
      <label class="show-archived"><input type="checkbox" id="showArchived" /> Show archived</label>
      <label>Prompt</label>
      <textarea id="prompt">Add a function called add in src/math.ts that returns the sum of two numbers, and export it. Keep it TypeScript.</textarea>
      <button id="start">Start session + run</button>
      <button class="secondary" id="follow" disabled>Send follow-up</button>
      <button class="secondary" id="commit" disabled>Commit changes</button>
      <div class="row-actions">
        <button class="secondary" id="fork" disabled>Fork</button>
        <button class="secondary" id="archive" disabled>Archive</button>
        <button class="secondary" id="restore" disabled>Restore</button>
        <button class="secondary" id="destroy" disabled>Delete</button>
      </div>
      <div class="meta" id="meta"></div>
    </aside>
    <section>
      <div id="log"></div>
    </section>
  </main>
  <script>
    const logEl = document.getElementById('log');
    const meta = document.getElementById('meta');
    const health = document.getElementById('health');
    const sesspill = document.getElementById('sesspill');
    const sessionList = document.getElementById('sessionList');
    const showArchived = document.getElementById('showArchived');
    let sessionId = null;
    let sessionMeta = null;
    let ws = null;
    let agentBuf = '';
    let agentEl = null;

    function setActionsEnabled(on) {
      document.getElementById('follow').disabled = !on;
      document.getElementById('commit').disabled = !on;
      document.getElementById('fork').disabled = !on;
      document.getElementById('archive').disabled = !on;
      document.getElementById('restore').disabled = !on;
      document.getElementById('destroy').disabled = !on;
      if (on && sessionMeta && sessionMeta.archivedAt) {
        document.getElementById('follow').disabled = true;
        document.getElementById('commit').disabled = true;
        document.getElementById('fork').disabled = true;
        document.getElementById('archive').disabled = true;
        document.getElementById('restore').disabled = false;
      } else if (on) {
        document.getElementById('restore').disabled = true;
      }
    }

    function scrollLog() {
      logEl.scrollTop = logEl.scrollHeight;
    }

    function clearLog() {
      logEl.replaceChildren();
      agentBuf = '';
      agentEl = null;
    }

    function note(text) {
      const d = document.createElement('div');
      d.className = 'entry-sys';
      d.textContent = text;
      logEl.appendChild(d);
      scrollLog();
    }

    function turnMarker(label, state) {
      const d = document.createElement('div');
      d.className = 'entry-turn' + (state ? ' ' + state : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      d.appendChild(dot);
      d.appendChild(document.createTextNode(label));
      logEl.appendChild(d);
      scrollLog();
    }

    function renderInline(text) {
      const wrap = document.createElement('span');
      wrap.className = 'md-text';
      const parts = text.split(/\`([^\`]+)\`/);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          const c = document.createElement('code');
          c.textContent = parts[i];
          wrap.appendChild(c);
        } else if (parts[i]) {
          wrap.appendChild(document.createTextNode(parts[i]));
        }
      }
      return wrap;
    }

    function renderRich(text) {
      const root = document.createDocumentFragment();
      const fence = /\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g;
      let last = 0;
      let m;
      while ((m = fence.exec(text))) {
        if (m.index > last) root.appendChild(renderInline(text.slice(last, m.index)));
        const pre = document.createElement('pre');
        if (m[1]) {
          const lang = document.createElement('span');
          lang.className = 'lang';
          lang.textContent = m[1];
          pre.appendChild(lang);
        }
        const code = document.createElement('code');
        code.textContent = m[2].replace(/\\n$/, '');
        pre.appendChild(code);
        root.appendChild(pre);
        last = m.index + m[0].length;
      }
      if (last < text.length) root.appendChild(renderInline(text.slice(last)));
      return root;
    }

    function flushAgent() {
      agentEl = null;
      agentBuf = '';
    }

    function onAgentDelta(text) {
      const tool = text.trim().match(/^\\[tool:([^\\]\\s]+)(?:\\s+([^\\]]+))?\\]$/);
      if (tool) {
        flushAgent();
        const d = document.createElement('div');
        d.className = 'entry-tool';
        d.textContent = 'tool · ' + tool[1] + (tool[2] ? ' · ' + tool[2] : '');
        logEl.appendChild(d);
        scrollLog();
        return;
      }
      if (!agentEl) {
        agentEl = document.createElement('div');
        agentEl.className = 'entry-agent';
        logEl.appendChild(agentEl);
        agentBuf = '';
      }
      agentBuf += text;
      agentEl.replaceChildren(renderRich(agentBuf));
      scrollLog();
    }

    function handleEnvelope(msg) {
      const e = msg.event || msg;
      if (e.kind === 'agent.delta') {
        onAgentDelta(e.text || '');
        return;
      }
      flushAgent();
      if (e.kind === 'session.started') note('Session started');
      else if (e.kind === 'turn.queued') note('Prompt queued');
      else if (e.kind === 'turn.started') turnMarker('Turn started', 'running');
      else if (e.kind === 'turn.finished') {
        const err = typeof e.summary === 'string' && e.summary.startsWith('error:');
        turnMarker(err ? e.summary : 'Turn finished', err ? 'err' : 'done');
        refreshSessions();
      }
      else if (e.kind === 'git.pushed') note('Committed ' + e.head + ' on ' + e.branch);
      else if (e.kind === 'session.closed') note('Session closed' + (e.reason ? ': ' + e.reason : ''));
      else note('[' + (msg.origin || '?') + '] ' + e.kind);
    }

    async function refreshHealth() {
      try {
        const r = await fetch('/api/health');
        const j = await r.json();
        health.textContent = 'ok · ' + j.sessions + ' sessions';
        health.classList.add('live');
      } catch {
        health.textContent = 'down';
      }
    }

    async function refreshSessions() {
      const q = showArchived.checked ? '?include=archived' : '';
      const r = await fetch('/api/sessions' + q);
      const j = await r.json();
      sessionList.replaceChildren();
      for (const s of j.sessions || []) {
        const li = document.createElement('li');
        if (s.id === sessionId) li.classList.add('active');
        if (s.archivedAt) li.classList.add('archived');
        const st = document.createElement('span');
        st.className = 'st ' + (s.status || 'idle');
        const mid = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = s.title || s.id;
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = s.status + (s.parentSessionId ? ' · fork' : '');
        mid.appendChild(title);
        mid.appendChild(sub);
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = s.archivedAt ? 'archived' : s.status;
        li.appendChild(st);
        li.appendChild(mid);
        li.appendChild(badge);
        li.onclick = () => selectSession(s.id, { clear: true });
        sessionList.appendChild(li);
      }
      refreshHealth();
    }

    async function selectSession(id, opts) {
      sessionId = id;
      const r = await fetch('/api/sessions/' + id);
      const j = await r.json();
      sessionMeta = j;
      sesspill.textContent = id;
      sesspill.classList.add('live');
      meta.textContent = 'branch: ' + j.branch + '\\nrepo: ' + j.repoDir
        + (j.parentSessionId ? '\\nparent: ' + j.parentSessionId : '')
        + (j.archivedAt ? '\\narchived' : '');
      setActionsEnabled(true);
      if (opts && opts.clear) {
        clearLog();
        note('Switched to ' + id + (j.archivedAt ? ' (archived)' : ''));
      }
      connectEvents(id);
      refreshSessions();
    }

    function connectEvents(id) {
      if (ws) ws.close();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/api/sessions/' + id + '/events');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'hello') return;
          handleEnvelope(msg);
        } catch {
          note(String(ev.data));
        }
      };
    }

    showArchived.onchange = () => refreshSessions();
    refreshHealth();
    refreshSessions();
    setInterval(refreshSessions, 2500);

    document.getElementById('start').onclick = async () => {
      const text = document.getElementById('prompt').value.trim();
      document.getElementById('start').disabled = true;
      clearLog();
      note('Creating session…');
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, title: text.slice(0, 72) }),
      });
      const j = await r.json();
      document.getElementById('start').disabled = false;
      await selectSession(j.id, { clear: false });
      note('Session ' + j.id);
    };

    document.getElementById('follow').onclick = async () => {
      if (!sessionId) return;
      const text = document.getElementById('prompt').value.trim();
      await fetch('/api/sessions/' + sessionId + '/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      note('Follow-up queued…');
      refreshSessions();
    };

    document.getElementById('commit').onclick = async () => {
      if (!sessionId) return;
      const r = await fetch('/api/sessions/' + sessionId + '/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json();
      note('Committed ' + j.sha + ' on ' + j.branch);
    };

    document.getElementById('fork').onclick = async () => {
      if (!sessionId) return;
      note('Forking…');
      const r = await fetch('/api/sessions/' + sessionId + '/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Fork of ' + (sessionMeta && sessionMeta.title ? sessionMeta.title : sessionId) }),
      });
      const j = await r.json();
      if (!r.ok) { note('Fork failed: ' + (j.error || r.status)); return; }
      await selectSession(j.id, { clear: true });
      note('Forked from ' + j.parentSessionId);
    };

    document.getElementById('archive').onclick = async () => {
      if (!sessionId) return;
      await fetch('/api/sessions/' + sessionId + '/archive', { method: 'POST' });
      note('Archived ' + sessionId);
      sessionId = null;
      sessionMeta = null;
      sesspill.textContent = 'no session';
      setActionsEnabled(false);
      clearLog();
      refreshSessions();
    };

    document.getElementById('restore').onclick = async () => {
      if (!sessionId) return;
      await fetch('/api/sessions/' + sessionId + '/restore', { method: 'POST' });
      await selectSession(sessionId, { clear: false });
      note('Restored ' + sessionId);
    };

    document.getElementById('destroy').onclick = async () => {
      if (!sessionId) return;
      if (!confirm('Delete session and destroy sandbox disk?')) return;
      const id = sessionId;
      const r = await fetch('/api/sessions/' + id, { method: 'DELETE' });
      const j = await r.json();
      note('Deleted ' + id + (j.diskGone ? ' (disk gone)' : ''));
      sessionId = null;
      sessionMeta = null;
      sesspill.textContent = 'no session';
      setActionsEnabled(false);
      refreshSessions();
    };
  </script>
</body>
</html>`;
}
