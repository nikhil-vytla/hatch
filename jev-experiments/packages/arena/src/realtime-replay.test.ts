import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { recorded, TetrisArena, timedReplay, type RecordedEvent } from "./tetris";
import { recordedFraming, type Exchange, type FramingId } from "./tetris-framings";

const load = (name: string) => {
  const path = new URL(`../recordings/${name}`, import.meta.url);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).games : [];
};

const jsonl = (url: URL) =>
  readFileSync(url, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

// The first real-time recording predates backoff: it re-asked failures after a fixed 400 ms.
const games = [
  ...load("realtime.replay.json").map((g: { retryPolicy?: "fixed" | "backoff" }) => ({
    ...g,
    retryPolicy: g.retryPolicy ?? "fixed",
  })),
  ...load("realtime-2.replay.json"),
];

/**
 * Every lock on a lane, in order: when (world ms or turn), which piece, where it locked, the
 * board after it and the score. Hashed, so a pin catches any change to pieces, placements,
 * scores, line counts or tick timing.
 */
function locks(arena: TetrisArena) {
  const seen = arena.lanes.map(() => ({ pieces: 0, active: "" })),
    out: string[] = [];

  return {
    see(at: number) {
      arena.lanes.forEach((lane, i) => {
        const g = lane.game;

        if (g.pieces !== seen[i].pieces)
          out.push(
            `${i}@${at}:${g.pieces}:${seen[i].active}:${g.board.map((r) => r.join("")).join("/")}:${g.score}:${g.lines}`,
          );
        seen[i] = { pieces: g.pieces, active: JSON.stringify(g.active) };
      });
    },
    get hash() {
      return createHash("sha256").update(out.join("\n")).digest("hex").slice(0, 16);
    },
  };
}

function realtime(arena: TetrisArena, untilMs: number) {
  const l = locks(arena);

  while (!arena.over && arena.clockMs < untilMs) {
    arena.step();
    l.see(arena.clockMs);
  }

  arena.stop();

  return l.hash;
}

async function turns(arena: TetrisArena, n = 40) {
  const l = locks(arena);

  for (let i = 1; i <= n && !arena.over; i++) {
    await arena.turn();
    l.see(i);
  }

  return l.hash;
}

/** Lock-by-lock hashes of every recorded lane, taken before the lane mechanics were merged into one module. */
const PINS = new Map(
  Object.entries({
    "timed:fixed:landing-choice:7": "0ead3095d7bdb007",
    "timed:fixed:spot-clean:7": "34a82b614de6ec3a",
    "timed:fixed:spot-clean-cached:7": "199320edd081c352",
    "timed:fixed:landing-choice:19": "70e4e8947adaa083",
    "timed:fixed:spot-clean:19": "597ac98169acf450",
    "timed:fixed:spot-clean-cached:19": "e2f3cd45ad805df2",
    "timed:fixed:landing-choice:42": "3e6b4cf277ff521e",
    "timed:fixed:spot-clean:42": "9230fdbfa7af2e5b",
    "timed:fixed:spot-clean-cached:42": "ebdfb1ee2f251923",
    "timed:backoff:spot-clean:7": "7fb278a49d44bd7a",
    "timed:backoff:spot-clean-cached:7": "f336a8be3f0939b4",
    "timed:backoff:spot-clean-confident:7": "07d812af219066f2",
    "timed:backoff:spot-clean:19": "3c8a26ed05142a0e",
    "timed:backoff:spot-clean-cached:19": "60c9d079006e5cb4",
    "timed:backoff:spot-clean-confident:19": "c2643bc383ddc9c5",
    "timed:backoff:spot-clean:42": "bbbfc035598f9008",
    "timed:backoff:spot-clean-cached:42": "b543094f1ca24c4e",
    "timed:backoff:spot-clean-confident:42": "8394594ffeb6bca7",
    "live:realtime:7": "75ea4614fb0470e3",
    "live:turns:7": "438a46255ff7c0b5",
    "live:realtime:19": "0d83e4a28f273753",
    "live:turns:19": "0c8d1178dfe21b70",
    "live:realtime:42": "ddda426aaa6425f0",
    "live:turns:42": "b72428f685491203",
    "turns:tetris-framings.replay.jsonl:landing-choice:19": "138856fbd449abae",
    "turns-in-realtime:tetris-framings.replay.jsonl:landing-choice:19": "34150db0e731b94c",
    "turns:tetris-framings.replay.jsonl:landing-choice:42": "571022ccab277bd4",
    "turns-in-realtime:tetris-framings.replay.jsonl:landing-choice:42": "717b81ff60bc92c1",
    "turns:tetris-framings.replay.jsonl:landing-choice:7": "c987d65628ef2682",
    "turns-in-realtime:tetris-framings.replay.jsonl:landing-choice:7": "920a1530eb700662",
    "turns:tetris-framings.replay.jsonl:spot-clean:19": "48cfac14f731dbec",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-clean:19": "d4cf87224de7ceff",
    "turns:tetris-framings.replay.jsonl:spot-clean:42": "e28fa46b8c1efdcd",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-clean:42": "67e186b12c696f04",
    "turns:tetris-framings.replay.jsonl:spot-clean:7": "b4a06fa711ffc77e",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-clean:7": "798bc4cfb85e7163",
    "turns:tetris-framings.replay.jsonl:spot-score:19": "1b01daa0c6e2d22d",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-score:19": "bff9bd5b6df24f01",
    "turns:tetris-framings.replay.jsonl:spot-score:42": "d8c428b989a8edca",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-score:42": "44e7547579fb15b1",
    "turns:tetris-framings.replay.jsonl:spot-score:7": "9a257600d9fe351a",
    "turns-in-realtime:tetris-framings.replay.jsonl:spot-score:7": "c65f05f9d9692dff",
    "turns:turns-more-seeds.replay.jsonl:landing-choice:11": "1ed67efd3e9b0dfb",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:landing-choice:11": "0e8d036e59e35383",
    "turns:turns-more-seeds.replay.jsonl:landing-choice:23": "d5c682852846f1d5",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:landing-choice:23": "1efb747ecfeaf0c0",
    "turns:turns-more-seeds.replay.jsonl:landing-choice:3": "09083e4274f86a5b",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:landing-choice:3": "6e2c90144fb77d83",
    "turns:turns-more-seeds.replay.jsonl:landing-choice:31": "b0ff3a9e015697d6",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:landing-choice:31": "243c7c8bff108941",
    "turns:turns-more-seeds.replay.jsonl:spot-clean:11": "a9c5816c2138202d",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:spot-clean:11": "b6ad6089fb8da07d",
    "turns:turns-more-seeds.replay.jsonl:spot-clean:23": "817420345c3f5ac0",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:spot-clean:23": "eab79245dd17d45e",
    "turns:turns-more-seeds.replay.jsonl:spot-clean:3": "af722697696726aa",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:spot-clean:3": "7e5ba803c97d67bf",
    "turns:turns-more-seeds.replay.jsonl:spot-clean:31": "184dc967ff593164",
    "turns-in-realtime:turns-more-seeds.replay.jsonl:spot-clean:31": "b8ef1b4fed6f8fea",
  }),
);

describe("real-time recordings", () => {
  for (const game of games) {
    test(`replays ${game.design} (${game.retryPolicy} retries) on seed ${game.seed} exactly`, () => {
      const arena = new TetrisArena(
        game.seed,
        [timedReplay(game.events, game.design, game.design, game.retryPolicy)],
        "realtime",
        { pieceLimit: 40 },
      );

      const hash = realtime(arena, game.worldMs);
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
      expect(hash).toBe(PINS.get(`timed:${game.retryPolicy}:${game.design}:${game.seed}`));
    });
  }
});

describe("every recorded lane, lock by lock", () => {
  const live = jsonl(new URL("../../../live-worlds/tetris/matched-queue/games.jsonl", import.meta.url));

  for (const game of live) {
    const seed = game.summary.seed,
      events: RecordedEvent[] = game.events.filter((e: RecordedEvent) => e.lane === 1);

    test(`the live page's landing lane on seed ${seed}, in real time and in turns`, async () => {
      expect(realtime(new TetrisArena(seed, [recorded(events)]), game.summary.worldMs)).toBe(
        PINS.get(`live:realtime:${seed}`),
      );
      expect(await turns(new TetrisArena(seed, [recorded(events)], "turns"))).toBe(
        PINS.get(`live:turns:${seed}`),
      );
    });
  }

  for (const file of ["tetris-framings.replay.jsonl", "turns-more-seeds.replay.jsonl"]) {
    const rows: (Exchange & { seed: number })[] = jsonl(
      new URL(`../recordings/${file}`, import.meta.url),
    );

    const lanes = [...new Set(rows.map((r) => `${r.framing}|${r.seed}`))].sort();

    for (const key of lanes) {
      const [framing, s] = key.split("|"),
        seed = Number(s);

      test(`${file}: ${framing} on seed ${seed}, in turns and in real time`, async () => {
        const mine = rows.filter((r) => r.seed === seed);
        // SAFETY: framing comes from the recording's own framing field.
        const id = framing as FramingId;

        const arena = (mode: "turns" | "realtime") =>
          new TetrisArena(seed, [recordedFraming(mine, id)], mode, { pieceLimit: 40 });

        expect(await turns(arena("turns"))).toBe(PINS.get(`turns:${file}:${framing}:${seed}`));
        expect(realtime(arena("realtime"), 240_000)).toBe(
          PINS.get(`turns-in-realtime:${file}:${framing}:${seed}`),
        );
      });
    }
  }
});
