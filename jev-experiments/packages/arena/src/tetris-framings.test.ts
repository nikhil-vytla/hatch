import { describe, expect, test } from "bun:test";
import { TetrisArena, heuristic } from "./tetris";
import { buildRequest, framedJev, spots, type Send } from "./tetris-framings";

/** A perfect reader of the sentences: this bounds what the framing's information allows. */
const idealReader: Send = async (body) => {
  const state = body.state as any;
  const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
    const s: string = state.spots?.[key] ?? "";
    const holes = /no new holes/.test(s) ? 0 : 1, bump = ["no bump", "a small bump", "a big bump", "a tall tower"].findIndex((b) => s.includes(b));
    const lines = /completes (one|two|three|four) line/.test(s) ? 1 : 0;
    const goodness = lines ? 1 : holes ? 0.05 : [0.9, 0.7, 0.3, 0.1][Math.max(0, bump)];
    return [key, q.type === "noul" ? { value: goodness, probabilities: { true: goodness, false: 1 - goodness } } : { value: goodness * 3 }];
  }));
  return { answers };
};

async function play(contestants: ReturnType<typeof framedJev>[], pieces = 40, seed = 7) {
  const arena = new TetrisArena(seed, contestants, "turns");
  for (let i = 0; i < pieces && !arena.over; i++) await arena.turn();
  return arena;
}

describe("spot framings", () => {
  test("group landings by sentence and describe them in words", async () => {
    const arena = new TetrisArena(7, [heuristic()], "turns");
    const q = (arena as any).question(0);
    const groups = spots(q);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThanOrEqual(q.options.length);
    expect(groups.every((g) => /^The piece/.test(g.sentence))).toBe(true);
    const built = buildRequest("spot-clean", q);
    expect(Object.keys(built.body.questions)).toEqual(groups.map((g) => g.key));
  });

  test("a perfect reader of the sentences clears lines, so the words carry enough", async () => {
    for (const seed of [7, 19, 42]) {
      const arena = await play([framedJev("spot-clean", idealReader), framedJev("spot-score", idealReader)], 40, seed);
      for (const lane of arena.lanes) expect(lane.game.lines).toBeGreaterThan(0);
    }
  });
});

describe("recorded framing games", () => {
  const read = (name: string) => require("node:fs").readFileSync(new URL(`../recordings/${name}`, import.meta.url), "utf8");
  const exchanges = read("tetris-framings.replay.jsonl").trim().split("\n").map((l: string) => JSON.parse(l));
  const summary = JSON.parse(read("tetris-framings-summary.json"));
  for (const game of summary.games) {
    test(`replays seed ${game.seed} exactly in turns`, async () => {
      const { recordedFraming } = await import("./tetris-framings");
      const mine = exchanges.filter((x: any) => x.seed === game.seed);
      const arena = new TetrisArena(game.seed, game.lanes.map((l: any) => recordedFraming(mine, l.framing)), "turns");
      for (let i = 0; i < game.pieceLimit && !arena.over; i++) await arena.turn();
      expect(arena.lanes.map((l) => [l.game.pieces, l.game.lines, l.game.score])).toEqual(game.lanes.map((l: any) => [l.pieces, l.lines, l.score]));
      expect(arena.lanes.every((l) => l.stats.missing === 0)).toBe(true);
    });
  }
});
