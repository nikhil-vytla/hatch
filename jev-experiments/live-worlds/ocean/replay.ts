/**
 * A recorded reef run: the seed, then every event and decision batch in the order it happened,
 * each stamped with the tick it was applied at. A session plays it back (session.ts
 * `replaySession`), applying them at the same ticks in the same order, so the world comes out the
 * same without calling any model.
 */
import type { Decision, EventKind } from "./engine";

/** The race scenario: same seed, a heatwave at 15 s, 60 s in all. */
export const RACE = { seed: 7, heatwaveAt: 15, seconds: 60 } as const;

export type Entry =
  | { kind: "event"; tick: number; event: EventKind }
  | { kind: "batch"; tick: number; latencyMs: number | null; inputTokens: number | null; costUsd: number | null; servedBy: string | null; decisions: Decision[] };

export type Recording = { seed: number; model: string; recordedAt: string; seconds: number; entries: Entry[] };

/** Reads a recording from JSON lines: one header, then entries. */
export function parseRecording(text: string): Recording {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = JSON.parse(lines[0]);

  return { seed: header.seed, model: header.model, recordedAt: header.recordedAt, seconds: header.seconds, entries: lines.slice(1).map((l) => JSON.parse(l)).filter((e) => e.kind === "event" || e.kind === "batch") };
}
