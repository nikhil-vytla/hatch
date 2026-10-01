/**
 * The rumour mill's spread engine. A message is pinned on one block's noticeboard; anyone who
 * believes it passes it to neighbours for a while; each resident who hears it waits for their
 * profile's answer, then acts on one draw from it. The world never waits for a model: residents
 * whose answer hasn't arrived stay "thinking" while the rest of the town carries on.
 */
import { profileKey, type Action, type Dist, type MessageKind, type Source } from "./profiles";
import { PLACES, rng, type PlaceId, type Town } from "./town";

export const TICK = 0.35;

/** How long a believer keeps passing it on, in world seconds. */
const SHARE_FOR = 2.8;

/** World seconds to walk to the place. */
const WALK = 6;

export const Status = { Unaware: 0, Thinking: 1, Decided: 2 } as const;

export type Message = { kind: MessageKind; text: string; place: PlaceId | null; block: number; at: number };

export type Track = {
  message: Message;
  status: Uint8Array;
  action: (Action | null)[];
  heardAt: Float32Array;
  decidedAt: Float32Array;
  from: Int32Array;
  source: Source[];
  /** Answers per profile key, from whichever model decides this track. */
  answers: Map<string, Dist>;
};

export type World = {
  town: Town;
  time: number;
  carry: number;
  next: () => number;
  rumour: Track | null;
  counter: Track | null;
  /** Believers over time, sampled each tick, for the spread curve. */
  curve: { t: number; heard: number; believe: number; argue: number }[];
};

export function createWorld(town: Town, seed = 1): World {
  return { town, time: 0, carry: 0, next: rng(seed), rumour: null, counter: null, curve: [] };
}

function track(town: Town, message: Message): Track {
  const n = town.residents.length;

  return {
    message,
    status: new Uint8Array(n),
    action: new Array(n).fill(null),
    heardAt: new Float32Array(n),
    decidedAt: new Float32Array(n),
    from: new Int32Array(n).fill(-1),
    source: new Array(n).fill("neighbour"),
    answers: new Map(),
  };
}

/** Pin a message on a block's noticeboard: the first few residents there hear it. */
export function pin(w: World, kind: MessageKind, text: string, place: PlaceId | null, block: number) {
  const t = track(w.town, { kind, text, place, block, at: w.time });
  const local = w.town.residents.filter((r) => r.block === block).slice(0, 8);

  for (const r of local) hear(t, r.id, -1, "noticeboard", w.time);

  if (kind === "rumour") {
    w.rumour = t;
    w.counter = null;
    w.curve = [];
  } else w.counter = t;

  return t;
}

function hear(t: Track, id: number, from: number, source: Source, at: number) {
  if (t.status[id] !== Status.Unaware) return;

  t.status[id] = Status.Thinking;
  t.heardAt[id] = at;
  t.from[id] = from;
  t.source[id] = source;
}

/** The profile key a resident decides under, for this track. */
export function keyFor(w: World, t: Track, id: number) {
  const r = w.town.residents[id];
  const believed = t.message.kind === "counter" ? believes(w.rumour, id) : undefined;

  return profileKey({ archetype: r.archetype, trusting: r.trust >= 0.5, source: t.source[id], believed });
}

export const believes = (t: Track | null, id: number) => !!t && (t.action[id] === "share" || t.action[id] === "go");

/** Profiles some resident is waiting on that have no answer yet. */
export function waitingProfiles(w: World, t: Track) {
  const keys = new Set<string>();

  for (let i = 0; i < t.status.length; i++) if (t.status[i] === Status.Thinking) keys.add(keyFor(w, t, i));

  return [...keys].filter((k) => !t.answers.has(k));
}

function draw(d: Dist, u: number): Action {
  let acc = 0;

  for (const a of ["ignore", "share", "go", "argue"] as const) {
    acc += d[a];

    if (u < acc) return a;
  }

  return "ignore";
}

/** One tick: decide everyone whose answer has arrived, then believers pass it on. */
function tick(w: World, t: Track) {
  const { residents, links } = w.town;

  for (let i = 0; i < t.status.length; i++) {
    if (t.status[i] !== Status.Thinking) continue;

    const d = t.answers.get(keyFor(w, t, i));

    if (!d) continue;

    let a = draw(d, w.next());

    if (a === "go" && !t.message.place) a = "share";

    t.status[i] = Status.Decided;
    t.action[i] = a;
    t.decidedAt[i] = w.time;
  }

  const spreaders: number[] = [];

  for (let i = 0; i < t.status.length; i++)
    if ((t.action[i] === "share" || t.action[i] === "go") && w.time - t.decidedAt[i] < SHARE_FOR) spreaders.push(i);

  for (const i of spreaders) {
    // Someone corrected stops passing the rumour on.
    if (t.message.kind === "rumour" && believes(w.counter, i)) continue;

    const p = 0.12 + 0.3 * residents[i].chatty;

    for (const j of links[i]) if (t.status[j] === Status.Unaware && w.next() < p) hear(t, j, i, residents[i].hub ? "hub" : "neighbour", w.time);
  }
}

export type Counts = { heard: number; thinking: number; believe: number; going: number; arrived: number; argue: number; ignore: number; corrected: number };

export function counts(w: World): Counts {
  const c: Counts = { heard: 0, thinking: 0, believe: 0, going: 0, arrived: 0, argue: 0, ignore: 0, corrected: 0 };
  const t = w.rumour;

  if (!t) return c;

  for (let i = 0; i < t.status.length; i++) {
    if (t.status[i] === Status.Unaware) continue;

    c.heard++;

    const corrected = believes(w.counter, i);

    if (corrected) c.corrected++;

    if (t.status[i] === Status.Thinking) c.thinking++;
    else if (believes(t, i) && !corrected) {
      c.believe++;

      if (t.action[i] === "go") {
        c.going++;

        if (w.time - t.decidedAt[i] >= WALK) c.arrived++;
      }
    } else if (t.action[i] === "argue") c.argue++;
    else c.ignore++;
  }

  return c;
}

/** Advance world time; ticks run at a fixed rate whatever the frame rate. */
export function advance(w: World, dt: number) {
  w.time += dt;
  w.carry += dt;

  while (w.carry >= TICK) {
    w.carry -= TICK;

    if (w.rumour) tick(w, w.rumour);

    if (w.counter) tick(w, w.counter);

    if (w.rumour) {
      const c = counts(w);

      w.curve.push({ t: w.time, heard: c.heard, believe: c.believe, argue: c.argue + c.corrected });
    }
  }
}

/** Nothing left to happen: nobody thinking or still passing it on. */
export function settled(w: World) {
  for (const t of [w.rumour, w.counter]) {
    if (!t) continue;

    for (let i = 0; i < t.status.length; i++) {
      if (t.status[i] === Status.Thinking) return false;

      if ((t.action[i] === "share" || t.action[i] === "go") && w.time - t.decidedAt[i] < SHARE_FOR) return false;

      // Still walking to the place.
      if (t.action[i] === "go" && w.time - t.decidedAt[i] < WALK) return false;
    }
  }

  return !!w.rumour;
}

/** Where a resident is drawn now: home, or partway to the place they set off for. */
export function position(w: World, id: number) {
  const r = w.town.residents[id];
  const t = w.rumour;

  if (!t || t.action[id] !== "go" || believes(w.counter, id) || !t.message.place) return { x: r.x, y: r.y };

  const place = PLACES.find((p) => p.id === t.message.place);

  if (!place) return { x: r.x, y: r.y };

  const k = Math.min(1, (w.time - t.decidedAt[id]) / WALK);
  const e = k * k * (3 - 2 * k);
  // Arrivals gather in a crowd around the place, clear of its label.
  const angle = ((id * 2654435761) % 6283) / 1000;
  const radius = 20 + 36 * Math.sqrt(((id * 40503) % 997) / 997);
  const tx = place.x + Math.cos(angle) * radius * 1.4;
  const ty = place.y + Math.sin(angle) * radius;

  return { x: r.x + (tx - r.x) * e, y: r.y + (ty - r.y) * e };
}

/** Run a whole spread with fixed answers, as fast as possible (for curves and tests). */
export function simulate(town: Town, kind: MessageKind, text: string, place: PlaceId | null, block: number, answers: Map<string, Dist>, seed = 1, until = 60) {
  const w = createWorld(town, seed);
  const t = pin(w, kind, text, place, block);

  t.answers = answers;

  while (w.time < until && !settled(w)) advance(w, TICK);

  return w;
}
