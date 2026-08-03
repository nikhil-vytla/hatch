/**
 * Agent Workspace server — one process: API + SSE chat + WS terminal + embedded UI.
 * Hermes-workspace shape (chat/sessions/memory/skills/files/terminal) on the
 * OpenCode-or-OpenAI-compatible backends this hatch can actually run.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveBackend, type ChatBackend } from "./backend.js";
import { WorkspaceStore } from "./store.js";
import {
  assertBindAllowed,
  authMiddleware,
  COOKIE_NAME,
  LoginLimiter,
  passwordsMatch,
  PathError,
  safeResolve,
  SessionTokens,
  setSessionCookie,
} from "./security.js";
import { workspaceHtml } from "./ui.js";
import { getCookie } from "hono/cookie";

export type WorkspaceOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly dataDir?: string;
  readonly filesRoot?: string;
  readonly password?: string;
  readonly backend?: ChatBackend;
  readonly cookieSecure?: boolean;
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export async function startWorkspace(opts: WorkspaceOptions = {}) {
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.PORT ?? 8899);
  const password = opts.password ?? process.env.WORKSPACE_PASSWORD;
  assertBindAllowed(host, password);

  const dataDir = opts.dataDir ?? path.join(process.cwd(), "data");
  const filesRoot = opts.filesRoot ?? process.env.WORKSPACE_FILES_ROOT ?? process.cwd();
  const memoryDir = path.join(dataDir, "memory");
  const skillsDir = process.env.WORKSPACE_SKILLS_DIR ?? path.join(dataDir, "skills");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  const backend = opts.backend ?? resolveBackend();
  const store = new WorkspaceStore(path.join(dataDir, "workspace.sqlite"));
  const tokens = new SessionTokens();
  const limiter = new LoginLimiter();
  const cookieSecure = opts.cookieSecure ?? process.env.COOKIE_SECURE === "1";

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("*", authMiddleware({ password, tokens, cookieSecure }));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      service: "@hatch/agent-workspace",
      backend: { mode: backend.mode, model: backend.model },
      authRequired: Boolean(password),
      sessions: store.listSessions().length,
    }),
  );

  app.post("/api/login", async (c) => {
    if (!password) return c.json({ ok: true, authRequired: false });
    const who =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (!limiter.allow(who)) return c.json({ error: "too many attempts" }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    if (!body.password || !passwordsMatch(body.password, password)) {
      return c.json({ error: "wrong password" }, 401);
    }
    const token = tokens.issue();
    setSessionCookie(c, token, cookieSecure);
    return c.json({ ok: true, token });
  });

  app.post("/api/logout", (c) => {
    tokens.revoke(getCookie(c, COOKIE_NAME));
    return c.json({ ok: true });
  });

  // ---- Sessions + chat ----

  app.get("/api/sessions", (c) => c.json({ sessions: store.listSessions() }));

  app.post("/api/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const meta = store.createSession(id("chat"), body.title ?? "New chat");
    return c.json(meta);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
    const ok = store.renameSession(c.req.param("id"), body.title.trim());
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/api/sessions/:id", (c) => {
    const ok = store.deleteSession(c.req.param("id"));
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const meta = store.getSession(c.req.param("id"));
    if (!meta) return c.json({ error: "not found" }, 404);
    return c.json({ session: meta, messages: store.messages(meta.id) });
  });

  app.post("/api/sessions/:id/chat", async (c) => {
    const meta = store.getSession(c.req.param("id"));
    if (!meta) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = body.text?.trim();
    if (!text) return c.json({ error: "text required" }, 400);

    store.appendMessage(meta.id, "user", text);
    if (meta.messageCount === 0) {
      store.renameSession(meta.id, text.slice(0, 60));
    }
    const history = store.messages(meta.id);

    return streamSSE(c, async (stream) => {
      let full = "";
      try {
        for await (const delta of backend.stream(history)) {
          full += delta;
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: delta }) });
        }
        store.appendMessage(meta.id, "assistant", full);
        await stream.writeSSE({ event: "done", data: JSON.stringify({ length: full.length }) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message }) });
      }
    });
  });

  // ---- Files (workspace-rooted, traversal-guarded) ----

  const pathGuard = (rel: string, root = filesRoot): string => safeResolve(root, rel);

  app.get("/api/files", async (c) => {
    const rel = c.req.query("dir") ?? ".";
    let dir: string;
    try {
      dir = pathGuard(rel);
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      throw e;
    }
    const names = await readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      names
        .filter((d) => d.name !== "node_modules" && d.name !== ".git")
        .map(async (d) => {
          const s = await stat(path.join(dir, d.name)).catch(() => null);
          return {
            name: d.name,
            dir: d.isDirectory(),
            size: s?.size ?? 0,
            mtime: s?.mtimeMs ?? 0,
          };
        }),
    );
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return c.json({ dir: rel, entries });
  });

  app.get("/api/files/content", async (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path required" }, 400);
    try {
      const p = pathGuard(rel);
      const body = await readFile(p, "utf8");
      return c.json({ path: rel, content: body.slice(0, 500_000) });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      return c.json({ error: "unreadable" }, 404);
    }
  });

  app.put("/api/files/content", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      content?: string;
    };
    if (!body.path || body.content === undefined) {
      return c.json({ error: "path and content required" }, 400);
    }
    try {
      const p = pathGuard(body.path);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, body.content, "utf8");
      return c.json({ ok: true, path: body.path });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // ---- Memory (markdown notes the agent/user share) ----

  app.get("/api/memory", async (c) => {
    const names = (await readdir(memoryDir)).filter((n) => n.endsWith(".md"));
    return c.json({ notes: names.sort() });
  });

  app.get("/api/memory/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const p = pathGuard(name, memoryDir);
      const content = await readFile(p, "utf8").catch(() => "");
      return c.json({ name, content });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.put("/api/memory/:name", async (c) => {
    const name = c.req.param("name");
    if (!name.endsWith(".md")) return c.json({ error: "notes are .md files" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    try {
      const p = pathGuard(name, memoryDir);
      await writeFile(p, body.content ?? "", "utf8");
      return c.json({ ok: true, name });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  app.delete("/api/memory/:name", async (c) => {
    try {
      const p = pathGuard(c.req.param("name"), memoryDir);
      await rm(p, { force: true });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // ---- Skills (read-only browse) ----

  app.get("/api/skills", async (c) => {
    const out: { name: string; path: string }[] = [];
    const walk = async (dir: string, prefix: string) => {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const it of items) {
        if (it.isDirectory()) await walk(path.join(dir, it.name), `${prefix}${it.name}/`);
        else if (it.name.endsWith(".md")) out.push({ name: `${prefix}${it.name}`, path: `${prefix}${it.name}` });
      }
    };
    await walk(skillsDir, "");
    return c.json({ skills: out.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  app.get("/api/skills/content", async (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path required" }, 400);
    try {
      const p = pathGuard(rel, skillsDir);
      return c.json({ path: rel, content: await readFile(p, "utf8") });
    } catch (e) {
      if (e instanceof PathError) return c.json({ error: e.message }, 400);
      return c.json({ error: "unreadable" }, 404);
    }
  });

  // ---- Terminal (WS <-> piped bash) ----

  app.get(
    "/ws/terminal",
    upgradeWebSocket(() => {
      let shell: ReturnType<typeof spawn> | null = null;
      return {
        onOpen(_evt, ws) {
          shell = spawn("bash", ["-i"], {
            cwd: filesRoot,
            env: { ...process.env, TERM: "dumb", PS1: "\\w $ " },
            stdio: ["pipe", "pipe", "pipe"],
          });
          shell.stdout?.on("data", (d: Buffer) => ws.send(d.toString()));
          shell.stderr?.on("data", (d: Buffer) => ws.send(d.toString()));
          shell.on("close", () => ws.close());
          ws.send(`connected: bash in ${filesRoot} (piped, no PTY)\r\n`);
        },
        onMessage(evt) {
          shell?.stdin?.write(String(evt.data));
        },
        onClose() {
          shell?.kill("SIGKILL");
          shell = null;
        },
      };
    }),
  );

  // ---- UI ----
  app.get("/", (c) => c.html(workspaceHtml()));

  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  return {
    app,
    port,
    host,
    store,
    backend,
    dataDir,
    async close() {
      store.close();
      server.close();
    },
  };
}
