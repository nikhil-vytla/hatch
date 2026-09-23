import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { TetrisArena, timedReplay } from "./tetris";

const path = new URL("../recordings/realtime.replay.json", import.meta.url);
const recording = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { games: [] };

describe("real-time recordings", () => {
  for (const game of recording.games) {
    test(`replays ${game.design} on seed ${game.seed} exactly`, () => {
      const arena = new TetrisArena(game.seed, [timedReplay(game.events, game.design, game.design)], "realtime", { pieceLimit: 40 });
      while (!arena.over && arena.clockMs < game.worldMs) arena.step();
      arena.stop();
      const lane = arena.lanes[0];
      expect({ pieces: lane.game.pieces, lines: lane.game.lines, score: lane.game.score, applied: lane.stats.applied, stale: lane.stats.stale, failed: lane.stats.failed })
        .toEqual({ pieces: game.pieces, lines: game.lines, score: game.score, applied: game.applied, stale: game.stale, failed: game.failed });
      expect(lane.stats.missing).toBe(0);
    });
  }
});
