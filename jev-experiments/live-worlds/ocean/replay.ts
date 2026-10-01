/**
 * A recorded reef run: the seed, then every event and decision batch in the order it happened,
 * each stamped with the tick it was applied at. Replaying applies them at the same ticks, so the
 * world comes out the same without calling any model.
 */
import { advance, applyDecisions, createReef, trigger, type Decision, type EventKind, type World } from "./engine";

/** The race scenario: same seed, a heatwave at 15 s, 60 s in all. */
export const RACE = { seed: 7, heatwaveAt: 15, seconds: 60 } as const;

export type Entry =
  | { kind: "event"; tick: number; event: EventKind }
  | { kind: "batch"; tick: number; latencyMs: number; inputTokens: number | null; costUsd: number | null; servedBy: string | null; decisions: Decision[] };

export type Recording = { seed: number; model: string; recordedAt: string; seconds: number; entries: Entry[] };

/** Reads a recording from JSON lines: one header, then entries. */
export function parseRecording(text: string): Recording {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = JSON.parse(lines[0]);

  return { seed: header.seed, model: header.model, recordedAt: header.recordedAt, seconds: header.seconds, entries: lines.slice(1).map((l) => JSON.parse(l)).filter((e) => e.kind === "event" || e.kind === "batch") };
}

/** A replay cursor: call `step()` once per fixed step; it applies due entries, then advances. */
export function replayer(rec: Recording) {
  const world: World = createReef(rec.seed);
  let next = 0;

  return {
    world,
    done: () => world.time >= rec.seconds,
    step() {
      while (next < rec.entries.length && rec.entries[next].tick <= world.tick) {
        const e = rec.entries[next++];

        if (e.kind === "event") trigger(world, e.event);
        else applyDecisions(world, e.decisions);
      }

      advance(world);
    },
  };
}
