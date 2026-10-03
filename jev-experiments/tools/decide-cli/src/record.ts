/**
 * PROTOTYPE. Sends a study's requests one at a time and appends one JSONL row per attempt, in the
 * same row shape as packages/arena/prose/recordings (id, at, status, latencyMs, inputTokens,
 * costUsd, answers, ...). Resumable, capped and fail-fast.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { EndpointError, type Endpoint, type Reply } from "./endpoints";
import type { Job } from "./studies";

export type Row = {
  id: string;
  at: string;
  status: "ok" | "error";
  latencyMs?: number;
  inputTokens?: number | null;
  costUsd?: number | null;
  servedBy?: string | null;
  model?: string | null;
  endpoint?: string;
  answers?: Reply["answers"];
  code?: number;
  message?: string;
};

/** Rows from a .jsonl or .jsonl.gz recording (ours or one `eval` wrote). */
export function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];

  const buf = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");

  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** A cautious token estimate before sending: ~3 characters per token plus prompt overhead. */
export const estimateTokens = (job: Job) => Math.ceil(JSON.stringify(job.request).length / 3) + 400;

export type RunOptions = {
  out: string;
  dryRun?: boolean;
  maxUsd?: number;
  resume?: boolean;
  limit?: number;
  /** Consecutive failures that stop the run (a dead server shouldn't log hundreds of errors). */
  failFast?: number;
  log?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
};

export type RunResult = { sent: number; ok: number; errors: number; skipped: number; spentUsd: number; stopped: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(jobs: Job[], ep: Endpoint, opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const done = new Set(opts.resume ? readRows(opts.out).filter((r) => r.status === "ok").map((r) => r.id) : []);
  const todo = jobs.filter((j) => !done.has(j.id)).slice(0, opts.limit ?? Infinity);
  const result: RunResult = { sent: 0, ok: 0, errors: 0, skipped: jobs.length - todo.length, spentUsd: 0, stopped: null };

  if (opts.dryRun) {
    const tokens = todo.reduce((s, j) => s + estimateTokens(j), 0);

    for (const j of todo) log(JSON.stringify({ id: j.id, endpoint: ep.label, request: j.request }));

    log(`dry run: ${todo.length} requests, about ${tokens.toLocaleString("en")} input tokens, at most $${((tokens * ep.usdPerMTok) / 1e6).toFixed(6)} on ${ep.label}. Nothing was sent.`);

    return result;
  }

  let streak = 0;

  for (const job of todo) {
    const worst = (estimateTokens(job) * ep.usdPerMTok) / 1e6;

    if (opts.maxUsd !== undefined && result.spentUsd + worst > opts.maxUsd) {
      result.stopped = `budget: $${result.spentUsd.toFixed(6)} spent, next request could cost $${worst.toFixed(6)}, cap $${opts.maxUsd}`;
      break;
    }

    for (let attempt = 1; ; attempt++) {
      const at = new Date().toISOString();

      result.sent++;

      try {
        const r = await ep.ask(job.request);
        const costUsd = r.costUsd ?? (r.inputTokens !== null ? (r.inputTokens * ep.usdPerMTok) / 1e6 : worst);

        result.spentUsd += costUsd;
        result.ok++;
        streak = 0;
        appendFileSync(opts.out, `${JSON.stringify({ id: job.id, at, status: "ok", latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd, servedBy: r.servedBy, model: r.model, endpoint: ep.label, answers: r.answers } satisfies Row)}\n`);
        break;
      } catch (e) {
        const code = e instanceof EndpointError ? e.status : 0;
        const message = e instanceof Error ? e.message : String(e);

        result.errors++;
        streak++;
        appendFileSync(opts.out, `${JSON.stringify({ id: job.id, at, status: "error", code, message, endpoint: ep.label } satisfies Row)}\n`);

        if (streak >= (opts.failFast ?? 5)) {
          result.stopped = `${streak} failures in a row (last: ${message.slice(0, 120)})`;

          return result;
        }

        // Busy or rate limited: wait and retry this request. Anything else: next request.
        if ((code === 429 || code === 503) && attempt < 3) {
          await (opts.wait ?? sleep)(1000 * 2 ** attempt);
          continue;
        }

        break;
      }
    }
  }

  return result;
}

const pct = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : NaN);

/** The receipt for a recording: calls, tokens, cost, latency percentiles. */
export function receipt(rows: Row[]) {
  const ok = rows.filter((r) => r.status === "ok");
  const lat = ok.map((r) => r.latencyMs ?? NaN).filter(Number.isFinite).sort((a, b) => a - b);

  return {
    attempts: rows.length,
    ok: ok.length,
    errors: rows.length - ok.length,
    inputTokens: ok.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    latencyMs: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99) },
    endpoints: [...new Set(ok.map((r) => r.endpoint ?? r.servedBy ?? "unknown"))],
  };
}

export function receiptLine(rows: Row[]) {
  const r = receipt(rows);

  return `${r.ok} ok of ${r.attempts} attempts · ${r.inputTokens.toLocaleString("en")} input tokens · $${r.costUsd.toFixed(6)} · p50 ${r.latencyMs.p50} ms · p90 ${r.latencyMs.p90} ms · p99 ${r.latencyMs.p99} ms`;
}
