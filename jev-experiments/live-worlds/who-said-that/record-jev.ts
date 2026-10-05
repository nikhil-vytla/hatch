/**
 * Records Jev's answers to the three text questions for every line of every published scenario,
 * and the two whole-transcript count questions, so the page can show a recorded Jev lane. Jev only
 * sees the recognised words; voice, loudness and microphone stay with code.
 *
 *   bun live-worlds/who-said-that/record-jev.ts [--pilot]
 *
 * One request at a time, resuming from recordings/jev.jsonl. Stops at the spending cap (list
 * price; `--cap <usd>` also caps this run) or after five failures in a row. A line is asked again
 * when its request has changed (re-recorded signals). `--pilot` sends the first 10 requests only. Writes
 * experience-prototypes/public/who-said-that/<id>.jev.json for the page.
 *
 * Evaluation only: these answers are shown, never trained on (TypeSafe MCA §2.3(b)).
 */
import "../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluate, GatewayError, type Payload } from "../../packages/jev-client/src/index";
import { jevCostUsd } from "../../packages/jev-client/src/price";
import { fromJev, jevCountRequest, jevRequest, LOOKBACK, type TextAnswers } from "./questions";
import type { Heard } from "./signals";

const CAP_USD = 0.25;
const PILOT = 10;
const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const pub = new URL("../../experience-prototypes/public/who-said-that/", import.meta.url).pathname;
const out = new URL("./recordings/jev.jsonl", import.meta.url).pathname;
const ids: string[] = JSON.parse(readFileSync(`${pub}scenarios.json`, "utf8")).map((s: { id: string }) => s.id);

type Row = { id: string; at: string; status: "ok" | "error"; request?: Payload; answers?: Record<string, { value?: unknown; probabilities?: Record<string, number> | null }>; latencyMs?: number; inputTokens?: number | null; costUsd?: number | null; servedBy?: string | null; model?: string; error?: string };

const rows: Row[] = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const done = new Map(rows.filter((r) => r.status === "ok").map((r) => [r.id, r]));
let spent = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
const before = spent;
const capAt = process.argv.indexOf("--cap");
const RUN_CAP_USD = capAt >= 0 ? Number(process.argv[capAt + 1]) : Infinity;
let sent = 0;
let failures = 0;

async function ask(id: string, request: Payload): Promise<Row | undefined> {
  // Reuse an answer only for the same request: re-recorded signals change the lines.
  if (done.has(id) && JSON.stringify(done.get(id)!.request) === JSON.stringify(request)) return done.get(id);

  if (process.argv.includes("--pilot") && sent >= PILOT) return undefined;

  if (spent >= CAP_USD) throw new Error(`Stopped at the $${CAP_USD} cap ($${spent.toFixed(4)} spent).`);

  if (spent - before >= RUN_CAP_USD) throw new Error(`Stopped at this run's $${RUN_CAP_USD} cap.`);

  sent++;

  const at = new Date().toISOString();

  try {
    const r = await evaluate(request, { apiKey: key!, maxAttempts: 3, deadlineMs: 20_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const costUsd = tokens === null ? null : jevCostUsd(tokens);
    const row: Row = { id, at, status: "ok", request, answers: r.answers, latencyMs: r.latency_ms, inputTokens: tokens, costUsd, servedBy: r.served_by, model: r.model };

    spent += costUsd ?? 0;
    failures = 0;
    appendFileSync(out, JSON.stringify(row) + "\n");
    done.set(id, row);

    return row;
  } catch (e) {
    failures++;
    appendFileSync(out, JSON.stringify({ id, at, status: "error", error: e instanceof GatewayError ? e.message : String(e) }) + "\n");

    if (failures >= 5) throw new Error(`Stopped after 5 failures in a row: ${e instanceof Error ? e.message : e}`);

    return undefined;
  }
}

for (const sid of ids) {
  const heard: Heard[] = JSON.parse(readFileSync(`${pub}${sid}.signals.json`, "utf8")).heard;
  const answers: (TextAnswers | null)[] = [];
  const receipts: ({ latencyMs: number; inputTokens: number | null; costUsd: number | null; at: string; servedBy: string | null } | null)[] = [];

  for (let i = 0; i < heard.length; i++) {
    const request = jevRequest(heard, i) as unknown as Payload;
    const row = await ask(`${sid}:${i}`, request);

    answers.push(row?.answers ? fromJev(row.answers, Math.min(LOOKBACK, i)) : null);
    receipts.push(row ? { latencyMs: row.latencyMs ?? 0, inputTokens: row.inputTokens ?? null, costUsd: row.costUsd ?? null, at: row.at, servedBy: row.servedBy ?? null } : null);
  }

  const count = await ask(`${sid}:counts`, jevCountRequest(heard) as unknown as Payload);

  if (answers.every(Boolean)) {
    writeFileSync(
      `${pub}${sid}.jev.json`,
      JSON.stringify({
        id: sid,
        model: done.get(`${sid}:0`)?.model ?? "typesafe-ai/jev",
        answers,
        receipts,
        counts: count?.answers ?? null,
        countReceipt: count ? { latencyMs: count.latencyMs, inputTokens: count.inputTokens, costUsd: count.costUsd, at: count.at } : null,
      }),
    );
  }

  console.log(sid, `${answers.filter(Boolean).length}/${heard.length} lines`, count ? "counts ok" : "no counts");
}

console.log(`Sent ${sent} requests; $${(spent - before).toFixed(5)} this run, $${spent.toFixed(5)} at list price so far (cap $${CAP_USD}).`);
