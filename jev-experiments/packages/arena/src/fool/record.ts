/**
 * Records Jev's answers for every puzzle × sentence (and the referee's for every sentence), so
 * Fool Jev works without a key. One request at a time; resumes from what is already recorded;
 * stops at the request cap. `--pilot` records four requests to check the referee first.
 *
 *   bun packages/arena/src/fool/record.ts [--pilot]
 */
import "../../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  evaluate,
  GatewayError,
  type Payload,
} from "../../../jev-client/src/index";
import { answerRequest, cheatFor, PUZZLES, refereeRequest, sentencesFor } from "./model";
import { jevCostUsd } from "../../../jev-client/src/price";

const CAP = 200;

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const out = new URL("../../recordings/fool.jsonl", import.meta.url);

const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => r.status === "ok")
        .map((r) => r.id)
    : [],
);

type Job = { id: string; request: Payload };

const all: Job[] = PUZZLES.flatMap((p) =>
  sentencesFor(p.id).flatMap((s) => [
    { id: `answer:${p.id}:${s}`, request: answerRequest(p, s) },
    ...(s ? [{ id: `referee:${p.id}:${s}`, request: refereeRequest(p, s) }] : []),
  ]),
);

const madrid = PUZZLES[0];

const jobs = process.argv.includes("--pilot")
  ? all.filter((j) =>
      [
        `referee:${madrid.id}:Most people say no.`,
        `referee:${madrid.id}:${cheatFor(madrid.id)}`,
        `referee:${madrid.id}:It's raining in London.`,
        `referee:${madrid.id}:I'm pretty sure the answer is no.`,
        `referee:capital:${cheatFor("capital")}`,
        `referee:capital:I'm pretty sure the answer is no.`,
        `answer:${madrid.id}:Most people say no.`,
      ].includes(j.id),
    )
  : all;

let sent = 0;

let cost = 0;

for (const job of jobs) {
  if (done.has(job.id)) continue;

  if (sent >= CAP) {
    console.log(`Stopped at the cap of ${CAP} requests.`);
    break;
  }

  sent++;

  const at = new Date().toISOString();

  try {
    const r = await evaluate(job.request, { apiKey: key, maxAttempts: 3, deadlineMs: 20_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const costUsd = tokens === null ? null : jevCostUsd(tokens);

    cost += costUsd ?? 0;
    appendFileSync(
      out,
      JSON.stringify({
        id: job.id,
        at,
        status: "ok",
        model: r.model,
        servedBy: r.served_by,
        generationId: r.generation_id,
        latencyMs: r.latency_ms,
        inputTokens: tokens,
        costUsd,
        answers: r.answers,
      }) + "\n",
    );
  } catch (e) {
    appendFileSync(
      out,
      JSON.stringify({
        id: job.id,
        at,
        status: "error",
        error: e instanceof GatewayError ? e.message : String(e),
      }) + "\n",
    );
  }
}

console.log(`Sent ${sent} requests, list-price cost $${cost.toFixed(5)}.`);
