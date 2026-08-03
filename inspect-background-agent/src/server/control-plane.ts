import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { GitSandboxManager, defaultSandboxRoot, type GitAuthor } from "../sandbox/git-sandbox.js";
import { OpenCodeBridge } from "../agent/opencode-bridge.js";
import { createMemoryEventBus } from "../control/event-bus.js";
import type { SessionEventEnvelope } from "../session/index.js";
import { brandNumber, brandString, type ActorId, type BranchName, type CommitSha, type TurnId } from "../kernel/index.js";

export type SessionRow = {
  id: string;
  title: string;
  sandboxId: string;
  repoDir: string;
  branch: string;
  opencodeSessionId: string | null;
  author: GitAuthor;
  createdAt: number;
  status: "idle" | "running" | "error";
  lastError?: string;
};

export type ControlPlaneOptions = {
  readonly rootDir?: string;
  readonly port?: number;
  readonly host?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export async function startControlPlane(opts: ControlPlaneOptions = {}) {
  const rootDir = opts.rootDir ?? path.join("/tmp", "hatch-inspect");
  const sandboxes = new GitSandboxManager(path.join(rootDir, "sandboxes"));
  await sandboxes.ensureBase();

  const bridge = new OpenCodeBridge({
    model: {
      providerID: opts.modelProvider ?? "opencode",
      modelID: opts.modelId ?? "big-pickle",
    },
  });
  await bridge.start();

  const sessions = new Map<string, SessionRow>();
  const bus = createMemoryEventBus();
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
    c.json({ ok: true, sessions: sessions.size, service: "@hatch/inspect" }),
  );

  app.get("/api/sessions", (c) =>
    c.json({
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        title: s.title,
        branch: s.branch,
        status: s.status,
        createdAt: s.createdAt,
      })),
    }),
  );

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
      status: "idle",
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
      void runPrompt(row.id, body.prompt);
    }
    return c.json({
      id: row.id,
      branch: row.branch,
      repoDir: row.repoDir,
      status: row.status,
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
    const body = (await c.req.json()) as { text?: string };
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    void runPrompt(row.id, body.text.trim());
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
    if (!row || !row.opencodeSessionId) return;
    row.status = "running";
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
      const gitStatus = await sandboxes.status(row.repoDir);
      emit(sessionId, "agent", {
        kind: "turn.finished",
        turnId,
        summary: summary.slice(0, 500) || (gitStatus ? "done (dirty tree)" : "done"),
      });
    } catch (e) {
      row.status = "error";
      row.lastError = e instanceof Error ? e.message : String(e);
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
      font-family: "IBM Plex Mono", monospace;
      font-size: 12.5px;
      line-height: 1.45;
      background: #0b0f0c;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      height: calc(100vh - 170px);
      overflow: auto;
      white-space: pre-wrap;
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
  </style>
</head>
<body>
  <header>
    <h1>Hatch Inspect</h1>
    <p>Local background coding agent — real git sandbox + OpenCode (free models). Inspired by Ramp Inspect / Open-Inspect, not a clone.</p>
  </header>
  <main>
    <aside>
      <div><span class="pill" id="health">…</span><span class="pill" id="sesspill">no session</span></div>
      <label>Prompt</label>
      <textarea id="prompt">Add a function called add in src/math.ts that returns the sum of two numbers, and export it. Keep it TypeScript.</textarea>
      <button id="start">Start session + run</button>
      <button class="secondary" id="follow" disabled>Send follow-up</button>
      <button class="secondary" id="commit" disabled>Commit changes</button>
      <div class="meta" id="meta"></div>
    </aside>
    <section>
      <div id="log">Waiting…</div>
    </section>
  </main>
  <script>
    const logEl = document.getElementById('log');
    const meta = document.getElementById('meta');
    const health = document.getElementById('health');
    const sesspill = document.getElementById('sesspill');
    let sessionId = null;
    let ws = null;

    function log(line) {
      logEl.textContent += line + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
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
    refreshHealth();

    function connectEvents(id) {
      if (ws) ws.close();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/api/sessions/' + id + '/events');
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'hello') return;
          const e = msg.event || msg;
          if (e.kind === 'agent.delta') log(e.text);
          else log('[' + (msg.origin || '?') + '] ' + e.kind + (e.summary ? ' — ' + e.summary : ''));
        } catch {
          log(ev.data);
        }
      };
    }

    document.getElementById('start').onclick = async () => {
      const text = document.getElementById('prompt').value.trim();
      document.getElementById('start').disabled = true;
      logEl.textContent = '';
      log('Creating session…');
      const r = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, title: text.slice(0, 72) }),
      });
      const j = await r.json();
      sessionId = j.id;
      sesspill.textContent = sessionId;
      sesspill.classList.add('live');
      meta.textContent = 'branch: ' + j.branch + '\\nrepo: ' + j.repoDir;
      connectEvents(sessionId);
      document.getElementById('follow').disabled = false;
      document.getElementById('commit').disabled = false;
      document.getElementById('start').disabled = false;
      refreshHealth();
    };

    document.getElementById('follow').onclick = async () => {
      if (!sessionId) return;
      const text = document.getElementById('prompt').value.trim();
      await fetch('/api/sessions/' + sessionId + '/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      log('Follow-up queued…');
    };

    document.getElementById('commit').onclick = async () => {
      if (!sessionId) return;
      const r = await fetch('/api/sessions/' + sessionId + '/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      log('Committed ' + j.sha + ' on ' + j.branch);
    };
  </script>
</body>
</html>`;
}
