/**
 * One reef episode for training and the held-out table: a session (session.ts) with a decider
 * under a decisions-per-second budget. The world waits for each answer, so a slow decider is
 * judged on what it decides, not on how long it takes. An unlimited budget decides every live
 * fish every `every` ticks; a finite one gives the most urgent fish (engine `due`) that many
 * decisions a world second, and everyone else keeps their last action.
 */
import type { EventKind } from "./engine";
import { createSession, type Asked } from "./session";

export type Episode = {
  seed: number;
  event: EventKind | null;
  eventAt: number;
  seconds: number;
  /** Decisions per world second; Infinity decides every live fish every `every` ticks. */
  budget: number;
  every?: number;
};

export type Result = { seed: number; event: EventKind | null; start: number; alive: number; survived: number; cohort: number; births: number };

export async function runEpisode(e: Episode, decider: Asked | null): Promise<Result> {
  const s = createSession({ seed: e.seed, event: e.event, eventAt: e.eventAt, seconds: e.seconds });
  const w = s.world;
  const start = w.fish.filter((f) => f.alive).length;

  s.use(decider, e.budget === Infinity ? { kind: "every", ticks: e.every ?? 1 } : { kind: "rate", perSecond: e.budget });

  while (!s.done()) {
    const wait = s.step();

    if (wait) await wait;
  }

  const o = w.outcomes[0];

  return {
    seed: e.seed,
    event: e.event,
    start,
    alive: w.fish.filter((f) => f.alive).length,
    survived: o?.survived ?? 0,
    cohort: o?.cohort ?? 0,
    births: w.births,
  };
}

/** One number to maximise: share of the event's cohort that survived, plus share alive at the end. */
export const fitness = (r: Result) => (r.cohort ? r.survived / r.cohort : 0) + r.alive / r.start;
