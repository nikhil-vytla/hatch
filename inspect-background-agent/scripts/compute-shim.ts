/**
 * Local compute shim — same HTTP contract as Modal orchestration.
 * Used by Cloudflare wrangler dev / hybrid e2e when Modal credentials are absent.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { access } from "node:fs/promises";
import path from "node:path";
import { GitSandboxManager, type GitAuthor } from "../src/sandbox/git-sandbox.js";
import { OpenCodeBridge } from "../src/agent/opencode-bridge.js";
import { resolveModel } from "../src/agent/models.js";
import type { ComputeDelta } from "../src/compute/client.js";

type Row = {
  id: string;
  repoDir: string;
  branch: string;
  author: GitAuthor;
};

async function main() {
  const port = Number(process.env.COMPUTE_PORT ?? 8790);
  const root = process.env.COMPUTE_ROOT ?? path.join("/tmp", "hatch-inspect-compute");
  const sandboxes = new GitSandboxManager(path.join(root, "sandboxes"));
  await sandboxes.ensureBase();
  const model = resolveModel(process.env.OPENCODE_MODEL, process.env.OPENCODE_PROVIDER);
  const bridge = new OpenCodeBridge({ model });
  await bridge.start();
  const rows = new Map<string, Row>();

  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, backend: "local-shim" }));

  app.post("/v1/sandboxes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      cloneUrl?: string;
      seedFiles?: Record<string, string>;
      author?: GitAuthor;
    };
    const author: GitAuthor = body.author ?? {
      name: "Inspect User",
      email: "user@localhost",
    };
    const sb = await sandboxes.create({
      ...(body.cloneUrl ? { cloneUrl: body.cloneUrl } : {}),
      ...(!body.cloneUrl
        ? {
            seedFiles: body.seedFiles ?? {
              "README.md": "# Hatch Inspect sandbox\n",
              "src/index.ts":
                'export function greet(name: string) {\n  return `hello ${name}`;\n}\n',
            },
          }
        : {}),
    });
    await sandboxes.setAuthor(sb.repoDir, author);
    rows.set(sb.id, {
      id: sb.id,
      repoDir: sb.repoDir,
      branch: sb.branch,
      author,
    });
    return c.json({ id: sb.id, branch: sb.branch, repoDir: sb.repoDir });
  });

  app.delete("/v1/sandboxes/:id", async (c) => {
    const id = c.req.param("id");
    rows.delete(id);
    await sandboxes.destroy(id);
    let diskGone = false;
    try {
      await access(path.join(root, "sandboxes", id));
    } catch {
      diskGone = true;
    }
    return c.json({ ok: true, diskGone });
  });

  app.get("/v1/sandboxes/:id/artifacts", async (c) => {
    const row = rows.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(await sandboxes.artifacts(row.repoDir));
  });

  app.post("/v1/sandboxes/:id/commit", async (c) => {
    const row = rows.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      message?: string;
      author?: GitAuthor;
    };
    const author = body.author ?? row.author;
    const sha = await sandboxes.commitAll(
      row.repoDir,
      body.message ?? "inspect: commit",
      author,
    );
    return c.json({ sha, branch: row.branch });
  });

  app.post("/v1/sandboxes/:id/prompt", async (c) => {
    const row = rows.get(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as {
      text?: string;
      model?: { providerID: string; modelID: string };
    };
    if (!body.text?.trim()) return c.json({ error: "text required" }, 400);
    const oc = body.model
      ? new OpenCodeBridge({ model: body.model })
      : bridge;
    await oc.start();
    const sessionId = await oc.createSession(row.repoDir);

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (d: ComputeDelta) => {
          controller.enqueue(enc.encode(JSON.stringify(d) + "\n"));
        };
        try {
          for await (const delta of oc.runPrompt({
            sessionId,
            directory: row.repoDir,
            text: body.text!.trim(),
          })) {
            if (delta.kind === "text") send({ kind: "text", text: delta.text });
            else if (delta.kind === "tool")
              send({ kind: "tool", name: delta.name, status: delta.status });
            else if (delta.kind === "error") send({ kind: "error", message: delta.message });
            else if (delta.kind === "idle") send({ kind: "idle" });
          }
          send({ kind: "idle" });
        } catch (e) {
          send({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      },
    });
  });

  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.log(`Compute shim (local Modal stand-in) on http://127.0.0.1:${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
