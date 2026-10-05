/**
 * One reef run. The session owns everything between a world and whoever decides for its fish:
 * the scenario's event, the fixed-step clock, who gets asked and when, the request and spend
 * cap, applying each answer at the tick it arrived, and the log a recording is made of.
 *
 * A decider plugs in at one seam, `Decider`, and a timing says how the session calls it:
 *
 * - "every": the world waits; every live fish is decided every `ticks` ticks (the page's evolved
 *   policy, training, the held-out table).
 * - "rate": the world waits; the most urgent fish get `perSecond` decisions a world second.
 * - "live": the world never waits. Up to `batch` of the most urgent fish per ask, one ask in
 *   flight, the next no sooner than `everyTicks` ticks after the last, so a decider that answers
 *   instantly is paced by the world, not by how fast it answers. A cap stops a run after so many
 *   requests or so much spend.
 *
 * A recording is the other kind of decider: its batches and events are played back at the
 * ticks they were logged, in log order. Recording is a live session with the Jev adapter and
 * `keepLog`; replaying is a session with the recording.
 */
import { advance, applyDecisions, createReef, due, STEP, trigger, type Decision, type EventKind, type Fish, type World } from "./engine";
import { RACE, type Entry, type Recording } from "./replay";

/** What a decider gives back: decisions, or decisions with what the request cost. Null: no answer this time. */
export type Reply = Decision[] | { decisions: Decision[]; latencyMs: number | null; inputTokens?: number | null; costUsd?: number | null; servedBy?: string | null } | null;

/** The seam: decides now for these fish. May throw to stop the run's asking (a rejected key). */
export type Asked = { name: string; decide(w: World, fish: Fish[]): Reply | Promise<Reply> };

/** A recorded run, played back as it happened. */
export type Played = { name: string; recording: Recording };

export type Decider = Asked | Played;

export type Cap = { requests: number; usd: number };

export type Timing = { kind: "every"; ticks: number } | { kind: "rate"; perSecond: number } | { kind: "live"; batch: number; everyTicks: number; cap?: Cap };

export type Scenario = {
  seed: number;
  /** The scenario's event, at `eventAt` world seconds; null for none (a recording brings its own). */
  event: EventKind | null;
  eventAt: number;
  /** Infinity for a reef that never ends. */
  seconds: number;
};

/** Why a live run stopped asking: its cap, or a failure that won't fix itself. */
export type Stopped = { reason: "cap"; cap: Cap } | { reason: "failed"; error: unknown };

export type RunStats = { requests: number; failures: number; usd: number; decisions: number; latencies: number[] };

export type Session = ReturnType<typeof createSession>;

const decisionsOf = (r: Exclude<Reply, null>) => (Array.isArray(r) ? r : r.decisions);

export function createSession(scenario: Scenario, options: { keepLog?: boolean } = {}) {
  const world = createReef(scenario.seed);
  const log: Entry[] = [];
  let fired = false;
  let decider: Decider | null | undefined;
  let timing: Timing | null = null;
  /** Bumped by `use`, so an answer for an earlier run is dropped. */
  let run = 0;
  let credit = 0;
  let nextAsk = 0;
  let inFlight = false;
  let stopped: Stopped | null = null;
  let played = 0;
  let stats: RunStats = { requests: 0, failures: 0, usd: 0, decisions: 0, latencies: [] };

  const apply = (r: Exclude<Reply, null>) => {
    const decisions = decisionsOf(r);

    if (options.keepLog) {
      const meta = Array.isArray(r) ? null : r;

      log.push({ kind: "batch", tick: world.tick, latencyMs: meta?.latencyMs ?? null, inputTokens: meta?.inputTokens ?? null, costUsd: meta?.costUsd ?? null, servedBy: meta?.servedBy ?? null, decisions });
    }

    applyDecisions(world, decisions);
  };

  const fire = (kind: EventKind) => {
    trigger(world, kind);

    if (options.keepLog) log.push({ kind: "event", tick: world.tick, event: kind });
  };

  /** Sends one live ask; its answer is applied at whatever tick the world has reached when it arrives. */
  const ask = (d: Asked, t: Extract<Timing, { kind: "live" }>) => {
    if (t.cap && (stats.requests >= t.cap.requests || stats.usd >= t.cap.usd)) {
      stopped = { reason: "cap", cap: t.cap };

      return;
    }

    const fish = due(world, t.batch);

    if (!fish.length) return;

    const mine = run;

    inFlight = true;
    nextAsk = world.tick + Math.max(1, t.everyTicks);
    stats.requests++;

    const settle = (r: Reply) => {
      if (mine !== run) return;

      inFlight = false;

      if (!r) stats.failures++;
      else {
        const meta = Array.isArray(r) ? null : r;

        stats.usd += meta?.costUsd ?? 0;
        stats.decisions += decisionsOf(r).length;
        stats.latencies = [...stats.latencies.slice(-59), meta?.latencyMs ?? decisionsOf(r)[0]?.latencyMs ?? 0];
        apply(r);
      }

      // A slow answer that arrives after the next decision point is followed at once; a fast
      // one waits for the world to get there.
      if (!stopped && world.tick >= nextAsk && !session.done()) ask(d, t);
    };

    try {
      const r = d.decide(world, fish);

      if (r instanceof Promise)
        r.then(settle, (error) => {
          if (mine !== run) return;
          inFlight = false;
          stopped = { reason: "failed", error };
        });
      else settle(r);
    } catch (error) {
      inFlight = false;
      stopped = { reason: "failed", error };
    }
  };

  /** The lockstep part of a step: the world waits for these. */
  const decideNow = (d: Asked, t: Timing): Reply | Promise<Reply> | undefined => {
    if (t.kind === "every") return world.tick % t.ticks === 0 ? d.decide(world, world.fish.filter((f) => f.alive)) : undefined;

    if (t.kind === "rate") {
      credit += t.perSecond / 30;

      const n = Math.floor(credit);

      if (n > 0) {
        credit -= n;

        const fish = due(world, n);

        if (fish.length) return d.decide(world, fish);
      }
    }

    return undefined;
  };

  const session = {
    world,
    scenario,
    /** Events and batches as they happened (with `keepLog`): the recording of this run. */
    log,
    get decider() {
      return decider;
    },
    /** This run's requests, failures and spend (live timing), reset by `use`. */
    get stats(): Readonly<RunStats> {
      return stats;
    },
    get stopped() {
      return stopped;
    },
    get inFlight() {
      return inFlight;
    },
    /** True once a decider (or nobody, `null`) has been chosen. */
    get ready() {
      return decider !== undefined;
    },
    done: () => world.time >= scenario.seconds,

    /** Who decides from now on, and how they're asked. Starts a new run: the cap and stats reset and an answer in flight is dropped. */
    use(next: Decider | null, how: Timing | null = null) {
      run++;
      decider = next;
      timing = how;
      credit = 0;
      nextAsk = world.tick;
      inFlight = false;
      stopped = null;
      stats = { requests: 0, failures: 0, usd: 0, decisions: 0, latencies: [] };

      if (next && "recording" in next) played = 0;
    },

    /** An event now, by hand (the page's buttons), logged like the scenario's. */
    trigger: fire,

    /**
     * One fixed step: recorded entries due now, the scenario's event, lockstep decisions, a live
     * ask if one is due, then the world advances. Returns a promise only when a lockstep decider's
     * answer is one; the world waits for it.
     */
    step(): void | Promise<void> {
      if (decider && "recording" in decider) {
        const entries = decider.recording.entries;

        while (played < entries.length && entries[played].tick <= world.tick) {
          const e = entries[played++];

          if (e.kind === "event") fire(e.event);
          else apply(e.decisions);
        }
      }

      if (scenario.event && !fired && world.time >= scenario.eventAt) {
        fired = true;
        fire(scenario.event);
      }

      if (decider && "decide" in decider && timing) {
        if (timing.kind === "live") {
          if (!inFlight && !stopped && world.tick >= nextAsk) ask(decider, timing);
        } else {
          const r = decideNow(decider, timing);

          if (r instanceof Promise)
            return r.then((x) => {
              if (x) apply(x);
              advance(world);
            });

          if (r) apply(r);
        }
      }

      advance(world);
    },
  };

  return session;
}

/** The race: the recorded run's seed, its heatwave at 15 s, 60 s in all. */
export const RACE_SCENARIO: Scenario = { seed: RACE.seed, event: "heatwave", eventAt: RACE.heatwaveAt, seconds: RACE.seconds };

/** The scenario a recording was made in; its events come from its log. */
export const scenarioOf = (rec: Recording): Scenario => ({ seed: rec.seed, event: null, eventAt: Infinity, seconds: rec.seconds });

/** A session playing a recording back. */
export function replaySession(rec: Recording) {
  const s = createSession(scenarioOf(rec));

  s.use({ name: rec.model, recording: rec });

  return s;
}

/**
 * The wall clock for a session on screen: how many fixed steps to take now. At most `maxSteps`
 * a call; if it falls further behind than that, it drops the time rather than racing to catch up.
 */
export function wallClock({ maxDt = 0.25, maxSteps = 6 } = {}) {
  let last: number | null = null;
  let acc = 0;

  return (nowMs: number, running = true) => {
    const dt = last === null ? 0 : Math.min(maxDt, (nowMs - last) / 1000);
    let n = 0;

    last = nowMs;

    if (!running) return 0;

    acc += dt;

    while (acc >= STEP && n < maxSteps) {
      acc -= STEP;
      n++;
    }

    if (acc > STEP * maxSteps) acc = 0;

    return n;
  };
}
