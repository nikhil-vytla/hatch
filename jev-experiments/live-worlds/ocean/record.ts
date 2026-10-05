/**
 * Records one reef run on Jev in real time: the world advances on the wall clock while each
 * request is in flight, and every batch is applied at the tick its answer arrived. Writes
 * recordings/jev-heatwave.jsonl for the page to replay without a key.
 *
 *   bun live-worlds/ocean/record.ts [--probe]
 *
 * --probe sends one batch and prints its size, latency and cost.
 *
 * Budget: 400 requests and $0.10 in all. A probe (1 request) and a first recording (157
 * requests, $0.041) were spent before the engine switched to engine-independent arithmetic,
 * which made that recording replay differently in Chrome; it was discarded. These caps are
 * what was left.
 */
import "../../experience-prototypes/scripts/credentials";
import { mkdirSync, writeFileSync } from "node:fs";
import { evaluate, GatewayError, JEV_USD_PER_INPUT_TOKEN } from "../../packages/jev-client/src/index";
import { advance, applyDecisions, createReef, due, STEP, trigger, view } from "./engine";
import { fromJev, JEV_BATCH, JEV_MODEL, jevRequest } from "./models";
import { RACE, type Entry } from "./replay";
import { requireKey } from "../../packages/jev-client/src/recorder";

const MAX_REQUESTS = 240;
const MAX_USD = 0.058;

const key = requireKey();

const w = createReef(RACE.seed);

if (process.argv.includes("--probe")) {
  const views = due(w, JEV_BATCH).map((f) => view(w, f));
  const req = jevRequest(views);
  const r = await evaluate(req, { apiKey: key, maxAttempts: 2, deadlineMs: 20_000 });
  const tokens = r.usage?.input_tokens ?? null;

  console.log({ bytes: JSON.stringify(req).length, questions: views.length, latencyMs: r.latency_ms, tokens, usd: tokens === null ? null : tokens * JEV_USD_PER_INPUT_TOKEN, decisions: fromJev(views, r.answers, r.latency_ms).length, sample: fromJev(views, r.answers, r.latency_ms).slice(0, 3) });
  process.exit(0);
}

const entries: Entry[] = [];
let requests = 0;
let usd = 0;
let failures = 0;
const started = performance.now();
let heated = false;

// The world clock: advance in fixed steps to match wall time.
const timer = setInterval(() => {
  const target = Math.floor((performance.now() - started) / 1000 / STEP);

  while (w.tick < target && w.time < RACE.seconds) {
    if (!heated && w.time >= RACE.heatwaveAt) {
      heated = true;
      trigger(w, "heatwave");
      entries.push({ kind: "event", tick: w.tick, event: "heatwave" });
    }

    advance(w);
  }
}, 10);

while (w.time < RACE.seconds && requests < MAX_REQUESTS && usd < MAX_USD) {
  const views = due(w, JEV_BATCH).map((f) => view(w, f));

  if (!views.length) {
    await new Promise((r) => setTimeout(r, 50));
    continue;
  }

  requests++;

  try {
    const r = await evaluate(jevRequest(views), { apiKey: key, maxAttempts: 1, deadlineMs: 10_000 });
    const tokens = r.usage?.input_tokens ?? null;
    const cost = tokens === null ? null : tokens * JEV_USD_PER_INPUT_TOKEN;

    usd += cost ?? 0;

    // Applied at the tick the answer arrived; the engine refuses any that no longer fit (a fish
    // that died, or an option that went away), and the replay refuses the same ones.
    const decisions = fromJev(views, r.answers, r.latency_ms);

    entries.push({ kind: "batch", tick: w.tick, latencyMs: r.latency_ms, inputTokens: tokens, costUsd: cost, servedBy: r.served_by, decisions });
    applyDecisions(w, decisions);
  } catch (e) {
    failures++;
    console.log("failed:", e instanceof GatewayError ? e.message : String(e));
  }
}

clearInterval(timer);

const header = { seed: RACE.seed, model: JEV_MODEL, recordedAt: new Date().toISOString(), seconds: RACE.seconds, scenario: `heatwave at ${RACE.heatwaveAt} s`, batch: JEV_BATCH };
const summary = {
  kind: "summary",
  requests,
  failures,
  usd,
  decisions: entries.reduce((n, e) => n + (e.kind === "batch" ? e.decisions.length : 0), 0),
  fishAlive: w.fish.filter((f) => f.alive).length,
  outcomes: w.outcomes,
  deaths: w.deaths,
  births: w.births,
};

mkdirSync(new URL("./recordings/", import.meta.url), { recursive: true });
writeFileSync(new URL("./recordings/jev-heatwave.jsonl", import.meta.url), [header, ...entries, summary].map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(summary);
