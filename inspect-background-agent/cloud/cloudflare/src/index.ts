/**
 * Hatch Inspect Cloudflare control plane (Workers + Durable Objects).
 *
 * Bindings:
 *   SESSION_AGENT  - one DO per session (SQLite transcript)
 *   EVENT_BUS      - fan-out WebSockets (hibernation)
 *   COMPUTE_URL    - Modal or local compute shim
 *   COMPUTE_TOKEN  - optional bearer
 *
 * Dev:
 *   cd cloud/cloudflare && npm i && npx wrangler dev
 *   with COMPUTE_URL=http://127.0.0.1:8790 (compute shim on host)
 */

export interface Env {
  SESSION_AGENT: DurableObjectNamespace;
  EVENT_BUS: DurableObjectNamespace;
  COMPUTE_URL: string;
  COMPUTE_TOKEN?: string;
}

type Author = { name: string; email: string };

async function computeFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  if (env.COMPUTE_TOKEN) headers.set("authorization", `Bearer ${env.COMPUTE_TOKEN}`);
  return fetch(`${env.COMPUTE_URL.replace(/\/$/, "")}${path}`, { ...init, headers });
}

function sessionStub(env: Env, sessionId: string) {
  return env.SESSION_AGENT.get(env.SESSION_AGENT.idFromName(sessionId));
}

function busStub(env: Env, sessionId: string) {
  return env.EVENT_BUS.get(env.EVENT_BUS.idFromName(sessionId));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      let compute: unknown = null;
      try {
        const r = await computeFetch(env, "/health");
        compute = await r.json();
      } catch (e) {
        compute = { ok: false, error: String(e) };
      }
      return Response.json({
        ok: true,
        plane: "cloudflare",
        service: "@hatch/inspect-cf",
        compute,
      });
    }

    if (url.pathname === "/api/sessions" && request.method === "GET") {
      // List is process-local on Node; on CF we keep an index DO name fixed.
      const index = env.SESSION_AGENT.get(env.SESSION_AGENT.idFromName("__index__"));
      return index.fetch(new Request("https://do/list" + url.search, { method: "GET" }));
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        title?: string;
        cloneUrl?: string;
        authorName?: string;
        authorEmail?: string;
        prompt?: string;
      };
      const author: Author = {
        name: body.authorName ?? "Inspect User",
        email: body.authorEmail ?? "user@localhost",
      };
      const sbRes = await computeFetch(env, "/v1/sandboxes", {
        method: "POST",
        body: JSON.stringify({
          cloneUrl: body.cloneUrl,
          author,
        }),
      });
      if (!sbRes.ok) {
        return Response.json(
          { error: `compute create failed: ${await sbRes.text()}` },
          { status: 502 },
        );
      }
      const sb = (await sbRes.json()) as { id: string; branch: string; repoDir?: string };
      const sessionId = `ses_${crypto.randomUUID().slice(0, 10)}`;
      const stub = sessionStub(env, sessionId);
      const created = await stub.fetch(
        new Request("https://do/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: sessionId,
            title: body.title ?? body.prompt?.slice(0, 72) ?? "Untitled session",
            sandboxId: sb.id,
            branch: sb.branch,
            author,
          }),
        }),
      );
      if (!created.ok) return created;

      const index = env.SESSION_AGENT.get(env.SESSION_AGENT.idFromName("__index__"));
      await index.fetch(
        new Request("https://do/index-add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: sessionId,
            title: body.title ?? body.prompt?.slice(0, 72) ?? "Untitled session",
            branch: sb.branch,
            status: "idle",
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
          }),
        }),
      );

      if (body.prompt) {
        // Fire-and-forget prompt via DO
        void stub.fetch(
          new Request("https://do/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: body.prompt }),
          }),
        );
      }

      return Response.json({
        id: sessionId,
        branch: sb.branch,
        repoDir: sb.repoDir ?? null,
        sandboxId: sb.id,
        status: "idle",
        plane: "cloudflare",
      });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(.*)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const rest = sessionMatch[2] || "";
      if (rest === "/events" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return busStub(env, sessionId).fetch(request);
      }
      const stub = sessionStub(env, sessionId);
      return stub.fetch(
        new Request(`https://do${rest || "/"}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        }),
      );
    }

    if (url.pathname === "/" || url.pathname === "/ui") {
      return new Response(
        "Hatch Inspect Cloudflare control plane. Use /api/health and /api/sessions. UI stays on the Node cloud control plane (npm run serve:cloud) or Open-Inspect web.",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
};

/** Per-session Durable Object — transcript + prompt drain against compute. */
export class SessionAgent {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        origin TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  private getMeta(): Record<string, unknown> | null {
    const row = this.state.storage.sql
      .exec(`SELECT value FROM meta WHERE key = 'session'`)
      .toArray()[0] as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  }

  private setMeta(meta: Record<string, unknown>) {
    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('session', ?)`,
      JSON.stringify(meta),
    );
  }

  private async publish(origin: string, event: unknown) {
    const meta = this.getMeta();
    if (!meta) return;
    this.state.storage.sql.exec(
      `INSERT INTO events (at, origin, payload) VALUES (?, ?, ?)`,
      Date.now(),
      origin,
      JSON.stringify(event),
    );
    const seqRow = this.state.storage.sql
      .exec(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1`)
      .toArray()[0] as { seq: number };
    const envelope = {
      seq: seqRow.seq,
      at: Date.now(),
      origin,
      event,
    };
    await busStub(this.env, String(meta.id)).fetch(
      new Request("https://bus/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/create" && request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      this.setMeta({ ...body, status: "idle", createdAt: Date.now(), lastActiveAt: Date.now() });
      await this.publish("system", {
        kind: "session.started",
        repo: { owner: "cf", name: body.sandboxId },
        by: {
          id: (body.author as Author).email,
          display: (body.author as Author).name,
          github: null,
        },
      });
      return Response.json({ ok: true });
    }

    if (path === "/list") {
      // Only the __index__ object serves list; others 404.
      const rows = this.state.storage.sql
        .exec(`SELECT value FROM meta WHERE key LIKE 'idx:%'`)
        .toArray() as { value: string }[];
      const sessions = rows.map((r) => JSON.parse(r.value));
      const include = url.searchParams.get("include") === "archived";
      return Response.json({
        sessions: include
          ? sessions
          : sessions.filter((s: { archivedAt?: number | null }) => !s.archivedAt),
      });
    }

    if (path === "/index-add" && request.method === "POST") {
      const body = (await request.json()) as { id: string };
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
        `idx:${body.id}`,
        JSON.stringify(body),
      );
      return Response.json({ ok: true });
    }

    const meta = this.getMeta();
    if (!meta && path !== "/list" && path !== "/index-add") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    if ((path === "/" || path === "") && request.method === "GET") {
      const sandboxId = String(meta!.sandboxId);
      const art = await computeFetch(this.env, `/v1/sandboxes/${sandboxId}/artifacts`);
      const artifacts = (art.ok
        ? await art.json()
        : { diff: "", files: [] }) as Record<string, unknown>;
      return Response.json({ ...(meta as Record<string, unknown>), ...artifacts });
    }

    if (path === "/artifacts") {
      const art = await computeFetch(
        this.env,
        `/v1/sandboxes/${meta!.sandboxId}/artifacts`,
      );
      return new Response(await art.text(), {
        status: art.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (path === "/prompt" && request.method === "POST") {
      const body = (await request.json()) as { text?: string };
      if (!body.text?.trim()) return Response.json({ error: "text required" }, { status: 400 });
      // Serialize prompts with DO storage alarm / blockConcurrencyWhile
      await this.state.blockConcurrencyWhile(async () => {
        meta!.status = "running";
        meta!.lastActiveAt = Date.now();
        this.setMeta(meta!);
        const turnId = `trn_${crypto.randomUUID().slice(0, 8)}`;
        await this.publish("system", { kind: "turn.started", turnId });
        const r = await computeFetch(this.env, `/v1/sandboxes/${meta!.sandboxId}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: body.text }),
        });
        if (!r.ok || !r.body) {
          meta!.status = "error";
          meta!.lastError = await r.text();
          this.setMeta(meta!);
          await this.publish("system", {
            kind: "turn.finished",
            turnId,
            summary: `error: ${meta!.lastError}`,
          });
          return;
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let summary = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const delta = JSON.parse(line) as {
              kind: string;
              text?: string;
              message?: string;
              name?: string;
              status?: string;
            };
            if (delta.kind === "text" && delta.text) {
              summary += delta.text;
              await this.publish("agent", {
                kind: "agent.delta",
                turnId,
                text: delta.text,
              });
            } else if (delta.kind === "tool") {
              await this.publish("agent", {
                kind: "agent.delta",
                turnId,
                text: `\n[tool:${delta.name} ${delta.status}]\n`,
              });
            } else if (delta.kind === "error") {
              meta!.status = "error";
              meta!.lastError = delta.message;
              this.setMeta(meta!);
              await this.publish("system", {
                kind: "turn.finished",
                turnId,
                summary: `error: ${delta.message}`,
              });
              return;
            }
          }
        }
        meta!.status = "idle";
        meta!.lastActiveAt = Date.now();
        this.setMeta(meta!);
        await this.publish("agent", {
          kind: "turn.finished",
          turnId,
          summary: summary.slice(0, 500) || "done",
        });
      });
      return Response.json({ ok: true, status: "queued" });
    }

    if (path === "/commit" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { message?: string };
      const r = await computeFetch(this.env, `/v1/sandboxes/${meta!.sandboxId}/commit`, {
        method: "POST",
        body: JSON.stringify({
          message: body.message ?? `inspect: ${meta!.title}`,
          author: meta!.author,
        }),
      });
      return new Response(await r.text(), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "DELETE") {
      await computeFetch(this.env, `/v1/sandboxes/${meta!.sandboxId}`, { method: "DELETE" });
      await this.state.storage.deleteAll();
      return Response.json({ ok: true, destroyed: meta!.sandboxId, diskGone: true });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
}

/** EventBus Durable Object — hibernatable WebSocket fan-out per session. */
export class EventBus {
  private sessions: Map<WebSocket, unknown> = new Map();

  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {
    this.state.getWebSockets().forEach((ws) => this.sessions.set(ws, null));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      this.sessions.set(pair[1], null);
      pair[1].send(JSON.stringify({ type: "hello", plane: "cloudflare-event-bus" }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/publish" && request.method === "POST") {
      const envelope = await request.json();
      for (const ws of this.sessions.keys()) {
        try {
          ws.send(JSON.stringify(envelope));
        } catch {
          this.sessions.delete(ws);
        }
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }
}
