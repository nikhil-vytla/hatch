/**
 * Feasibility pilot, run before the protocol was frozen: does the gateway accept a plain-string
 * state and an empty-object state? Two requests, excluded from every analysis.
 *
 *   bun jev-experiments/packages/arena/prose/pilot.ts
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync } from "node:fs";
import { evaluate, GatewayError, type Payload } from "../../jev-client/src/index";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const out = new URL("./recordings/pilot.jsonl", import.meta.url);
const jobs: { id: string; request: Payload }[] = [
  {
    id: "pilot:string-state",
    request: {
      state: "Aria has a cat named Juniper.",
      questions: { q: { type: "noul", instructions: "Does Aria own a pet?" } },
    },
  },
  {
    id: "pilot:empty-state",
    request: { state: {}, questions: { q: { type: "noul", instructions: "Is water wet?" } } },
  },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const job of jobs) {
  let backoff = 2000;

  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString();

    try {
      const r = await evaluate(job.request, { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 });

      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "ok", latencyMs: r.service_latency_ms, servedBy: r.served_by, generationId: r.generation_id, usage: r.usage, costUsd: r.cost_usd, answers: r.answers })}\n`,
      );
      console.log(job.id, "ok", JSON.stringify(r.answers), r.usage, r.cost_usd, r.served_by);
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;

      appendFileSync(
        out,
        `${JSON.stringify({ id: job.id, at, attempt, status: "error", code: status, message: error instanceof Error ? error.message : String(error) })}\n`,
      );
      console.log(job.id, "error", status);
      if (status !== 429 && status !== 503 && status !== 0) break;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  await wait(700);
}
