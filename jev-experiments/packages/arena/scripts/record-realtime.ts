/**
 * Records Jev playing real-time Tetris, one game per question design.
 *
 * Protocol (fixed before running): seeds 7, 19, 42; designs landing-choice,
 * spot-clean and spot-clean-cached; one lane per game so only one request is
 * ever in flight; the world clock follows wall time and gravity never waits;
 * a game ends at 40 pieces, game over, or 4 minutes. Transport follows the
 * real-time demos: at most two attempts within 4 s, answers for a locked
 * piece are dropped at once, and a failed request is re-asked 400 ms later.
 * Weak answers are never retried. Refuses to overwrite an existing recording.
 *
 *   bun jev-experiments/packages/arena/scripts/record-realtime.ts        # run 1
 *   bun jev-experiments/packages/arena/scripts/record-realtime.ts 2      # run 2
 *
 * Run 1 re-asked failures after a fixed 400 ms. Run 2 backs off (0.4 → 4 s,
 * resetting after a success) and adds "remember only confident judgements".
 */
import "../../../experience-prototypes/scripts/credentials";
import { evaluate } from "../../jev-client/src/index";
import { TetrisArena, type Contestant, type TimedEvent } from "../src/tetris";
import { framedJev, type Exchange, type FramingId } from "../src/tetris-framings";
import { existsSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");
const dir = new URL("../recordings/", import.meta.url);
const run = process.argv[2] === "2" ? 2 : 1;
const stem = run === 2 ? "realtime-2" : "realtime";
const replayPath = new URL(`${stem}.replay.json`, dir),
  rawPath = new URL(`${stem}.jsonl.gz`, dir);
if (existsSync(replayPath) || existsSync(rawPath))
  throw Error("A recording already exists. Preserve it; do not overwrite recorded outcomes.");

const SEEDS = [7, 19, 42],
  PIECES = 40,
  WALL_LIMIT_MS = 240_000;
const DESIGNS: FramingId[] =
  run === 2
    ? ["spot-clean", "spot-clean-cached", "spot-clean-confident"]
    : ["landing-choice", "spot-clean", "spot-clean-cached"];
const retryPolicy = run === 2 ? ("backoff" as const) : ("fixed" as const);
const recordedAt = new Date().toISOString();
const raw: (Exchange & { seed: number })[] = [];
const games: any[] = [];

/** Notes the board each question was asked against, keyed by question id. */
function observing(
  inner: Contestant,
  asked: Map<string, { sentAt: number; pieceId: number; board: string[] }>,
): Contestant {
  return {
    ...inner,
    ask(q, mode, signal) {
      asked.set(q.id, { sentAt: q.sentAt, pieceId: q.pieceId, board: q.state.board });
      return inner.ask(q, mode, signal);
    },
  };
}

for (const seed of SEEDS)
  for (const design of DESIGNS) {
    const asked = new Map<string, { sentAt: number; pieceId: number; board: string[] }>();
    const send = (body: any, signal?: AbortSignal) =>
      evaluate(body, { apiKey: key, signal, maxAttempts: 2, deadlineMs: 4000 });
    const jev = { ...framedJev(design, send, (x) => raw.push({ ...x, seed })), retryPolicy };
    const arena = new TetrisArena(seed, [observing(jev, asked)], "realtime", {
      pieceLimit: PIECES,
    });
    const start = performance.now();
    let previous = start;
    while (!arena.over && performance.now() - start < WALL_LIMIT_MS) {
      const now = performance.now();
      arena.advance(now - previous);
      previous = now;
      await Bun.sleep(20);
    }
    const censored = !arena.over;
    arena.stop();
    const lane = arena.lanes[0];
    const events: (TimedEvent & { status: string })[] = arena.log.map((e) => {
      const a = asked.get(e.questionId)!;
      // A stale answer here was dropped when its piece locked; it never arrived.
      const arrived = e.status === "applied" || e.status === "failed";
      return {
        ...a,
        status: e.status,
        receivedAt: arrived ? e.resolvedAt : undefined,
        choice: e.status === "applied" ? e.choice : undefined,
        probabilities: e.status === "applied" ? e.probabilities : undefined,
        error: e.status === "failed" ? e.reason : undefined,
        latencyMs: e.latencyMs,
      };
    });
    const lat = [...lane.stats.latencyMs].sort((x, y) => x - y);
    const memoryHits = raw
      .filter((x) => x.seed === seed && x.framing === design)
      .reduce((s, x) => s + (x.fromMemory ?? 0), 0);
    const game = {
      seed,
      design,
      retryPolicy,
      recordedAt,
      worldMs: arena.clockMs,
      censored,
      pieces: lane.game.pieces,
      lines: lane.game.lines,
      score: lane.game.score,
      status: lane.game.status,
      applied: lane.stats.applied,
      stale: lane.stats.stale,
      failed: lane.stats.failed,
      medianMs: lat[Math.floor(lat.length / 2)] ?? null,
      memoryHits,
      events,
    };
    games.push(game);
    const { events: _omit, ...summary } = game;
    console.log(JSON.stringify(summary));
    writeFileSync(
      replayPath,
      JSON.stringify({
        protocol: `real time; seeds 7/19/42; 40 pieces or game over or 4 min; <=2 attempts in 4 s; drop answers for locked pieces; ${retryPolicy === "fixed" ? "re-ask failures after 400 ms" : "back off 0.4-4 s after failures"}`,
        recordedAt,
        games,
      }) + "\n",
    );
    writeFileSync(rawPath, gzipSync(raw.map((x) => JSON.stringify(x)).join("\n") + "\n"));
    await Bun.sleep(2000);
  }
