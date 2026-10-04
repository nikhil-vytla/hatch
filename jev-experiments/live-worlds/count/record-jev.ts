/**
 * Records Jev on facts for Count with me: Jev cannot see, so each request carries the detector's
 * boxes (detr.jsonl) as text and asks the same typed questions as the vision model. One request
 * per image; resumes from what is recorded; stops before list-price spend passes the cap.
 * `--pilot` records two images first.
 *
 *   bun live-worlds/count/record-jev.ts [--pilot]
 */
import "../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { evaluate, GatewayError } from "../../experience-prototypes/server/gateway";
import { jevCostUsd } from "../../packages/arena/src/jev-price";
import { jevRequest, type Detection, type Item } from "./model";

const CAP_USD = 0.1;

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const lines = (url: URL) =>
  existsSync(url)
    ? readFileSync(url, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const out = new URL("./recordings/jev.jsonl", import.meta.url);
const recorded = lines(out);
const done = new Set(recorded.filter((r) => r.status === "ok").map((r) => r.id));
const detections = new Map<string, Detection[]>(lines(new URL("./recordings/detr.jsonl", import.meta.url)).map((r) => [r.id, r.detections]));
const { items } = JSON.parse(readFileSync(new URL("./items.json", import.meta.url), "utf8")) as { items: Item[] };
const jobs = process.argv.includes("--pilot") ? [items[0], items[items.length - 1]] : items;

let cost = recorded.reduce((s, r) => s + (r.costUsd ?? 0), 0);
let sent = 0;
let largest = 0;

for (const item of jobs) {
  if (done.has(item.id)) continue;

  const found = detections.get(item.id);

  if (!found) throw Error(`No detections for ${item.id}; run scripts/count-detect.ts first.`);

  // Stop before a request like the largest so far could pass the cap.
  if (cost + largest > CAP_USD) {
    console.log(`Stopped near the $${CAP_USD} cap.`);
    break;
  }

  sent++;

  const at = new Date().toISOString();

  try {
    const r = await evaluate(jevRequest(item, found), { apiKey: key, maxAttempts: 3, deadlineMs: 20_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const costUsd = tokens === null ? null : jevCostUsd(tokens);

    cost += costUsd ?? 0;
    largest = Math.max(largest, costUsd ?? 0);
    appendFileSync(
      out,
      JSON.stringify({
        id: item.id,
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
    appendFileSync(out, JSON.stringify({ id: item.id, at, status: "error", error: e instanceof GatewayError ? e.message : String(e) }) + "\n");
  }
}

console.log(`Sent ${sent} requests; list-price total $${cost.toFixed(5)}.`);
