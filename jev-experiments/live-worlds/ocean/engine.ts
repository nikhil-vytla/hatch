/**
 * The reef: a seeded, fixed-step ocean ecosystem. Reef fish choose what to do (a typed
 * decision from their local view); code moves everyone, runs hunger, predators, births,
 * inheritance and events. Sharks and turtles are code. A fish without a fresh decision keeps
 * its last action: the world never waits for a model.
 *
 * Everything random comes from the world's own generator, so the same seed, events and
 * decisions applied at the same ticks give the same reef (that is how a recorded run replays).
 */
export const STEP = 1 / 30;
export const WIDTH = 960;
export const HEIGHT = 560;
export const SAND = 500;
/** A decision older than this (world seconds) counts as stale. */
export const STALE_AFTER = 3;
export const MAX_FISH = 180;

export const ACTIONS = ["school", "forage", "hide", "flee", "follow", "signal", "rest"] as const;
export type Action = (typeof ACTIONS)[number];
export type EventKind = "heatwave" | "storm" | "net" | "bloom" | "oil";
export type Cause = "eaten" | "starved" | "net" | "oil" | "old age";
export type Traits = { speed: number; sight: number; school: number; thrift: number };

export type Fish = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  energy: number;
  age: number;
  gen: number;
  parent: number | null;
  traits: Traits;
  hue: number;
  alive: boolean;
  cause?: Cause;
  diedAt?: number;
  hidden: boolean;
  action: Action;
  /** World time the current action was decided; -Infinity before any decision. */
  decidedAt: number;
  decidedBy: string;
  probabilities: Partial<Record<Action, number>> | null;
  latencyMs: number | null;
  signal: { kind: "danger" | "food"; until: number } | null;
  history: { at: number; action: Action; by: string; p: number | null }[];
  bornAt: number;
};

export type Shark = { id: number; x: number; y: number; vx: number; vy: number; energy: number; cooldown: number; alive: boolean };
export type Turtle = { id: number; x: number; y: number; vx: number; vy: number };
export type Coral = { id: number; x: number; y: number; r: number; health: number; hue: number };
export type Food = { x: number; y: number; vy: number };
export type ActiveEvent = { kind: EventKind; start: number; end: number; x: number; y: number; cohort: number[]; reported: boolean };

export type Sample = { t: number; fish: number; sharks: number; stale: number; energy: number };

export type World = {
  seed: number;
  rng: number;
  tick: number;
  time: number;
  nextId: number;
  fish: Fish[];
  sharks: Shark[];
  turtles: Turtle[];
  coral: Coral[];
  food: Food[];
  events: ActiveEvent[];
  current: { x: number; y: number };
  births: number;
  deaths: Record<Cause, number>;
  samples: Sample[];
  decisions: number;
  /** Results of finished events: share of the cohort alive when it was reported. */
  outcomes: { kind: EventKind; at: number; cohort: number; survived: number }[];
};

export function random(w: { rng: number }) {
  w.rng = (w.rng + 0x6d2b79f5) | 0;

  let t = Math.imul(w.rng ^ (w.rng >>> 15), 1 | w.rng);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

// Math.sin, cos and hypot differ in their last bits between JavaScript engines (Bun and Chrome
// disagree), and a recorded run must replay identically in any browser. So the engine uses only
// + − × ÷ and sqrt, which IEEE 754 makes exact everywhere.
const hypot = (x: number, y: number) => Math.sqrt(x * x + y * y);

function sin(x: number) {
  let r = x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

  if (r > Math.PI / 2) r = Math.PI - r;
  else if (r < -Math.PI / 2) r = -Math.PI - r;

  const r2 = r * r;

  return r * (1 - (r2 / 6) * (1 - (r2 / 20) * (1 - (r2 / 42) * (1 - (r2 / 72) * (1 - r2 / 110)))));
}

const cos = (x: number) => sin(x + Math.PI / 2);

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => hypot(a.x - b.x, a.y - b.y);

export const DURATION: Record<EventKind, number> = { heatwave: 25, storm: 12, net: 10, bloom: 15, oil: 30 };

export function eventActive(w: World, kind: EventKind) {
  return w.events.find((e) => e.kind === kind && w.time >= e.start && w.time < e.end);
}

function newFish(w: World, x: number, y: number, traits: Traits, gen: number, parent: number | null): Fish {
  return {
    id: w.nextId++,
    x,
    y,
    vx: (random(w) - 0.5) * 40,
    vy: (random(w) - 0.5) * 20,
    energy: 0.55 + random(w) * 0.3,
    age: 0,
    gen,
    parent,
    traits,
    hue: 180 + traits.speed * 120 - traits.thrift * 60,
    alive: true,
    hidden: false,
    action: "school",
    decidedAt: -Infinity,
    decidedBy: "none yet",
    probabilities: null,
    latencyMs: null,
    signal: null,
    history: [],
    bornAt: w.time,
  };
}

export function createReef(seed = 7, fishCount = 120): World {
  const w: World = {
    seed,
    rng: seed,
    tick: 0,
    time: 0,
    nextId: 1,
    fish: [],
    sharks: [],
    turtles: [],
    coral: [],
    food: [],
    events: [],
    current: { x: 0, y: 0 },
    births: 0,
    deaths: { eaten: 0, starved: 0, net: 0, oil: 0, "old age": 0 },
    samples: [],
    decisions: 0,
    outcomes: [],
  };

  for (let i = 0; i < 9; i++)
    w.coral.push({ id: i, x: 70 + i * 103 + (random(w) - 0.5) * 40, y: SAND - 10 - random(w) * 30, r: 30 + random(w) * 22, health: 1, hue: random(w) });

  for (let i = 0; i < fishCount; i++) {
    const traits = { speed: random(w), sight: random(w), school: random(w), thrift: random(w) };

    w.fish.push(newFish(w, 80 + random(w) * (WIDTH - 160), 80 + random(w) * (SAND - 180), traits, 0, null));
  }

  for (let i = 0; i < 3; i++)
    w.sharks.push({ id: w.nextId++, x: random(w) * WIDTH, y: 60 + random(w) * 200, vx: 30, vy: 0, energy: 0.7, cooldown: 0, alive: true });

  for (let i = 0; i < 2; i++) w.turtles.push({ id: w.nextId++, x: random(w) * WIDTH, y: 120 + random(w) * 200, vx: 18, vy: 0 });

  for (let i = 0; i < 60; i++) spawnFood(w);

  return w;
}

function spawnFood(w: World, x?: number, y?: number) {
  w.food.push({ x: x ?? random(w) * WIDTH, y: y ?? 40 + random(w) * (SAND - 120), vy: 4 + random(w) * 6 });
}

export function trigger(w: World, kind: EventKind) {
  const alive = w.fish.filter((f) => f.alive).map((f) => f.id);

  w.events.push({ kind, start: w.time, end: w.time + DURATION[kind], x: 120 + random(w) * (WIDTH - 240), y: 20, cohort: alive, reported: false });
}

export function dropFood(w: World, x: number, y: number) {
  for (let i = 0; i < 16; i++) spawnFood(w, x + (random(w) - 0.5) * 50, y + (random(w) - 0.5) * 30);
}

/** What one fish can see, in the words both models get. */
export type View = {
  id: number;
  energy: "low" | "medium" | "high";
  predator: { distance: "very close" | "close" | "far"; side: "left" | "right" | "above" | "below" } | null;
  food: number;
  coral: "healthy" | "bleached" | null;
  neighbours: number;
  signal: "danger" | "food" | null;
  water: string[];
  options: Action[];
};

export const sightOf = (f: Fish) => 70 + f.traits.sight * 90;

export function view(w: World, f: Fish): View {
  const sight = sightOf(f);
  const shark = nearest(w.sharks.filter((s) => s.alive), f, sight);
  const nearCoral = nearest(w.coral, f, sight * 1.4);
  const neighbours = w.fish.filter((o) => o.alive && o !== f && dist(o, f) < sight);
  const heard = neighbours.find((o) => o.signal && o.signal.until > w.time)?.signal?.kind ?? null;
  const food = w.food.filter((p) => dist(p, f) < sight).length;
  const water: string[] = [];

  if (eventActive(w, "heatwave")) water.push("the water is unusually hot");

  if (eventActive(w, "storm")) water.push("a storm is churning the water");

  if (eventActive(w, "net")) water.push("a fishing net is sweeping the reef");

  if (inOil(w, f)) water.push("oil is in the water here");

  let predator: View["predator"] = null;

  if (shark) {
    const d = dist(shark, f);
    const dx = shark.x - f.x;
    const dy = shark.y - f.y;

    predator = {
      distance: d < sight * 0.35 ? "very close" : d < sight * 0.7 ? "close" : "far",
      side: Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "above" : "below",
    };
  }

  const coral = nearCoral ? (nearCoral.health > 0.35 ? "healthy" : "bleached") : null;
  const options: Action[] = ["school", "forage", "rest"];

  if (coral === "healthy") options.push("hide");

  if (predator || eventActive(w, "net")) options.push("flee");

  if (predator) options.push("signal");

  if (heard === "food") options.push("follow");

  return {
    id: f.id,
    energy: f.energy < 0.3 ? "low" : f.energy < 0.65 ? "medium" : "high",
    predator,
    food,
    coral,
    neighbours: neighbours.length,
    signal: heard,
    water,
    options,
  };
}

function nearest<T extends { x: number; y: number }>(list: T[], from: { x: number; y: number }, within: number): T | null {
  let best: T | null = null;
  let bd = within;

  for (const item of list) {
    const d = dist(item, from);

    if (d < bd) {
      bd = d;
      best = item;
    }
  }

  return best;
}

/** The net's x position: it sweeps the whole reef left to right over its duration. */
export const netX = (w: World, e: ActiveEvent) => ((w.time - e.start) / DURATION.net) * (WIDTH + 40) - 20;

export function inOil(w: World, p: { x: number; y: number }) {
  const oil = eventActive(w, "oil");

  if (!oil) return false;

  const r = 40 + (w.time - oil.start) * 9;

  return hypot(p.x - oil.x, (p.y - 30) * 1.6) < r;
}

/**
 * The fish most in need of a decision, most urgent first: the oldest decisions, with a boost
 * for a fish that sees danger and isn't already fleeing or hiding. Same rule for every model.
 */
export function due(w: World, n: number): Fish[] {
  const score = (f: Fish) => {
    const age = Math.min(30, w.time - f.decidedAt);
    const sees = w.sharks.some((s) => s.alive && dist(s, f) < sightOf(f) * 0.7);

    return age + (sees && f.action !== "flee" && f.action !== "hide" ? 6 : 0);
  };

  return w.fish
    .filter((f) => f.alive)
    .map((f) => [f, score(f)] as const)
    .filter(([, s]) => s > 0.6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([f]) => f);
}

export type Decision = { id: number; action: Action; probabilities: Partial<Record<Action, number>> | null; by: string; latencyMs: number | null };

/** Applies decisions at the current tick. Illegal actions (not in the fish's options) are refused. */
export function applyDecisions(w: World, decisions: Decision[]) {
  let applied = 0;

  for (const d of decisions) {
    const f = w.fish.find((x) => x.id === d.id);

    if (!f || !f.alive || !view(w, f).options.includes(d.action)) continue;

    f.action = d.action;
    f.decidedAt = w.time;
    f.decidedBy = d.by;
    f.probabilities = d.probabilities;
    f.latencyMs = d.latencyMs;
    f.history = [{ at: w.time, action: d.action, by: d.by, p: d.probabilities?.[d.action] ?? null }, ...f.history].slice(0, 6);

    if (d.action === "signal") {
      const v = view(w, f);

      f.signal = { kind: v.predator ? "danger" : "food", until: w.time + 3 };
    }

    applied++;
  }

  w.decisions += applied;

  return applied;
}

export const staleShare = (w: World) => {
  const alive = w.fish.filter((f) => f.alive);

  return alive.length ? alive.filter((f) => w.time - f.decidedAt > STALE_AFTER).length / alive.length : 0;
};

function steer(f: { vx: number; vy: number }, tx: number, ty: number, strength: number) {
  const m = hypot(tx, ty) || 1;

  f.vx += (tx / m) * strength;
  f.vy += (ty / m) * strength;
}

function kill(w: World, f: Fish, cause: Cause) {
  f.alive = false;
  f.cause = cause;
  f.diedAt = w.time;
  w.deaths[cause]++;
}

/** Advances one fixed step. */
export function advance(w: World, dt = STEP) {
  w.tick++;
  w.time = w.tick * STEP;

  const heat = eventActive(w, "heatwave");
  const storm = eventActive(w, "storm");
  const bloom = eventActive(w, "bloom");
  const net = eventActive(w, "net");

  w.current = storm ? { x: sin(w.time * 0.7) * 70, y: cos(w.time * 0.4) * 25 } : { x: sin(w.time * 0.05) * 6, y: 0 };

  // Coral: heat bleaches, calm water slowly heals; oil damages what it covers.
  for (const c of w.coral) {
    if (heat) c.health = clamp(c.health - 0.035 * dt);
    else c.health = clamp(c.health + 0.004 * dt);

    if (inOil(w, c)) c.health = clamp(c.health - 0.02 * dt);
  }

  // Plankton: grows from healthy coral; heat starves it, a bloom floods it.
  const healthy = w.coral.reduce((s, c) => s + c.health, 0) / w.coral.length;
  // Pellets per second: about 12 on a healthy reef, a quarter of that in a heatwave.
  const productivity = (2 + 10 * healthy) * (heat ? 0.25 : 1) * (bloom ? 3 : 1);

  for (let k = productivity * dt; k > 0; k--) {
    if (random(w) >= Math.min(1, k) || w.food.length >= 400) continue;

    const c = w.coral[Math.floor(random(w) * w.coral.length)];

    spawnFood(w, c.x + (random(w) - 0.5) * 120, 60 + random(w) * (SAND - 140));
  }

  for (const p of w.food) {
    p.y += (p.vy * 0.15 + w.current.y * 0.3) * dt;
    p.x += w.current.x * 0.6 * dt;
  }

  w.food = w.food.filter((p) => p.x > -10 && p.x < WIDTH + 10 && p.y < SAND);

  const sharks = w.sharks.filter((s) => s.alive);
  const alive = w.fish.filter((f) => f.alive);

  for (const f of alive) {
    f.age += dt;

    const sight = sightOf(f);
    const base = 38 + f.traits.speed * 34;
    let speed = base;
    let burn = 0.007 * (1 + f.traits.speed * 0.9 + f.traits.sight * 0.4) * (1 - f.traits.thrift * 0.4);

    if (heat) burn *= 1.5;

    const shark = nearest(sharks, f, sight);

    f.hidden = false;

    switch (f.action) {
      case "forage": {
        const target = nearest(w.food, f, sight);

        if (target) steer(f, target.x - f.x, target.y - f.y, 120 * dt);
        else steer(f, cos(f.id + w.time * 0.3), sin(f.id * 1.7 + w.time * 0.2), 40 * dt);

        break;
      }

      case "hide": {
        const c = nearest(
          w.coral.filter((x) => x.health > 0.35),
          f,
          sight * 2,
        );

        if (c) {
          steer(f, c.x - f.x, c.y - f.y, 140 * dt);

          if (dist(c, f) < c.r) {
            f.hidden = true;
            speed *= 0.35;
          }
        }

        burn *= 0.7;
        break;
      }

      case "flee": {
        const threat = shark ?? (net ? { x: netX(w, net) - 30, y: f.y } : null);

        if (threat) steer(f, f.x - threat.x, f.y - threat.y, 220 * dt);

        speed *= 1.6;
        burn *= 2;
        break;
      }

      case "follow": {
        const caller = alive.find((o) => o !== f && o.signal?.kind === "food" && o.signal.until > w.time && dist(o, f) < sight * 1.5);

        if (caller) steer(f, caller.x - f.x, caller.y - f.y, 120 * dt);

        break;
      }

      case "rest":
        speed *= 0.3;
        burn *= 0.45;
        break;

      default:
        break;
    }

    // Schooling: everyone keeps a little; schoolers and signallers keep more.
    const pull = f.action === "school" || f.action === "signal" ? 0.6 + f.traits.school : 0.15 + f.traits.school * 0.2;
    let cx = 0;
    let cy = 0;
    let ax = 0;
    let ay = 0;
    let n = 0;

    for (const o of alive) {
      if (o === f) continue;

      const d = dist(o, f);

      if (d < 14) steer(f, f.x - o.x, f.y - o.y, 90 * dt);

      if (d < sight * 0.6) {
        cx += o.x;
        cy += o.y;
        ax += o.vx;
        ay += o.vy;
        n++;
      }
    }

    if (n) {
      steer(f, cx / n - f.x, cy / n - f.y, pull * 50 * dt);
      steer(f, ax / n, ay / n, pull * 40 * dt);
    }

    // Walls, sand and surface.
    if (f.x < 30) f.vx += 160 * dt;

    if (f.x > WIDTH - 30) f.vx -= 160 * dt;

    if (f.y < 30) f.vy += 160 * dt;

    if (f.y > SAND - 20) f.vy -= 200 * dt;

    const v = hypot(f.vx, f.vy) || 1;

    if (v > speed) {
      f.vx = (f.vx / v) * speed;
      f.vy = (f.vy / v) * speed;
    }

    f.x += (f.vx + w.current.x) * dt;
    f.y += (f.vy + w.current.y) * dt;

    // Eating.
    for (let i = w.food.length - 1; i >= 0; i--) {
      if (dist(w.food[i], f) < 8) {
        f.energy = clamp(f.energy + 0.22 * (1 - f.traits.thrift * 0.3));
        w.food.splice(i, 1);
        break;
      }
    }

    f.energy = clamp(f.energy - burn * dt - (inOil(w, f) ? 0.06 * dt : 0));

    if (f.signal && f.signal.until <= w.time) f.signal = null;

    if (f.energy <= 0) kill(w, f, inOil(w, f) ? "oil" : "starved");
    else if (f.age > 150 + f.traits.thrift * 40) kill(w, f, "old age");
    else if (net && !f.hidden) {
      if (Math.abs(f.x - netX(w, net)) < 12 && f.y > 40 && f.y < SAND - 60) kill(w, f, "net");
    }

    // Births: a well-fed adult spawns one young with mutated traits.
    if (f.alive && f.energy > 0.88 && f.age > 18 && w.fish.filter((x) => x.alive).length < MAX_FISH) {
      const m = (v: number) => clamp(v + (random(w) - 0.5) * 0.16);
      const child = newFish(
        w,
        f.x + (random(w) - 0.5) * 10,
        f.y + (random(w) - 0.5) * 10,
        { speed: m(f.traits.speed), sight: m(f.traits.sight), school: m(f.traits.school), thrift: m(f.traits.thrift) },
        f.gen + 1,
        f.id,
      );

      child.energy = 0.45;
      f.energy -= 0.42;
      w.fish.push(child);
      w.births++;
    }
  }

  // Sharks: code. Chase the nearest fish that isn't hidden in healthy coral.
  for (const s of sharks) {
    s.cooldown = Math.max(0, s.cooldown - dt);
    s.energy = clamp(s.energy - 0.012 * dt);

    const prey = nearest(
      alive.filter((f) => f.alive && !f.hidden),
      s,
      170,
    );

    if (prey && s.cooldown === 0) steer(s, prey.x - s.x, prey.y - s.y, 90 * dt);
    else steer(s, cos(s.id + w.time * 0.2), sin(s.id + w.time * 0.13) * 0.4, 30 * dt);

    const v = hypot(s.vx, s.vy) || 1;
    const top = s.cooldown > 0 ? 30 : 64;

    if (v > top) {
      s.vx = (s.vx / v) * top;
      s.vy = (s.vy / v) * top;
    }

    if (s.y < 40) s.vy += 80 * dt;

    if (s.y > SAND - 40) s.vy -= 80 * dt;

    s.x += s.vx * dt;
    s.y += s.vy * dt;

    if (s.x < -40) s.x = WIDTH + 40;

    if (s.x > WIDTH + 40) s.x = -40;

    if (prey && s.cooldown === 0 && dist(prey, s) < 12) {
      kill(w, prey, "eaten");
      s.energy = clamp(s.energy + 0.3);
      s.cooldown = 2.5;
    }

    if (s.energy <= 0) s.alive = false;
  }

  // A shark wanders in when the reef has few.
  if (w.sharks.filter((s) => s.alive).length < 2 && random(w) < 0.02 * dt)
    w.sharks.push({ id: w.nextId++, x: random(w) < 0.5 ? -30 : WIDTH + 30, y: 80 + random(w) * 200, vx: 0, vy: 0, energy: 0.7, cooldown: 0, alive: true });

  for (const t of w.turtles) {
    const food = nearest(w.food, t, 90);

    if (food) steer(t, food.x - t.x, food.y - t.y, 20 * dt);
    else steer(t, cos(t.id + w.time * 0.05), sin(t.id + w.time * 0.07) * 0.3, 8 * dt);

    const v = hypot(t.vx, t.vy) || 1;

    if (v > 20) {
      t.vx = (t.vx / v) * 20;
      t.vy = (t.vy / v) * 20;
    }

    t.x = (t.x + t.vx * dt + WIDTH) % WIDTH;
    t.y = clamp(t.y + t.vy * dt, 60, SAND - 60);

    for (let i = w.food.length - 1; i >= 0; i--) if (dist(w.food[i], t) < 14) w.food.splice(i, 1);
  }

  // Bodies sink away after a few seconds.
  w.fish = w.fish.filter((f) => f.alive || w.time - (f.diedAt ?? 0) < 4);

  // Survival of each finished event's cohort, reported 10 s after it ends.
  for (const e of w.events) {
    if (e.reported || w.time < e.end + 10) continue;

    const ids = new Set(e.cohort);
    const survived = w.fish.filter((f) => f.alive && ids.has(f.id)).length;

    e.reported = true;
    w.outcomes.push({ kind: e.kind, at: w.time, cohort: e.cohort.length, survived });
  }

  if (w.tick % 15 === 0) {
    const a = w.fish.filter((f) => f.alive);

    w.samples.push({
      t: w.time,
      fish: a.length,
      sharks: w.sharks.filter((s) => s.alive).length,
      stale: staleShare(w),
      energy: a.length ? a.reduce((s, f) => s + f.energy, 0) / a.length : 0,
    });

    if (w.samples.length > 1200) w.samples.shift();
  }
}

/** Survival so far of the latest event's cohort. */
export function cohortAlive(w: World, e: ActiveEvent) {
  const ids = new Set(e.cohort);

  return w.fish.filter((f) => f.alive && ids.has(f.id)).length;
}

export function traitMeans(w: World): Traits {
  const a = w.fish.filter((f) => f.alive);
  const mean = (k: keyof Traits) => (a.length ? a.reduce((s, f) => s + f.traits[k], 0) / a.length : 0);

  return { speed: mean("speed"), sight: mean("sight"), school: mean("school"), thrift: mean("thrift") };
}

/** A compact fingerprint of the world for determinism checks. */
export function fingerprint(w: World) {
  const a = w.fish.filter((f) => f.alive);

  return `${w.tick}|${a.length}|${w.births}|${Object.values(w.deaths).join(",")}|${a.reduce((s, f) => s + f.x + f.y * 3, 0).toFixed(3)}`;
}
