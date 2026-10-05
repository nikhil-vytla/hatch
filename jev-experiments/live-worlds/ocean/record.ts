/**
 * Records one reef run on Jev in real time: a live session (session.ts) with the Jev adapter on
 * the wall clock. The world advances while each request is in flight, every batch is applied at
 * the tick its answer arrived, and the session's log is the recording. Writes
 * recordings/jev-heatwave.jsonl for the page to replay without a key.
 *
 *   bun live-worlds/ocean/record.ts [--probe]
 *
 * --probe sends one batch and prints its size, latency and cost.
 *
 * Budget: 400 requests and $0.10 in all. A probe (1 request) and a first recording (157
 * requests, $0.041) were spent before the engine switched to engine-independent arithmetic,
 * which made that recording replay differently in Chrome; it was discarded. The cap below is
 * what was left. The committed recording (148 requests) predates the session's pacing (at most
 * one batch every JEV_EVERY ticks); with Jev's ~300 ms latency that pacing rarely binds.
 */
import "../../experience-prototypes/scripts/credentials";
import { mkdirSync, writeFileSync } from "node:fs";
import { evaluate, GatewayError, JEV_USD_PER_INPUT_TOKEN } from "../../packages/jev-client/src/index";
import { requireKey } from "../../packages/jev-client/src/recorder";
import { jev } from "./deciders";
import { createReef, due, view } from "./engine";
import { fromJev, JEV_BATCH, JEV_EVERY, JEV_MODEL, jevRequest } from "./models";
import { RACE } from "./replay";
import { createSession, RACE_SCENARIO, wallClock } from "./session";

const CAP = { requests: 240, usd: 0.058 };

const key = requireKey();

if (process.argv.includes("--probe")) {
  const w = createReef(RACE.seed);
  const views = due(w, JEV_BATCH).map((f) => view(w, f));
  const req = jevRequest(views);
  const r = await evaluate(req, { apiKey: key, maxAttempts: 2, deadlineMs: 20_000 });
  const tokens = r.usage?.input_tokens ?? null;

  console.log({ bytes: JSON.stringify(req).length, questions: views.length, latencyMs: r.latency_ms, tokens, usd: tokens === null ? null : tokens * JEV_USD_PER_INPUT_TOKEN, decisions: fromJev(views, r.answers, r.latency_ms).length, sample: fromJev(views, r.answers, r.latency_ms).slice(0, 3) });
  process.exit(0);
}

const s = createSession(RACE_SCENARIO, { keepLog: true });

s.use(
  jev(async (request) => {
    try {
      return await evaluate(request, { apiKey: key, maxAttempts: 1, deadlineMs: 10_000 });
    } catch (e) {
      // Fish keep their last action; the next batch goes at the next decision point.
      console.log("failed:", e instanceof GatewayError ? e.message : String(e));

      return null;
    }
  }),
  { kind: "live", batch: JEV_BATCH, everyTicks: JEV_EVERY, cap: CAP },
);

// The world clock: fixed steps to match wall time, never dropping time.
const clock = wallClock({ maxDt: Infinity, maxSteps: Infinity });

await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    for (let n = clock(performance.now()); n > 0 && !s.done(); n--) s.step();

    if (s.done() || (s.stopped && !s.inFlight)) {
      clearInterval(timer);
      resolve();
    }
  }, 10);
});

const w = s.world;
const header = { seed: RACE.seed, model: JEV_MODEL, recordedAt: new Date().toISOString(), seconds: RACE.seconds, scenario: `heatwave at ${RACE.heatwaveAt} s`, batch: JEV_BATCH };
const summary = {
  kind: "summary",
  requests: s.stats.requests,
  failures: s.stats.failures,
  usd: s.stats.usd,
  decisions: s.log.reduce((n, e) => n + (e.kind === "batch" ? e.decisions.length : 0), 0),
  fishAlive: w.fish.filter((f) => f.alive).length,
  outcomes: w.outcomes,
  deaths: w.deaths,
  births: w.births,
};

mkdirSync(new URL("./recordings/", import.meta.url), { recursive: true });
writeFileSync(new URL("./recordings/jev-heatwave.jsonl", import.meta.url), [header, ...s.log, summary].map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(summary);
