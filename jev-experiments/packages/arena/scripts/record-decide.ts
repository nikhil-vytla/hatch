/**
 * Records Jev on Decide's deck (src/decide/deck.ts): one request per decision and setup, the
 * exact request the page shows. Same protocol as record-checkable.ts: a seeded shuffled order,
 * one request at a time with a 700 ms gap, busy replies waited out and every attempt logged,
 * weak answers never re-asked. Truths are never sent. Append-only and resumable.
 *
 *   bun jev-experiments/packages/arena/scripts/record-decide.ts
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { evaluate, GatewayError } from "../../../experience-prototypes/server/gateway";
import { rng, shuffled } from "../src/checkable/items";
import { DECK, requestFor } from "../src/decide/deck";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const out = new URL("../recordings/decide.jsonl", import.meta.url);
const done = new Set<string>();

if (existsSync(out))
  for (const line of readFileSync(out, "utf8").split("\n"))
    if (line.trim()) {
      const row: { id?: unknown; status?: unknown } = JSON.parse(line);

      if (typeof row.id === "string" && row.status === "ok") done.add(row.id);
    }

const jobs = DECK.flatMap((d) =>
  d.setups.map((s) => ({ id: `${d.id}:${s.id}`, request: requestFor(d, s) })),
);
const todo = shuffled(jobs, rng(20260928)).filter((j) => !done.has(j.id));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`${jobs.length} requests, ${done.size} recorded, ${todo.length} to ask.`);

for (const job of todo) {
  let backoff = 2000;

  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString();

    try {
      const r = await evaluate(job.request, { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 });

      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "ok", latencyMs: r.service_latency_ms, model: r.model, servedBy: r.served_by, generationId: r.generation_id, answers: r.answers, rejected: r.rejected, costUsd: r.cost_usd })}\n`,
      );
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);

      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "error", code: status, message })}\n`,
      );

      if (status !== 429 && status !== 503 && status !== 0) throw error;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  await wait(700);
}

console.log("Done.");
