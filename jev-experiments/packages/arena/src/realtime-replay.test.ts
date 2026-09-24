import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { TetrisArena, timedReplay } from "./tetris";

const load = (name: string) => {
  const path = new URL(`../recordings/${name}`, import.meta.url);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).games : [];
};

// The first real-time recording predates backoff: it re-asked failures after a fixed 400 ms.
const games = [
  ...load("realtime.replay.json").map((g: { retryPolicy?: "fixed" | "backoff" }) => ({
    ...g,
    retryPolicy: g.retryPolicy ?? "fixed",
  })),
  ...load("realtime-2.replay.json"),
];

describe("real-time recordings", () => {
  for (const game of games) {
    test(`replays ${game.design} (${game.retryPolicy} retries) on seed ${game.seed} exactly`, () => {
      const arena = new TetrisArena(
        game.seed,
        [timedReplay(game.events, game.design, game.design, game.retryPolicy)],
        "realtime",
        { pieceLimit: 40 },
      );

      while (!arena.over && arena.clockMs < game.worldMs) arena.step();
      arena.stop();
      const lane = arena.lanes[0];
      expect({
        pieces: lane.game.pieces,
        lines: lane.game.lines,
        score: lane.game.score,
        applied: lane.stats.applied,
        stale: lane.stats.stale,
        failed: lane.stats.failed,
      }).toEqual({
        pieces: game.pieces,
        lines: game.lines,
        score: game.score,
        applied: game.applied,
        stale: game.stale,
        failed: game.failed,
      });
      expect(lane.stats.missing).toBe(0);
    });
  }
});
