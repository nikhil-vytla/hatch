/**
 * Records Jev's answer for every profile, for one preset (the £500 scam) and its correction, so
 * the page can show the same rumour spreading on Jev without a key. Local only; uses the existing
 * credentials helper and never runs in the browser. Caps: 300 requests, $0.10.
 *
 *   cd jev-experiments/experience-prototypes && bun ../live-worlds/rumour/record.ts
 */
import "../../experience-prototypes/scripts/credentials";
import { appendFileSync } from "node:fs";
import { evaluate } from "../../experience-prototypes/server/gateway";
import { allProfiles, jevRequest, type MessageKind } from "./profiles";
import { PRESETS } from "./presets";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const PRESET = "scam";
const MAX_REQUESTS = 300;
const MAX_USD = 0.1;
// TypeSafe's list price: $0.042 per million input tokens, output free.
const USD_PER_TOKEN = 0.042 / 1e6;

const preset = PRESETS.find((p) => p.id === PRESET);

if (!preset) throw Error(`No preset ${PRESET}.`);

const out = new URL("./jev-scam.jsonl", import.meta.url);

let sent = 0;

let spent = 0;

for (const kind of ["rumour", "counter"] as MessageKind[]) {
  const profiles = allProfiles(kind);

  for (let i = 0; i < profiles.length; i += 100) {
    if (sent >= MAX_REQUESTS || spent >= MAX_USD) throw Error("Cap reached.");

    const batch = profiles.slice(i, i + 100);
    const request = jevRequest(batch, kind, kind === "rumour" ? preset.text : preset.counter, kind === "counter" ? preset.text : null, preset.place);
    const at = new Date().toISOString();

    sent++;

    const r = await evaluate(request, { apiKey: key, maxAttempts: 4, deadlineMs: 40_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const costUsd = tokens === null ? null : tokens * USD_PER_TOKEN;

    spent += costUsd ?? 0;

    const answers = Object.fromEntries(batch.map((p, j) => [p.key, r.answers[`p${j}`] ?? null]));

    appendFileSync(
      out,
      JSON.stringify({ preset: PRESET, kind, at, model: r.model, servedBy: r.served_by, generationId: r.generation_id, latencyMs: r.latency_ms, inputTokens: tokens, costUsd, questions: batch.length, answers }) + "\n",
    );
    console.log(`${kind} ${i}–${i + batch.length - 1}: ${r.latency_ms} ms, ${tokens} tokens`);
  }
}

console.log(`Sent ${sent} requests, list-price cost $${spent.toFixed(5)}.`);
