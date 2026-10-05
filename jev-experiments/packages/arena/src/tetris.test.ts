import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { heuristic, randomPlayer, recorded, TetrisArena, type RecordedEvent } from "./tetris";

const games = readFileSync(new URL("../../../live-worlds/tetris/matched-queue/games.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const LANDING_LANE = 1;

function runRealtime(arena: TetrisArena, untilMs: number) {
  while (!arena.over && arena.clockMs < untilMs) arena.step();
  arena.stop();
}

describe("real-time arena", () => {
  for (const game of games) {
    const seed = game.summary.seed,
      expected = game.summary.lanes[LANDING_LANE];

    test(`replays the recorded Jev landing game on seed ${seed} exactly`, () => {
      const events: RecordedEvent[] = game.events.filter(
        (e: RecordedEvent) => e.lane === LANDING_LANE,
      );

      const arena = new TetrisArena(seed, [recorded(events)]);
      runRealtime(arena, game.summary.worldMs);
      const lane = arena.lanes[0];
      expect(lane.stats.missing).toBe(0);
      expect({
        pieces: lane.game.pieces,
        lines: lane.game.lines,
        score: lane.game.score,
        status: lane.game.status,
      }).toEqual({
        pieces: expected.pieces,
        lines: expected.lines,
        score: expected.score,
        status: expected.status,
      });
      expect({
        applied: lane.stats.applied,
        stale: lane.stats.stale,
        failed: lane.stats.failed,
      }).toEqual({
        applied: expected.stats.accepted,
        stale: expected.stats.stale,
        failed: expected.stats.failed,
      });
    });
  }

  test("every lane sees the same pieces in the same order", () => {
    const arena = new TetrisArena(19, [heuristic(), randomPlayer(), heuristic(600)]);
    const queues = arena.lanes.map((l) => [l.game.active.type, ...l.game.queue].join(""));
    expect(new Set(queues).size).toBe(1);
  });

  test("a slower answer lands later and can go stale", () => {
    const arena = new TetrisArena(19, [heuristic(0), heuristic(6000)]);
    runRealtime(arena, 30_000);
    const [fast, slow] = arena.lanes;
    expect(fast.stats.applied).toBeGreaterThan(0);
    expect(slow.stats.stale).toBeGreaterThan(0);
    expect(fast.game.pieces).toBeGreaterThanOrEqual(slow.game.pieces);
  });

  test("a recording that no longer matches the board reports where it ends", () => {
    const game = games.find((g) => g.summary.seed === 19);

    const events: RecordedEvent[] = game.events.filter(
      (e: RecordedEvent) => e.lane === LANDING_LANE,
    );

    const arena = new TetrisArena(7, [recorded(events)]);
    runRealtime(arena, 20_000);
    expect(arena.lanes[0].recordingEnded).not.toBeNull();
    expect(arena.log.some((e) => e.status === "missing")).toBe(true);
  });

  test("runs repeat exactly", () => {
    const play = () => {
      const a = new TetrisArena(42, [heuristic(), randomPlayer(3), heuristic(300)]);
      runRealtime(a, 15_000);

      return JSON.stringify(a.lanes.map((l) => [l.game.board, l.game.score, l.stats]));
    };

    expect(play()).toBe(play());
  }, 20_000);
});

describe("turn-based arena", () => {
  test("places one piece per lane per turn, so only choices differ", async () => {
    const arena = new TetrisArena(7, [heuristic(), randomPlayer()], "turns");

    for (let i = 0; i < 30; i++) await arena.turn();
    const [planner, random] = arena.lanes;
    expect(planner.game.pieces).toBe(30);
    expect(random.game.status === "over" || random.game.pieces === 30).toBe(true);
    expect(planner.game.lines).toBeGreaterThan(random.game.lines);
  });

  test("uses recorded answers while boards match and marks where they stop", async () => {
    const game = games.find((g) => g.summary.seed === 7);

    const events: RecordedEvent[] = game.events.filter(
      (e: RecordedEvent) => e.lane === LANDING_LANE,
    );

    const arena = new TetrisArena(7, [recorded(events)], "turns");

    for (let i = 0; i < 40 && !arena.over; i++) await arena.turn();
    const lane = arena.lanes[0];
    expect(lane.stats.applied).toBeGreaterThan(0);
    expect(lane.recordingEnded).not.toBeNull();
  });
});
