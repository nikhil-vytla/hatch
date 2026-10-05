/**
 * Records Jev's answer for every item × sequence in PROTOCOL.md. It resumes from rows already
 * answered, stops at the spending cap, and stops after 5 failures in a row. Failed rows are
 * recorded as failures and never counted.
 *
 *   bun packages/arena/spine/record.ts --pilot    # 10 requests
 *   bun packages/arena/spine/record.ts            # the rest
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { unpackForAppend } from "../../../experience-prototypes/scripts/records";
import { evaluate, GatewayError, type Payload } from "../../jev-client/src/index";
import { jevCostUsd } from "../../jev-client/src/price";
import { allSequences, ITEMS, requestFor, sequenceId } from "./model";

const CAP_USD = 0.25;
const PILOT = 10;
const CONCURRENCY = 3;

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

// Committed gzipped; unpack the working copy (gitignored) so new rows land after the old ones.
const out = unpackForAppend(new URL("./recordings/spine.jsonl", import.meta.url));

const prior = existsSync(out)
  ? readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];

const done = new Set(prior.filter((r) => r.status === "ok").map((r) => r.id));

let spent = prior.reduce((s, r) => s + (r.status === "ok" && typeof r.costUsd === "number" ? r.costUsd : 0), 0);

type Job = { id: string; request: Payload };

const all: Job[] = ITEMS.flatMap((it) => allSequences().map((pushes) => ({ id: sequenceId(it, pushes), request: requestFor(it, pushes) })));

let jobs = all.filter((j) => !done.has(j.id));

if (process.argv.includes("--pilot")) jobs = jobs.slice(0, PILOT);

let sent = 0;

let failuresInARow = 0;

let stopped = "";

async function one(job: Job) {
  const at = new Date().toISOString();

  try {
    const r = await evaluate(job.request, { apiKey: key ?? "", maxAttempts: 4, deadlineMs: 30_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const costUsd = tokens === null ? null : jevCostUsd(tokens);

    spent += costUsd ?? 0;
    failuresInARow = 0;
    appendFileSync(
      out,
      JSON.stringify({ id: job.id, at, status: "ok", model: r.model, servedBy: r.served_by, generationId: r.generation_id, latencyMs: r.latency_ms, inputTokens: tokens, costUsd, answers: r.answers }) + "\n",
    );
  } catch (e) {
    failuresInARow++;
    appendFileSync(out, JSON.stringify({ id: job.id, at, status: "error", error: e instanceof GatewayError ? e.message : String(e) }) + "\n");
  }
}

async function worker() {
  for (;;) {
    if (stopped) return;

    if (spent >= CAP_USD) {
      stopped = `cap of $${CAP_USD} reached`;

      return;
    }

    if (failuresInARow >= 5) {
      stopped = "5 failures in a row";

      return;
    }

    const job = jobs.shift();

    if (!job) return;

    sent++;
    await one(job);

    if (sent % 100 === 0) console.log(`${sent} sent, $${spent.toFixed(5)} so far`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Sent ${sent}; $${spent.toFixed(5)} in total at list price.${stopped ? ` Stopped: ${stopped}.` : ""}`);
