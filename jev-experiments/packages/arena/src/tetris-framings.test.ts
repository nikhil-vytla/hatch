import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { TetrisArena, heuristic } from "./tetris";
import {
  buildRequest,
  framedJev,
  spots,
  type Exchange,
  type FramingId,
  type Send,
} from "./tetris-framings";

type RecordedExchange = Exchange & { seed: number };

type RecordedLane = { framing: FramingId; pieces: number; lines: number; score: number };

const spotsState = z.object({ spots: z.record(z.string(), z.string()) });

/** A perfect reader of the sentences: this bounds what the framing's information allows. */
const idealReader: Send = async (body) => {
  const state = spotsState.safeParse(body.state);
  const sentences = state.success ? state.data.spots : {};

  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([key, q]) => {
      const s = sentences[key] ?? "";

      const holes = /no new holes/.test(s) ? 0 : 1,
        bump = ["no bump", "a small bump", "a big bump", "a tall tower"].findIndex((b) =>
          s.includes(b),
        );

      const lines = /completes (one|two|three|four) line/.test(s) ? 1 : 0;
      const goodness = lines ? 1 : holes ? 0.05 : [0.9, 0.7, 0.3, 0.1][Math.max(0, bump)];

      return [
        key,
        q.type === "noul"
          ? { value: goodness, probabilities: { true: goodness, false: 1 - goodness } }
          : { value: goodness * 3 },
      ];
    }),
  );

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
    const q = arena["question"](0);

    if (!q) throw new Error("The first piece has no question");
    const groups = spots(q);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThanOrEqual(q.options.length);
    expect(groups.every((g) => /^The piece/.test(g.sentence))).toBe(true);
    const built = buildRequest("spot-clean", q);
    expect(Object.keys(built.body.questions)).toEqual(groups.map((g) => g.key));
  });

  test("a perfect reader of the sentences clears lines, so the words carry enough", async () => {
    for (const seed of [7, 19, 42]) {
      const arena = await play(
        [framedJev("spot-clean", idealReader), framedJev("spot-score", idealReader)],
        40,
        seed,
      );

      for (const lane of arena.lanes) expect(lane.game.lines).toBeGreaterThan(0);
    }
  });
});

describe("recorded framing games", () => {
  const read = (name: string) =>
    require("node:fs").readFileSync(new URL(`../recordings/${name}`, import.meta.url), "utf8");

  const exchanges = read("tetris-framings.replay.jsonl")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));

  const summary = JSON.parse(read("tetris-framings-summary.json"));

  for (const game of summary.games) {
    test(`replays seed ${game.seed} exactly in turns`, async () => {
      const { recordedFraming } = await import("./tetris-framings");
      const mine = exchanges.filter((x: RecordedExchange) => x.seed === game.seed);

      const arena = new TetrisArena(
        game.seed,
        game.lanes.map((l: RecordedLane) => recordedFraming(mine, l.framing)),
        "turns",
      );

      for (let i = 0; i < game.pieceLimit && !arena.over; i++) await arena.turn();
      expect(arena.lanes.map((l) => [l.game.pieces, l.game.lines, l.game.score])).toEqual(
        game.lanes.map((l: RecordedLane) => [l.pieces, l.lines, l.score]),
      );
      expect(arena.lanes.every((l) => l.stats.missing === 0)).toBe(true);
    });
  }
});

describe("remembering judgements", () => {
  test("asks only about new sentences and answers repeats from memory", async () => {
    const seen: number[] = [],
      exchanges: Exchange[] = [];

    const counting: Send = async (body, signal) => {
      seen.push(Object.keys(body.questions).length);

      // The reader only needs the sentences, which the cached framing puts in each question.
      return idealReader(
        {
          ...body,
          state: {
            spots: Object.fromEntries(
              Object.entries(body.questions).map(([k, q]) => [k, q.instructions]),
            ),
          },
        },
        signal,
      );
    };

    const arena = new TetrisArena(
      7,
      [framedJev("spot-clean-cached", counting, (x) => exchanges.push(x))],
      "turns",
    );

    for (let i = 0; i < 40 && !arena.over; i++) await arena.turn();
    expect(arena.lanes[0].game.lines).toBeGreaterThan(0);
    const fromMemory = exchanges.reduce((s, x) => s + (x.fromMemory ?? 0), 0);
    expect(fromMemory).toBeGreaterThan(0);
    expect(exchanges.some((x) => !x.body && x.ms === 0)).toBe(true);
    expect(seen.reduce((a, b) => a + b, 0)).toBeLessThan(
      exchanges.reduce((s, x) => s + Object.keys(x.judged ?? {}).length, 0),
    );
  });
});

describe("slow live answers", () => {
  test("a reply for a locked piece is dropped so the lane asks about the next piece", async () => {
    const { TetrisArena: Arena } = await import("./tetris");

    const never: Send = (_body, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );

    const arena = new Arena(7, [framedJev("spot-clean", never)]);

    while (arena.clockMs < 60_000 && !arena.over) arena.step();
    const lane = arena.lanes[0];
    expect(lane.game.pieces).toBeGreaterThan(1);
    const asked = new Set(arena.log.map((e) => e.pieceId));
    expect(asked.size).toBeGreaterThan(1);
    expect(arena.log.filter((e) => e.status === "stale").length).toBeGreaterThan(0);
  });
});

describe("more seeds", () => {
  const read = (name: string) =>
    require("node:fs").readFileSync(new URL(`../recordings/${name}`, import.meta.url), "utf8");

  const exchanges = read("turns-more-seeds.replay.jsonl")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));

  const summary = JSON.parse(read("turns-more-seeds-summary.json"));

  for (const game of summary.games) {
    test(`replays seed ${game.seed} exactly in turns`, async () => {
      const { recordedFraming } = await import("./tetris-framings");
      const { heuristic } = await import("./tetris");
      const mine = exchanges.filter((x: RecordedExchange) => x.seed === game.seed);

      const arena = new TetrisArena(
        game.seed,
        [
          recordedFraming(mine, "landing-choice"),
          recordedFraming(mine, "spot-clean"),
          heuristic(0, "Code planner"),
        ],
        "turns",
        { pieceLimit: 40 },
      );

      for (let i = 0; i < 40 && !arena.over; i++) await arena.turn();
      expect(arena.lanes.map((l) => [l.game.pieces, l.game.lines, l.game.score])).toEqual(
        game.lanes.map((l: RecordedLane) => [l.pieces, l.lines, l.score]),
      );
    });
  }
});

test("a spot whose Score the gateway dropped goes unjudged instead of failing the decision", () => {
  const q = new TetrisArena(7, [heuristic()], "turns")["question"](0);

  if (!q) throw new Error("The first piece has no question");
  const built = buildRequest("spot-score", q);
  const keys = Object.keys(built.body.questions);

  const answers = Object.fromEntries(
    keys
      .slice(1)
      .map((k, i) => [k, { value: i === 0 ? 3 : 1, probabilities: null, confidence: null }]),
  );

  const out = built.read(answers);

  expect(out.judged[keys[0]]).toBeUndefined();
  expect(out.judged[keys[1]]).toBe(1);
});
