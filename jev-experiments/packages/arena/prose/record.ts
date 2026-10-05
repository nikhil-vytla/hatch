/**
 * Records Jev on every prose-study request (`variants.ts`). Same protocol as
 * scripts/record-decide.ts: a seeded shuffled order, one request at a time with a 700 ms gap,
 * busy replies (429/503) and network failures waited out with doubling backoff and every
 * attempt logged, weak answers never re-asked. Truths are never sent. Append-only and
 * resumable.
 *
 * Hard budget: stops before the cumulative reported cost would pass $1.00 or successful
 * requests would pass 5,000 (the pilot's two requests count).
 *
 *   bun jev-experiments/packages/arena/prose/record.ts [limit] [--dry-run]
 */
import { createHash } from "node:crypto";
import { GatewayError, jevCostUsd } from "../../jev-client/src/index";
import { jevEndpoint, type JevResult, type Reply } from "../../jev-client/src/endpoints";
import { readRows } from "../../jev-client/src/recordings";
import { record, recorderKey, statusOf, waitOutBusy, type Attempt, type Job } from "../../jev-client/src/recorder";
import { mulberry32, shuffled } from "../../seeded/src/index";
import { allJobs } from "./variants";

const MAX_COST_USD = 1.0;
const MAX_OK = 5000;
export const out = new URL("./recordings/prose.jsonl", import.meta.url);
const pilot = new URL("./recordings/pilot.jsonl", import.meta.url);

const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

/** Every prose request, in the recording's seeded order. */
export const jobs = (): Job[] => shuffled(allJobs(), mulberry32(20260929)).map((j) => ({ id: j.id, request: j.request }));

/** A Score the gateway rejects (a 502 with this code) is an answer, never re-asked. */
const rejectedScore = (e: unknown) => e instanceof GatewayError && e.code === "native_score_mismatch";
const errorCost = (e: unknown) => (e instanceof GatewayError ? (e.accounting.costUsd ?? null) : null);

export function okRow(job: Job, reply: Reply<JevResult>, { at, attempt }: Attempt) {
  const r = reply.raw!;

  return { id: job.id, at, attempt, status: "ok", latencyMs: r.service_latency_ms, model: r.model, servedBy: r.served_by, generationId: r.generation_id, inputTokens: r.usage?.input_tokens ?? null, costUsd: r.cost_usd, requestHash: hash(job.request), answers: r.answers, rejected: r.rejected };
}

export function errorRow(job: Job, e: unknown, { at, attempt }: Attempt) {
  const code = statusOf(e);
  const message = e instanceof Error ? e.message : String(e);

  return rejectedScore(e)
    ? { id: job.id, at, attempt, status: "rejected", code, message, costUsd: errorCost(e), requestHash: hash(job.request) }
    : { id: job.id, at, attempt, status: "error", code, message, costUsd: errorCost(e) };
}

if (import.meta.main) {
  await import("../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const limit = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? Infinity);
  const prior = [...readRows(pilot), ...readRows(out)];
  const all = jobs();
  let tokens = prior.reduce((s, r) => s + (r.inputTokens ?? (r as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? 0), 0);
  const okBefore = prior.filter((r) => r.status === "ok").length;
  const spentBefore = prior.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  let asked = 0;

  const result = await record(all, jevEndpoint({ apiKey, maxAttempts: 1, deadlineMs: 20_000 }), {
    out,
    dryRun,
    prior: readRows(out),
    // A rejected Score is a final answer (never re-asked), like a weak answer.
    done: (r) => r.status === "ok" || r.status === "rejected",
    limit,
    maxUsd: MAX_COST_USD,
    spentUsd: spentBefore,
    // Largest request is ~2.5 KB; assume at most 2,000 input tokens for the next one.
    worstUsd: () => jevCostUsd(2000),
    stop: (s) => (okBefore + s.ok + 1 > MAX_OK ? `${okBefore + s.ok} ok` : null),
    // Unknown cost is budgeted at the list price for the reported tokens (or 2,000 tokens).
    spend: (reply) => {
      tokens += reply.raw!.usage?.input_tokens ?? 0;

      return reply.raw!.cost_usd ?? jevCostUsd(reply.raw!.usage?.input_tokens ?? 2000);
    },
    errorSpend: (e) => errorCost(e) ?? 0,
    settles: rejectedScore,
    failFast: Infinity,
    retry: waitOutBusy,
    gapMs: 700,
    okRow,
    errorRow,
    onJob: (s) => {
      if (++asked % 100 === 0) console.log(`${asked} asked this run, ${okBefore + s.ok} ok in total, $${s.spentUsd.toFixed(6)}, ${tokens} input tokens.`);
    },
  });

  if (!dryRun) {
    if (result.stopped) console.log(`Budget reached (${result.stopped}). Stopping.`);
    console.log(`Done this run: ${asked} asked. Total $${(spentBefore + result.spentUsd).toFixed(6)}, ${tokens} input tokens, ${okBefore + result.ok} ok.`);
  }
}
