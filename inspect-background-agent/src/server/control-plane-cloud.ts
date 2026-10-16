/**
 * Three-plane control plane: durable SessionAgent store (SQLite) + EventBus + remote compute.
 * Compute is the local shim or Modal — same HTTP contract (ComputeClient).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createMemoryEventBus } from "../control/event-bus.js";
import { SessionQueues } from "../control/session-queues.js";
import { SqliteSessionStore } from "../control/session-store-sqlite.js";
import { ComputeClient } from "../compute/client.js";
import { resolveModel } from "../agent/models.js";
import { brandNumber, brandString } from "../kernel/index.js";
import type { SessionEventEnvelope } from "../session/index.js";
import { webUiHtml } from "./control-plane.js";

export type CloudControlOptions = {
  readonly port?: number;
  readonly host?: string;
  readonly computeUrl: string;
  readonly computeToken?: string;
  readonly dbPath?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export async function startCloudControlPlane(opts: CloudControlOptions) {
  const model = resolveModel(
    opts.modelId ?? process.env.OPENCODE_MODEL,
    opts.modelProvider ?? process.env.OPENCODE_PROVIDER,
  );
  const compute = new ComputeClient({
    baseUrl: opts.computeUrl,
    ...(opts.computeToken ? { token: opts.computeToken } : {}),
  });
  await compute.health();

  const dbPath =
    opts.dbPath ?? path.join("/tmp", "hatch-inspect", "session-agent.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const store = new SqliteSessionStore(dbPath);
  const bus = createMemoryEventBus();
  const queues = new SessionQueues();
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
    store.appendEvent(sessionId, {
      seq,
      at: Date.now(),
      origin,
      payload: event,
    });
    bus.publish(brandString<"SessionId">(sessionId), envelope);
    return envelope;
  }

  async function runPrompt(sessionId: string, text: string) {
    const row = store.get(sessionId);
    if (!row || row.archivedAt) return;
    row.status = "running";
    row.lastActiveAt = Date.now();
    store.upsert(row);
    const turnId = brandString<"TurnId">(id("trn"));
    emit(sessionId, "user", {
      kind: "turn.queued",
      turn: {
        id: turnId,
        author: {
          id: brandString<"ActorId">(row.authorEmail),
          display: row.authorName,
          github: null,
        },
        text,
        state: { kind: "queued" },
      },
    });
    emit(sessionId, "system", { kind: "turn.started", turnId });
    try {
      let summary = "";
      for await (const delta of compute.prompt(row.sandboxId, text, model)) {
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
          row.lastActiveAt = Date.now();
          store.upsert(row);
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
      row.lastActiveAt = Date.now();
      store.upsert(row);
      emit(sessionId, "agent", {
        kind: "turn.finished",
        turnId,
        summary: summary.slice(0, 500) || "done",
      });
    } catch (e) {
      row.status = "error";
      row.lastError = e instanceof Error ? e.message : String(e);
      row.lastActiveAt = Date.now();
      store.upsert(row);
      emit(sessionId, "system", {
        kind: "turn.finished",
        turnId,
        summary: `error: ${row.lastError}`,
      });
    }
  }

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/api/health", async (c) => {
    const ch = await compute.health();
    return c.json({
      ok: true,
      plane: "control",
      sessions: store.list(true).length,
      compute: ch,
      model,
      service: "@hatch/inspect-cloud",
    });
  });

  app.get("/api/models", (c) =>
    c.json({
      models: [
        { providerID: "opencode", modelID: "big-pickle" },
        { providerID: "opencode", modelID: "ling-3.0-flash-free" },
      ],
      selected: model,
    }),
  );

  app.get("/api/sessions", (c) => {
    const includeArchived = c.req.query("include") === "archived";
    return c.json({
      sessions: store.list(includeArchived).map((s) => ({
        id: s.id,
        title: s.title,
        branch: s.branch,
        status: s.status,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        archivedAt: s.archivedAt,
        parentSessionId: s.parentSessionId,
        lastError: s.lastError,
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
    const author = {
      name: body.authorName ?? "Inspect User",
      email: body.authorEmail ?? "user@localhost",
    };
    const sb = await compute.createSandbox({
      ...(body.cloneUrl ? { cloneUrl: body.cloneUrl } : {}),
      author,
    });
    const row = {
      id: id("ses"),
      title: body.title ?? body.prompt?.slice(0, 72) ?? "Untitled session",
      sandboxId: sb.id,
      branch: sb.branch,
      authorName: author.name,
      authorEmail: author.email,
      status: "idle" as const,
      lastError: null,
      archivedAt: null,
      parentSessionId: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    store.upsert(row);
    emit(row.id, "system", {
      kind: "session.started",
      repo: { owner: "local", name: sb.id },
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
      repoDir: sb.repoDir ?? null,
      sandboxId: sb.id,
      status: row.status,
      plane: "cloud-control",
    });
  });

  app.get("/api/sessions/:id", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const art = await compute.artifacts(row.sandboxId);
    return c.json({
      ...row,
      author: store.author(row),
      gitStatus: art.files.length ? "dirty" : "",
      diff: art.diff,
      files: art.files,
    });
  });

  app.get("/api/sessions/:id/artifacts", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const art = await compute.artifacts(row.sandboxId);
    return c.json({
      sessionId: row.id,
      branch: row.branch,
      ...art,
      screenshots: [],
      screenshotsNote:
        "Screenshots need Modal VNC sidecars. Compute plane can add them later.",
    });
  });

  app.post("/api/sessions/:id/prompt", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.archivedAt) return c.json({ error: "archived; restore first" }, 409);
    const body = (await c.req.json()) as { text?: string };
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    void queues.enqueue(row.id, () => runPrompt(row.id, body.text!.trim()));
    return c.json({ ok: true, status: "queued" });
  });

  app.post("/api/sessions/:id/commit", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    const result = await compute.commit(
      row.sandboxId,
      body.message ?? `inspect: ${row.title}`,
      store.author(row),
    );
    emit(row.id, "sandbox", {
      kind: "git.pushed",
      branch: brandString<"BranchName">(row.branch),
      head: brandString<"CommitSha">(result.sha),
    });
    return c.json(result);
  });

  app.post("/api/sessions/:id/archive", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status === "running") return c.json({ error: "session running" }, 409);
    row.archivedAt = Date.now();
    row.lastActiveAt = Date.now();
    store.upsert(row);
    emit(row.id, "system", { kind: "session.closed", reason: "archived" });
    return c.json({ ok: true, id: row.id, archivedAt: row.archivedAt });
  });

  app.post("/api/sessions/:id/restore", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    row.archivedAt = null;
    row.lastActiveAt = Date.now();
    store.upsert(row);
    return c.json({ ok: true, id: row.id, archivedAt: null });
  });

  app.post("/api/sessions/:id/fork", async (c) => {
    const parent = store.get(c.req.param("id"));
    if (!parent) return c.json({ error: "not found" }, 404);
    if (parent.archivedAt) return c.json({ error: "archived; restore first" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      prompt?: string;
    };
    // Commit dirty on parent, then create a fresh sandbox by cloning parent repoDir if local.
    await compute.commit(
      parent.sandboxId,
      "inspect: snapshot before fork",
      store.author(parent),
    );
    const parentDetail = await compute.artifacts(parent.sandboxId);
    const seed: Record<string, string> = {};
    for (const f of parentDetail.files) {
      if (f.content != null && !f.binary) seed[f.path] = f.content;
    }
    const sb = await compute.createSandbox({
      author: store.author(parent),
      ...(Object.keys(seed).length ? { seedFiles: seed } : {}),
    });
    const row = {
      id: id("ses"),
      title: body.title ?? `Fork of ${parent.title}`.slice(0, 72),
      sandboxId: sb.id,
      branch: sb.branch,
      authorName: parent.authorName,
      authorEmail: parent.authorEmail,
      status: "idle" as const,
      lastError: null,
      archivedAt: null,
      parentSessionId: parent.id,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    store.upsert(row);
    emit(row.id, "system", {
      kind: "session.started",
      repo: { owner: "local", name: sb.id },
      by: {
        id: brandString<"ActorId">(parent.authorEmail),
        display: parent.authorName,
        github: null,
      },
    });
    if (body.prompt) {
      void queues.enqueue(row.id, () => runPrompt(row.id, body.prompt!));
    }
    return c.json({
      id: row.id,
      branch: row.branch,
      repoDir: sb.repoDir ?? null,
      status: row.status,
      parentSessionId: parent.id,
    });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const row = store.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await queues.drain(row.id);
    const destroyed = await compute.destroySandbox(row.sandboxId);
    store.delete(row.id);
    return c.json({ ok: true, destroyed: row.sandboxId, diskGone: destroyed.diskGone });
  });

  app.get(
    "/api/sessions/:id/events",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id") ?? "";
      return {
        onOpen(_evt, ws) {
          for (const past of store.events(sessionId)) {
            ws.send(JSON.stringify(past));
          }
          const unsub = bus.subscribe(brandString<"SessionId">(sessionId), (envelope) => {
            ws.send(JSON.stringify(envelope));
          });
          (ws as unknown as { __unsub?: () => void }).__unsub = unsub;
          ws.send(JSON.stringify({ type: "hello", sessionId, plane: "cloud-control" }));
        },
        onClose(_evt, ws) {
          (ws as unknown as { __unsub?: () => void }).__unsub?.();
        },
      };
    }),
  );

  app.get("/", (c) => c.html(webUiHtml()));
  app.get("/ui", (c) => c.html(webUiHtml()));

  const port = opts.port ?? 8788;
  const host = opts.host ?? "0.0.0.0";
  const server = serve({ fetch: app.fetch, port, hostname: host });
  injectWebSocket(server);

  return {
    app,
    server,
    port,
    host,
    store,
    compute,
    async close() {
      for (const s of store.list(true)) {
        await queues.drain(s.id);
        try {
          await compute.destroySandbox(s.sandboxId);
        } catch {
          /* ignore */
        }
        store.delete(s.id);
      }
      store.close();
      server.close();
    },
  };
}
