/**
 * The recorder: sends a list of jobs (id → request) to an endpoint and appends one JSONL row per
 * attempt. It owns what guards real money, in one place: resume from what is already answered,
 * the spend cap, the failure streak, retry of busy replies, dry runs and the run's receipt.
 *
 * A recorder script is a list of jobs plus its caps, and optionally its own row shape:
 *
 *   const result = await record(jobs, jevEndpoint({ apiKey: requireKey() }), { out, maxUsd: 0.25 });
 *
 * Rows: by default { id, at, status, latencyMs, inputTokens, costUsd, servedBy, model, endpoint,
 * answers } (or { id, at, status: "error", code, message, endpoint }). Recorders whose committed
 * recordings use another shape pass `okRow` / `errorRow`, so the format on disk never changes.
 * Reading recordings back (rows, latest answer per id, receipts, the .gz rule) is ./recordings.ts.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Endpoint, JevResult, Reply } from "./endpoints.js";
import { GatewayError } from "./gateway.js";
import { jevCostUsd } from "./price.js";
import { isOk, latestById, readRows, unpackForAppend, type RecordedRow } from "./recordings.js";
import type { Payload } from "./wire.js";

export type Job<Q = Payload> = { id: string; request: Q };

/** The recorders' key check, in one place. */
export function requireKey(env: Record<string, string | undefined> = process.env, message = "Set AI_GATEWAY_API_KEY to record."): string {
  const key = env.AI_GATEWAY_API_KEY;

  if (!key) throw Error(message);

  return key;
}

/** For a recorder script: `--dry-run` lists the jobs and needs no key; otherwise the key is required. */
export function recorderKey(argv = process.argv): { dryRun: boolean; apiKey: string } {
  const dryRun = argv.includes("--dry-run");

  return { dryRun, apiKey: dryRun ? "" : requireKey() };
}

/** The list price of a Jev answer's input tokens, or null when the gateway reported none. */
export const listPrice = (r: JevResult) => {
  const tokens = r.usage?.input_tokens ?? null;

  return tokens === null ? null : jevCostUsd(tokens);
};

/**
 * The row most Jev recorders write for an answer: { id, ...extra, at, status, model, servedBy,
 * generationId, latencyMs, inputTokens, costUsd (list price), answers }.
 */
export function jevRow(job: { id: string }, reply: Reply<JevResult>, { at }: Attempt, extra: object = {}) {
  const r = reply.raw!;

  return {
    id: job.id,
    ...extra,
    at,
    status: "ok",
    model: r.model,
    servedBy: r.served_by,
    generationId: r.generation_id,
    latencyMs: r.latency_ms,
    inputTokens: r.usage?.input_tokens ?? null,
    costUsd: listPrice(r),
    answers: r.answers,
  };
}

/** …and for a failure: { id, ...extra, at, status: "error", error }. */
export const jevErrorRow = (job: { id: string }, e: unknown, { at }: Attempt, extra: object = {}) => ({
  id: job.id,
  ...extra,
  at,
  status: "error",
  error: e instanceof GatewayError ? e.message : String(e),
});

/**
 * The row of recorders that log every attempt (checkable, decide, one-box): { ...head, at,
 * attempt, status, latencyMs (the service's), model, servedBy, generationId, answers, rejected,
 * costUsd (as reported) }. `head` is { id } unless the recording keys rows another way.
 */
export function attemptRow(job: { id: string }, reply: Reply<JevResult>, { at, attempt }: Attempt, head: object = { id: job.id }) {
  const r = reply.raw!;

  return { ...head, at, attempt, status: "ok", latencyMs: r.service_latency_ms, model: r.model, servedBy: r.served_by, generationId: r.generation_id, answers: r.answers, rejected: r.rejected, costUsd: r.cost_usd };
}

/** …and for a failed attempt: { ...head, at, attempt, status: "error", code, message }. */
export const attemptErrorRow = (job: { id: string }, e: unknown, { at, attempt }: Attempt, head: object = { id: job.id }) => ({
  ...head,
  at,
  attempt,
  status: "error",
  code: statusOf(e),
  message: e instanceof Error ? e.message : String(e),
});

/** The HTTP status an error carries (GatewayError, EndpointError), or 0 for a network failure. */
export const statusOf = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status;

  return typeof status === "number" ? status : 0;
};

/**
 * What to do after a failed attempt: wait this many ms and ask again, record it and go to the
 * next job, or record it and stop the run by rethrowing.
 */
export type Retry = (error: unknown, attempt: number) => number | "next" | "throw";

/** Busy or rate limited (429/503): ask again after 2 s, then 4 s; anything else, the next job. */
export const retryBusy =
  (attempts = 3): Retry =>
  (e, attempt) =>
    (statusOf(e) === 429 || statusOf(e) === 503) && attempt < attempts ? 1000 * 2 ** attempt : "next";

/**
 * Patient: wait out busy replies and network failures (429, 503, no response) with doubling
 * backoff from 2 s to 30 s, as often as it takes; any other failure is real and stops the run.
 */
export const waitOutBusy: Retry = (e, attempt) =>
  [429, 503, 0].includes(statusOf(e)) ? Math.min(30_000, 2000 * 2 ** (attempt - 1)) : "throw";

/** No retry here (the endpoint retries, or a failure is final): record it, next job. */
export const noRetry: Retry = () => "next";

export type RunState = {
  /** Jobs to ask this run (after skipping answered ones and the limit). */
  todo: number;
  /** Jobs started this run. */
  jobs: number;
  /** Requests sent this run (attempts). */
  sent: number;
  ok: number;
  errors: number;
  /** Failures in a row, reset by an answer. */
  streak: number;
  /** Spend so far, starting from `spentUsd`. */
  spentUsd: number;
  /** The largest single spend this run. */
  largestUsd: number;
};

export type Attempt = { at: string; attempt: number };

export type RecordOptions<J extends Job<Q>, Q = Payload, R = unknown> = {
  out: string | URL;
  dryRun?: boolean;
  /** Skip jobs already answered in `out` (default true). */
  resume?: boolean;
  /** Rows that count as answered (default: status "ok"). */
  done?: (row: RecordedRow) => boolean;
  /** A row's job id (default `row.id`). */
  idOf?: (row: RecordedRow) => string;
  /** Whether a job is already answered, given the latest answered row per id (default: has its id). */
  skip?: (job: J, answered: Map<string, RecordedRow>) => boolean;
  /** Rows to resume from, if not `out`'s. */
  prior?: RecordedRow[];
  /** At most this many jobs this run (after skipping answered ones). */
  limit?: number;

  /** Stop before spend passes this cap. */
  maxUsd?: number;
  /** Spend recorded before this run (default 0). */
  spentUsd?: number;
  /**
   * The most the next job could cost. With it, a job that could take spend past `maxUsd` is not
   * sent; without it, the run stops once spend has reached `maxUsd`.
   */
  worstUsd?: (job: J, state: RunState) => number;
  /** What an answer adds to spend (default: the reported cost, else its tokens at list price). */
  spend?: (reply: Reply<R>, job: J, worstUsd: number) => number;
  /** What a failure adds to spend (default 0). */
  errorSpend?: (error: unknown) => number;
  /** Any other stop rule, checked before each job: a reason to stop, or null. */
  stop?: (state: RunState, job: J) => string | null;

  /** Failures in a row that stop the run (default 5). */
  failFast?: number;
  /** Whether a failure counts toward the streak (default true). */
  failCounts?: (error: unknown) => boolean;
  retry?: Retry;
  /** A failure that is an answer (e.g. a rejected Score): record it, no retry, not a failure. */
  settles?: (error: unknown) => boolean;

  /** Requests in flight at once (default 1). */
  concurrency?: number;
  /** Pause after each job, in ms (default 0). */
  gapMs?: number;

  okRow?: (job: J, reply: Reply<R>, at: Attempt & { costUsd: number }) => object;
  /** The row for a failure, or null to log nothing. */
  errorRow?: (job: J, error: unknown, at: Attempt) => object | null;

  log?: (line: string) => void;
  /** Called once before sending, with how many jobs will be asked and how many were already answered. */
  onStart?: (todo: number, skipped: number) => void;
  /** Called after each job, e.g. for progress lines. */
  onJob?: (state: RunState, job: J) => void;
  wait?: (ms: number) => Promise<void>;
};

export type RunResult = {
  sent: number;
  ok: number;
  errors: number;
  skipped: number;
  spentUsd: number;
  stopped: string | null;
  /** The latest answered row per id, from before and during this run. */
  answered: Map<string, RecordedRow>;
};

/** A cautious token estimate before sending: ~3 characters per token plus prompt overhead. */
export const estimateTokens = (job: { request: unknown }) => Math.ceil(JSON.stringify(job.request).length / 3) + 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function record<J extends Job<Q>, Q = Payload, R = unknown>(
  jobs: J[],
  ep: Endpoint<Q, R>,
  opts: RecordOptions<J, Q, R>,
): Promise<RunResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const wait = opts.wait ?? sleep;
  const path = opts.out instanceof URL ? fileURLToPath(opts.out) : opts.out;
  // Appending to a gzipped recording goes to its unpacked working copy, after the old rows.
  const out = opts.dryRun ? path : unpackForAppend(path);
  const idOf = opts.idOf ?? ((r: RecordedRow) => r.id);
  const answered = latestById(opts.resume === false ? [] : (opts.prior ?? readRows(out)), opts.done ?? isOk, idOf);
  const skip = opts.skip ?? ((j: J, a: Map<string, RecordedRow>) => a.has(j.id));
  const todo = jobs.filter((j) => !skip(j, answered)).slice(0, opts.limit ?? Infinity);
  const state: RunState = { todo: todo.length, jobs: 0, sent: 0, ok: 0, errors: 0, streak: 0, spentUsd: opts.spentUsd ?? 0, largestUsd: 0 };
  const result: RunResult = { sent: 0, ok: 0, errors: 0, skipped: jobs.length - todo.length, spentUsd: 0, stopped: null, answered };
  const estimate = (j: J) => (estimateTokens(j) * ep.usdPerMTok) / 1e6;
  const spend =
    opts.spend ?? ((r: Reply<R>, _j: J, worst: number) => r.costUsd ?? (r.inputTokens !== null ? (r.inputTokens * ep.usdPerMTok) / 1e6 : worst));
  const failFast = opts.failFast ?? 5;
  const retry = opts.retry ?? retryBusy(3);
  const okRow =
    opts.okRow ??
    ((j: J, r: Reply<R>, a: Attempt & { costUsd: number }) => ({
      id: j.id,
      at: a.at,
      status: "ok",
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens,
      costUsd: a.costUsd,
      servedBy: r.servedBy,
      model: r.model,
      endpoint: ep.label,
      answers: r.answers,
    }));
  const errorRow =
    opts.errorRow ??
    ((j: J, e: unknown, a: Attempt) => ({
      id: j.id,
      at: a.at,
      status: "error",
      code: statusOf(e),
      message: e instanceof Error ? e.message : String(e),
      endpoint: ep.label,
    }));
  const append = (row: object | null) => {
    if (row) appendFileSync(out, `${JSON.stringify(row)}\n`);
  };
  const finish = () => Object.assign(result, { sent: state.sent, ok: state.ok, errors: state.errors, spentUsd: state.spentUsd - (opts.spentUsd ?? 0) });

  if (opts.dryRun) {
    const tokens = todo.reduce((s, j) => s + estimateTokens(j), 0);

    for (const j of todo) log(JSON.stringify({ id: j.id, endpoint: ep.label, request: j.request }));

    log(`dry run: ${todo.length} requests, about ${tokens.toLocaleString("en")} input tokens, at most $${((tokens * ep.usdPerMTok) / 1e6).toFixed(6)} on ${ep.label}. Nothing was sent.`);

    return result;
  }

  const stopBefore = (job: J): string | null => {
    if (state.streak >= failFast) return `${state.streak} failures in a row`;

    if (opts.maxUsd !== undefined) {
      if (opts.worstUsd) {
        const worst = opts.worstUsd(job, state);

        if (state.spentUsd + worst > opts.maxUsd)
          return `budget: $${state.spentUsd.toFixed(6)} spent, next request could cost $${worst.toFixed(6)}, cap $${opts.maxUsd}`;
      } else if (state.spentUsd >= opts.maxUsd) return `budget: $${state.spentUsd.toFixed(6)} spent, cap $${opts.maxUsd}`;
    }

    return opts.stop?.(state, job) ?? null;
  };

  /** One job: its attempts until answered, settled, given up on or stopped. False stops the run. */
  async function one(job: J): Promise<boolean> {
    const worst = opts.worstUsd ? opts.worstUsd(job, state) : estimate(job);

    for (let attempt = 1; ; attempt++) {
      const at = new Date().toISOString();

      state.sent++;

      try {
        const reply = await ep.ask(job.request);
        const costUsd = spend(reply, job, worst);
        const row = okRow(job, reply, { at, attempt, costUsd });

        state.spentUsd += costUsd;
        state.largestUsd = Math.max(state.largestUsd, costUsd);
        state.ok++;
        state.streak = 0;
        append(row);
        answered.set(job.id, row as RecordedRow);

        return true;
      } catch (e) {
        state.spentUsd += opts.errorSpend?.(e) ?? 0;

        if (opts.settles?.(e)) {
          append(errorRow(job, e, { at, attempt }));

          return true;
        }

        const next = retry(e, attempt);

        state.errors++;
        if (opts.failCounts?.(e) ?? true) state.streak++;
        append(errorRow(job, e, { at, attempt }));

        if (next === "throw") throw e;

        if (state.streak >= failFast) {
          result.stopped = `${state.streak} failures in a row (last: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)})`;

          return false;
        }

        if (next === "next") return true;

        await wait(next);
      }
    }
  }

  opts.onStart?.(todo.length, result.skipped);

  const queue = [...todo];

  async function worker() {
    for (;;) {
      if (result.stopped) return;

      const job = queue.shift();

      if (!job) return;

      const reason = stopBefore(job);

      if (reason) {
        result.stopped ??= reason;

        return;
      }

      state.jobs++;

      if (!(await one(job))) return;

      opts.onJob?.(state, job);

      if (opts.gapMs) await wait(opts.gapMs);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, worker));
  } finally {
    finish();
  }

  return result;
}
