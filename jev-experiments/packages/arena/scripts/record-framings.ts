/**
 * Records Jev playing turn-based Tetris under three question framings.
 *
 * Protocol (fixed before running): seeds 7, 19, 42; one lane per framing in
 * the same arena, so every framing sees the same pieces; turns, so latency
 * cannot matter; at most 40 pieces per game; no retries of weak answers; a
 * failed request drops the piece where it spawned. Every request, reply and
 * failure is kept. Refuses to overwrite an existing recording.
 *
 * Transport: one request at a time with a short gap, waiting out "busy"
 * replies. Attempt 1 sent three at once and hit provider capacity; it is kept
 * as recordings/attempt-1-provider-busy.jsonl. Turns make waiting free, so
 * transport retries do not bias the comparison; weak answers are never retried.
 *
 *   bun jev-experiments/packages/arena/scripts/record-framings.ts
 *
 * Raw output is kept gzipped (tetris-framings.jsonl.gz); the site replays the
 * compact tetris-framings.replay.jsonl (answers only; requests are rebuilt
 * exactly from the game state).
 */
import "../../../experience-prototypes/scripts/credentials";
import { evaluate } from "../../../experience-prototypes/server/gateway";
import { TetrisArena } from "../src/tetris";
import { framedJev, type Exchange, type FramingId } from "../src/tetris-framings";
import { existsSync, appendFileSync, writeFileSync } from "node:fs";

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");
const out = new URL("../recordings/tetris-framings.jsonl", import.meta.url);
if (existsSync(new URL("../recordings/tetris-framings.jsonl.gz", import.meta.url)))
  throw Error("A recording already exists. Preserve it; do not overwrite recorded outcomes.");
const summaryPath = new URL("../recordings/tetris-framings-summary.json", import.meta.url);
if (existsSync(out))
  throw Error("A recording already exists. Preserve it; do not overwrite recorded outcomes.");

// One request in flight at a time, with a short gap between requests.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(() => new Promise((r) => setTimeout(r, 250))).then(work);
  chain = next.catch(() => {});
  return next;
}

const SEEDS = [7, 19, 42],
  FRAMINGS: FramingId[] = ["landing-choice", "spot-clean", "spot-score"],
  PIECES = 40;
const recordedAt = new Date().toISOString();
const games: unknown[] = [];
for (const seed of SEEDS) {
  const exchanges: (Exchange & { seed: number })[] = [];
  const send = (body: any) =>
    serial(() => evaluate(body, { apiKey: key, maxAttempts: 6, deadlineMs: 180_000 }));
  const arena = new TetrisArena(
    seed,
    FRAMINGS.map((f) => framedJev(f, send, (x) => exchanges.push({ ...x, seed }))),
    "turns",
  );
  const started = performance.now();
  for (let i = 0; i < PIECES && !arena.over; i++) await arena.turn();
  const lanes = arena.lanes.map((l, i) => ({
    framing: FRAMINGS[i],
    pieces: l.game.pieces,
    lines: l.game.lines,
    score: l.game.score,
    status: l.game.status,
    applied: l.stats.applied,
    failed: l.stats.failed,
    medianMs:
      [...l.stats.latencyMs].sort((a, b) => a - b)[Math.floor(l.stats.latencyMs.length / 2)] ??
      null,
  }));
  const cost = exchanges.reduce(
    (s, x: any) => s + (typeof x.response?.cost_usd === "number" ? x.response.cost_usd : 0),
    0,
  );
  const unknownCost = exchanges.filter((x: any) => typeof x.response?.cost_usd !== "number").length;
  for (const x of exchanges) appendFileSync(out, JSON.stringify(x) + "\n");
  const game = {
    seed,
    recordedAt,
    wallMs: Math.round(performance.now() - started),
    pieceLimit: PIECES,
    lanes,
    requests: exchanges.length,
    knownCostUsd: cost,
    unknownCostRequests: unknownCost,
  };
  games.push(game);
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        protocol: "turn-based; seeds 7/19/42; 40-piece limit; no retries of weak answers",
        recordedAt,
        games,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(game));
}
