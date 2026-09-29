/**
 * Records Jev on the checkable item bank (src/checkable/bank.json): one call per item, with
 * all of that item's questions batched, exactly the state and questions in the bank.
 *
 * Protocol (fixed before running): items asked in a seeded shuffled order so latency drift is
 * not tied to a kind; one request at a time with a 700 ms gap; a busy reply (429/503) or a
 * network failure is waited out and asked again, and every attempt is logged. The recorded
 * latency is the successful attempt's service latency. A Score the gateway drops is kept as
 * dropped. Weak answers are never re-asked. The truth stays in the bank and is never sent.
 *
 * The log is append-only; rerunning resumes and never re-asks a recorded item.
 *
 *   bun jev-experiments/packages/arena/scripts/record-checkable.ts
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { evaluate, GatewayError } from "../../../experience-prototypes/server/gateway";
import { bankSchema, rng, shuffled } from "../src/checkable/items";

/** Optional: another bank in src/checkable/ and its log name, e.g. judgement-bank.json judgement. */
const BANK = process.argv[2] ?? "bank.json";
const LOG = process.argv[3] ?? "checkable";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const out = new URL(`../recordings/${LOG}.jsonl`, import.meta.url);

const bank = bankSchema.parse(
  JSON.parse(readFileSync(new URL(`../src/checkable/${BANK}`, import.meta.url), "utf8")),
);

const done = new Set<string>();

if (existsSync(out))
  for (const line of readFileSync(out, "utf8").split("\n"))
    if (line.trim()) {
      const row: { id?: unknown; status?: unknown } = JSON.parse(line);

      if (typeof row.id === "string" && row.status === "ok") done.add(row.id);
    }

const todo = shuffled(bank.items, rng(20260926)).filter((i) => !done.has(i.id));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`${bank.items.length} items, ${done.size} recorded, ${todo.length} to ask.`);

let n = 0;

for (const item of todo) {
  let backoff = 2000;

  for (let attempt = 1; ; attempt++) {
    const at = new Date().toISOString();

    try {
      const r = await evaluate(
        { state: item.state, questions: item.questions },
        { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 },
      );

      appendFileSync(
        out,
        `${JSON.stringify({
          id: item.id,
          at,
          attempt,
          status: "ok",
          latencyMs: r.service_latency_ms,
          model: r.model,
          servedBy: r.served_by,
          generationId: r.generation_id,
          answers: r.answers,
          rejected: r.rejected,
          costUsd: r.cost_usd,
        })}\n`,
      );
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;
      const message = error instanceof Error ? error.message : String(error);

      appendFileSync(
        out,
        `${JSON.stringify({ id: item.id, at, attempt, status: "error", code: status, message })}\n`,
      );

      // Busy or unreachable: wait and ask again. Anything else is a real failure; stop.
      if (status !== 429 && status !== 503 && status !== 0) throw error;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  if (++n % 25 === 0) console.log(`${n} / ${todo.length}`);
  await wait(700);
}

console.log("Done.");
