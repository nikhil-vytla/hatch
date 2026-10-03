/**
 * What seeing costs, computed from the recordings. Every number on the Eyes against state page
 * comes from here: each recorded vision-model run is replayed through the real engine, and the
 * facts lane (the greedy rule on the true state, and Jev's recorded games) is replayed on the
 * same seeds.
 */
import { greedy, initial, step, type State } from "../../local-models-and-games/arcade/engine";
import { apply, type FrameRecord } from "./model";

export const SEEDS = [...Array.from({ length: 20 }, (_, i) => 101 + i), 7, 19, 42];

export type Game = { seed: number; status: State["status"]; moves: number; food: number; reason: string };

export type LaneSummary = {
  id: string;
  label: string;
  reads: "facts" | "pixels";
  games: Game[];
  survived: number;
  lost: number;
  medianMoves: number;
  meanFood: number;
  /** Median per-move decision time on the recording machine; null for code. */
  medianMs: number | null;
  /** Decisions a second at that median, one move at a time. */
  decisionsPerSecond: number | null;
  /** Share of recorded moves that match what the greedy rule would do on the true state. */
  agreesWithGreedy: number | null;
  /** How the lost games ended. */
  endings: Record<string, number>;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

function lane(id: string, label: string, reads: LaneSummary["reads"], games: Game[], ms: number[], agree: number | null): LaneSummary {
  const lost = games.filter((g) => g.status === "lost");
  const endings: Record<string, number> = {};

  for (const g of lost) endings[g.reason] = (endings[g.reason] ?? 0) + 1;

  const m = ms.length ? median(ms) : null;

  return {
    id,
    label,
    reads,
    games,
    survived: games.length - lost.length,
    lost: lost.length,
    medianMoves: median(games.map((g) => g.moves)),
    meanFood: games.reduce((s, g) => s + g.food, 0) / Math.max(1, games.length),
    medianMs: m,
    decisionsPerSecond: m ? 1000 / m : null,
    agreesWithGreedy: agree,
    endings,
  };
}

/** The greedy rule on the true game state, on the given seeds. */
export function greedyLane(seeds = SEEDS): LaneSummary {
  const games = seeds.map((seed) => {
    let s = initial("snake", seed);

    while (s.status === "playing") s = step(s, greedy(s));

    return { seed, status: s.status, moves: s.tick, food: s.score, reason: s.reason };
  });

  return lane("greedy", "Greedy rule, reading the facts", "facts", games, [], 1);
}

/** A recorded vision-model run, replayed through the engine move by move. */
export function vlmLane(id: string, label: string, rows: FrameRecord[], seeds = SEEDS): LaneSummary {
  const bySeed = new Map<number, Map<number, FrameRecord>>();

  for (const r of rows) {
    if (!bySeed.has(r.seed)) bySeed.set(r.seed, new Map());

    bySeed.get(r.seed)!.set(r.tick, r);
  }

  const used: FrameRecord[] = [];
  const games = seeds.flatMap((seed) => {
    const frames = bySeed.get(seed);

    if (!frames) return [];

    let s = initial("snake", seed);

    while (s.status === "playing") {
      const r = frames.get(s.tick);

      if (!r) break;

      used.push(r);
      s = apply(s, r.move);
    }

    return [{ seed, status: s.status, moves: s.tick, food: s.score, reason: s.reason }];
  });

  const agree = used.length ? used.filter((r) => r.move === r.greedy).length / used.length : null;

  return lane(id, label, "pixels", games, used.map((r) => r.ms), agree);
}

/** Jev's recorded Snake games (text in, one choice per move), from the arcade record. */
export type JevEpisode = { seed: number; state: State; trace: { latency_ms?: number }[] };

export function jevLane(episodes: JevEpisode[]): LaneSummary {
  const games = episodes.map((e) => ({ seed: e.seed, status: e.state.status, moves: e.state.tick, food: e.state.score, reason: e.state.reason }));
  const ms = episodes.flatMap((e) => e.trace.map((t) => t.latency_ms ?? 0)).filter((x) => x > 0);

  return lane("jev", "Jev, reading the facts (recorded)", "facts", games, ms, null);
}

export type PerceptionRow = { question: "above" | "right"; truth: boolean; p_yes: number; right: boolean };

export function perceptionSummary(rows: PerceptionRow[]) {
  const of = (q: PerceptionRow["question"]) => {
    const r = rows.filter((x) => x.question === q);

    return { asked: r.length, right: r.filter((x) => x.right).length };
  };

  return { above: of("above"), right: of("right") };
}
