/**
 * "Build this" on the arena's Tetris board shows the request behind each Jev lane's latest
 * decision. Replays every published replay chunk through the wrappers the board uses and checks
 * that each request it would show is one the recording sent, from the recordings' full request
 * logs, and that it shows every request the recording sent.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildArena } from "../../../packages/arena/src/data/build";
import { replaySchema } from "../../../packages/arena/src/data/chunks";
import type { ArenaIndex } from "../../../packages/arena/src/data/schema";
import { TetrisArena, timedReplay } from "../../../packages/arena/src/tetris";
import { framedJev, recordedFraming, type Wire } from "../../../packages/arena/src/tetris-framings";
import { collectRequests } from "../build-this-snippets";
import { notingSend, notingTimed, notingTurns, type RequestNote } from "./tetris-requests";

const RECORDINGS = new URL("../../../packages/arena/recordings/", import.meta.url).pathname;

/** Every request a recording sent, as JSON, by seed and framing. */
function sent(file: string) {
  const out = new Map<string, Set<string>>();

  for (const line of gunzipSync(readFileSync(join(RECORDINGS, file)))
    .toString("utf8")
    .trim()
    .split("\n")) {
    const row: { seed: number; framing: string; body?: Wire } = JSON.parse(line);

    if (!row.body) continue;
    const key = `${row.seed}/${row.framing}`;
    out.set(key, (out.get(key) ?? new Set()).add(JSON.stringify(row.body)));
  }

  return out;
}

/** The turn runs used different seeds; the two real-time runs differ by retry policy. */
const LOGS = {
  turns: [sent("tetris-framings.jsonl.gz"), sent("turns-more-seeds.jsonl.gz")],
  fixed: [sent("realtime.jsonl.gz")],
  backoff: [sent("realtime-2.jsonl.gz")],
};

let dir = "";

let index: ArenaIndex;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "arena-requests-"));
  index = await buildArena(dir);
}, 120_000);

/** Plays one lane through to the end and gathers every request its Build this would show. */
async function shown(cardId: string, path: string) {
  const chunk = replaySchema.parse(JSON.parse(readFileSync(join(dir, path), "utf8")));
  const note: RequestNote = { latest: null };
  const seen: { request: Wire; rebuilt: boolean }[] = [];

  const keep = () => {
    if (note.latest && note.latest !== seen.at(-1)) seen.push(note.latest);
  };

  if (chunk.schema === "arena.replay.timed/1") {
    const player = notingTimed(
      timedReplay(chunk.events, "lane", "lane", chunk.retryPolicy),
      chunk.events,
      chunk.framing,
      note,
    );

    const arena = new TetrisArena(chunk.seed, [player], "realtime", { pieceLimit: 40 });

    while (!arena.over && arena.clockMs < 240_000) {
      arena.step();
      keep();
    }

    arena.stop();

    return {
      seed: chunk.seed,
      framing: chunk.framing,
      seen,
      logs: LOGS[chunk.retryPolicy],
      cardId,
    };
  }

  const player = notingTurns(
    recordedFraming(chunk.exchanges, chunk.framing),
    chunk.exchanges,
    chunk.framing,
    note,
  );

  const arena = new TetrisArena(chunk.seed, [player], "turns", { pieceLimit: 40 });

  for (let i = 0; i < 40 && !arena.over; i++) {
    await arena.turn();
    keep();
  }

  return { seed: chunk.seed, framing: chunk.framing, seen, logs: LOGS.turns, cardId };
}

describe("Build this on the arena's Tetris board", () => {
  test("every Jev lane on both Tetris cards shows only requests its recording sent, and all of them", async () => {
    let lanes = 0,
      requests = 0,
      recorded = 0;

    for (const card of index.cards.filter(
      (c) => c.id === "tetris-turns" || c.id === "tetris-realtime",
    ))
      for (const perSeed of Object.values(card.chunks.replay ?? {}))
        for (const path of Object.values(perSeed)) {
          const { seed, framing, seen, logs } = await shown(card.id, path);

          expect(framing).toBeDefined();

          const log =
            logs.find((l) => l.has(`${seed}/${framing}`))?.get(`${seed}/${framing}`) ?? new Set();

          expect(log.size, `${path}: no request log`).toBeGreaterThan(0);
          const shownJson = new Set(seen.map((s) => JSON.stringify(s.request)));

          for (const json of shownJson)
            expect(log.has(json), `${path}: a request the recording didn't send`).toBe(true);
          expect(shownJson.size, `${path}: requests the board never shows`).toBe(log.size);

          // Remembering designs' requests come from the recording; the rest are rebuilt from the board.
          const remembers = framing === "spot-clean-cached" || framing === "spot-clean-confident";

          expect(seen.every((s) => s.rebuilt === !remembers)).toBe(true);
          lanes++;
          requests += shownJson.size;
          recorded += log.size;
        }

    // Turns: two designs on 7 seeds and the 0-3 rating on 3. Real time: three designs on 3 seeds, in each of two runs.
    expect(lanes).toBe(17 + 18);
    expect(requests).toBe(recorded);
  }, 120_000);

  test("with your key, the board shows the exact body it sent and the answers that came back", async () => {
    const note: RequestNote = { latest: null };
    const bodies: Wire[] = [];

    const player = framedJev(
      "spot-clean-confident",
      notingSend(async (body) => {
        bodies.push(body);

        return {
          answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { value: 0.5 }])),
        };
      }, note),
    );

    const arena = new TetrisArena(7, [player], "turns", { pieceLimit: 40 });

    await arena.turn();
    expect(note.latest?.request).toBe(bodies[bodies.length - 1]);
    expect(note.latest?.rebuilt).toBe(false);
    expect(note.latest?.response).toEqual({ answers: expect.any(Object) });
    expect(collectRequests(note.latest?.request)).toHaveLength(1);
  });
});
