// UNTESTED SKETCH of the prototype's cell model on celld itself. One Durable Object (a celld cell) is the kernel: it
// holds the catalogue in its own SQLite, which celld replicates (LTX) to the bucket, so the agent's self-written tools
// survive the loss of a node, not just of a process. Each agent-written tool is loaded by the Worker Loader under its
// immutable version id and runs as a facet whose SQLite is keyed by the tool's name, so state outlives code versions.
//
// What is left out: the agent loop itself. pi-durable's portable SQLite storage core is documented to run in a Durable
// Object given an async SqliteDatabase facade over `ctx.storage.sql`; that harness would live in this same object.
import { DurableObject } from "cloudflare:workers";

const CELL_PRELUDE = `
  import { DurableObject } from "cloudflare:workers";
  export class Cell extends DurableObject {
    async fetch(request) {
      const { args, callId } = await request.json();
      const kv = this.ctx.storage.kv;
      // Exactly-once, as in the prototype: the call id is written with the effects.
      const seen = kv.get("call:" + callId);
      if (seen !== undefined) return Response.json(seen);
      const value = await (async (args, kv) => { BODY })(args, {
        get: (k) => kv.get("v:" + k) ?? null, put: (k, v) => kv.put("v:" + k, v),
        delete: (k) => kv.delete("v:" + k), keys: () => [...kv.list({ prefix: "v:" }).keys()].map((k) => k.slice(2)),
      });
      kv.put("call:" + callId, value ?? null);
      return Response.json(value ?? null);
    }
  }`;

export class Forge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cells (name TEXT PRIMARY KEY, live TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS versions (version TEXT PRIMARY KEY, name TEXT, source TEXT, checks TEXT)");
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : {};
    if (url.pathname === "/call") return Response.json(await this.call(body.name, body.args, body.callId));
    if (url.pathname === "/propose") return Response.json(await this.propose(body.name, body.version, body.source, body.checks));
    return new Response("POST /call {name,args,callId} or /propose {name,version,source,checks}\n", { status: 404 });
  }

  // The tool an agent-written cell exposes: load its live version, run it as the facet named after the cell.
  async call(name, args, callId) {
    const row = this.ctx.storage.sql.exec("SELECT v.version, v.source FROM cells c JOIN versions v ON v.version = c.live WHERE c.name = ?", name).one();
    const worker = this.env.LOADER.get(row.version, () => ({
      compatibilityDate: "2025-01-01",
      mainModule: "cell.js",
      modules: { "cell.js": CELL_PRELUDE.replace("BODY", row.source) },
    }));
    const facet = this.ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Cell") }));
    const res = await facet.fetch("http://cell/", { method: "POST", body: JSON.stringify({ args, callId }) });
    return res.json();
  }

  // The gate would run checks in a throwaway facet (a fresh name per verification) before flipping `live`.
  async propose(name, version, source, checks) {
    const scratch = `verify:${version}:${crypto.randomUUID()}`;
    const worker = this.env.LOADER.get(version, () => ({ compatibilityDate: "2025-01-01", mainModule: "cell.js", modules: { "cell.js": CELL_PRELUDE.replace("BODY", source) } }));
    const facet = this.ctx.facets.get(scratch, () => ({ class: worker.getDurableObjectClass("Cell") }));
    for (const [i, c] of checks.entries()) {
      const got = await (await facet.fetch("http://cell/", { method: "POST", body: JSON.stringify({ args: c.args, callId: `check-${i}` }) })).json();
      if (JSON.stringify(got) !== JSON.stringify(c.expect)) return { ok: false, check: i, got };
    }
    this.ctx.facets.delete?.(scratch); // whether facets can be deleted is an open question for celld
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO versions VALUES (?, ?, ?, ?)", version, name, source, JSON.stringify(checks));
    this.ctx.storage.sql.exec("INSERT INTO cells VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET live = excluded.live", name, version);
    return { ok: true };
  }
}

export default {
  fetch(request, env) {
    return env.FORGE.getByName("only").fetch(request);
  },
};
