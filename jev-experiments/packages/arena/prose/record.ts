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
 *   bun jev-experiments/packages/arena/prose/record.ts [limit]
 */
import "../../../experience-prototypes/scripts/credentials";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { evaluate, GatewayError } from "../../../experience-prototypes/server/gateway";
import { rng, shuffled } from "../src/checkable/items";
import { allJobs } from "./variants";
import { jevCostUsd } from "../src/jev-price";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const MAX_COST_USD = 1.0;
const MAX_OK = 5000;
const out = new URL("./recordings/prose.jsonl", import.meta.url);
const pilot = new URL("./recordings/pilot.jsonl", import.meta.url);
const limit = Number(process.argv[2] ?? Infinity);

type Row = { id?: string; status?: string; costUsd?: number | null; inputTokens?: number | null };

const rows = (url: URL): Row[] =>
  existsSync(url)
    ? readFileSync(url, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
const prior = [...rows(pilot), ...rows(out)];
// A rejected Score is a final answer (never re-asked), like a weak answer.
const done = new Set(rows(out).filter((r) => r.status === "ok" || r.status === "rejected").map((r) => r.id!));
let spent = prior.reduce((s, r) => s + (r.costUsd ?? 0), 0);
let tokens = prior.reduce((s, r) => s + (r.inputTokens ?? (r as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? 0), 0);
let ok = prior.filter((r) => r.status === "ok").length;

const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const jobs = allJobs();
const todo = shuffled(jobs, rng(20260929)).filter((j) => !done.has(j.id));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(
  `${jobs.length} requests, ${done.size} recorded, ${todo.length} to ask. Spent so far $${spent.toFixed(6)}, ${tokens} input tokens, ${ok} ok.`,
);

let asked = 0;

for (const job of todo) {
  if (asked >= limit) break;

  // Largest request is ~2.5 KB; assume at most 2,000 input tokens for the next one.
  const worst = jevCostUsd(2000);

  if (spent + worst > MAX_COST_USD || ok + 1 > MAX_OK) {
    console.log(`Budget reached: $${spent.toFixed(6)}, ${ok} ok. Stopping.`);
    break;
  }

  let backoff = 2000;

  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString();

    try {
      const r = await evaluate(job.request, { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 });
      const inputTokens = r.usage?.input_tokens ?? null;

      // Unknown cost is budgeted at the list price for the reported tokens (or 2,000 tokens).
      spent += r.cost_usd ?? jevCostUsd(inputTokens ?? 2000);
      tokens += inputTokens ?? 0;
      ok++;
      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "ok", latencyMs: r.service_latency_ms, model: r.model, servedBy: r.served_by, generationId: r.generation_id, inputTokens, costUsd: r.cost_usd, requestHash: hash(job.request), answers: r.answers, rejected: r.rejected })}\n`,
      );
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);
      const costUsd = error instanceof GatewayError ? (error.accounting.costUsd ?? null) : null;

      spent += costUsd ?? 0;

      // A request whose only question is a Score the gateway rejects comes back as a 502 with
      // this code. It is an answer, not a busy reply: log it as rejected and move on.
      if (error instanceof GatewayError && error.code === "native_score_mismatch") {
        appendFileSync(
          out,
          `${JSON.stringify({ id: job.id, at, attempt, status: "rejected", code: status, message, costUsd, requestHash: hash(job.request) })}\n`,
        );
        break;
      }

      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "error", code: status, message, costUsd })}\n`,
      );

      if (status !== 429 && status !== 503 && status !== 0) throw error;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  asked++;
  if (asked % 100 === 0)
    console.log(`${asked} asked this run, ${ok} ok in total, $${spent.toFixed(6)}, ${tokens} input tokens.`);
  await wait(700);
}

console.log(`Done this run: ${asked} asked. Total $${spent.toFixed(6)}, ${tokens} input tokens, ${ok} ok.`);
