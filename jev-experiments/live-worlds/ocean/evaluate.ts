/**
 * Runs one reef episode with a decider under a decisions-per-second budget, the way the page does:
 * each tick the most urgent fish (engine `due`) get decisions while the budget allows; everyone
 * else keeps their last action. An unlimited budget decides every live fish every `every` ticks.
 */
import { advance, applyDecisions, createReef, due, trigger, type Decision, type EventKind, type Fish, type World } from "./engine";

export type Decider = (w: World, fish: Fish[]) => Decision[] | Promise<Decision[]>;

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

export async function runEpisode(e: Episode, decide: Decider | null): Promise<Result> {
  const w = createReef(e.seed);
  const start = w.fish.filter((f) => f.alive).length;
  const every = e.every ?? 1;
  let credit = 0;

  while (w.time < e.seconds) {
    if (e.event && !w.events.length && w.time >= e.eventAt) trigger(w, e.event);

    if (decide) {
      if (e.budget === Infinity) {
        if (w.tick % every === 0) applyDecisions(w, await decide(w, w.fish.filter((f) => f.alive)));
      } else {
        credit += e.budget / 30;

        const n = Math.floor(credit);

        if (n > 0) {
          credit -= n;

          const fish = due(w, n);

          if (fish.length) applyDecisions(w, await decide(w, fish));
        }
      }
    }

    advance(w);
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
