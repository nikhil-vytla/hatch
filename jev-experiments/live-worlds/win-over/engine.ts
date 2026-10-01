/**
 * Who can you win over? A newcomer in Bramble Square has until 5 pm to win people over.
 *
 * Code owns everything that isn't a judgment: walking, lingering, the clock, who is in earshot,
 * when two residents meet, and the score. A model owns the judgments: what the newcomer meant,
 * whether a resident believes it, whether they warm to the newcomer, what they do next, and
 * whether they believe and pass on gossip. Model answers arrive whenever they arrive; the world
 * never waits for them.
 */

export const VIEW = { width: 900, height: 590 };

export type PlaceId = "cafe" | "bakery" | "library" | "garden" | "stage" | "fountain";

export type Place = { id: PlaceId; name: string; x: number; y: number; color: string };

/** The same six places as The square at five, at the same spots. */
export const PLACES: Place[] = [
  { id: "cafe", name: "Corner Café", x: 172, y: 178, color: "#f0532d" },
  { id: "bakery", name: "Little Bakery", x: 733, y: 177, color: "#ffd23f" },
  { id: "library", name: "Reading Room", x: 159, y: 438, color: "#a9cdfc" },
  { id: "garden", name: "Kitchen Garden", x: 737, y: 446, color: "#9be3c3" },
  { id: "stage", name: "Tiny Stage", x: 462, y: 158, color: "#c9a7f5" },
  { id: "fountain", name: "Fountain Steps", x: 447, y: 437, color: "#a9cdfc" },
];

export const BOARD = { x: 588, y: 318 };

export const place = (id: PlaceId) => PLACES.find((p) => p.id === id) ?? PLACES[0];

export type Goal = { id: "gig" | "cake" | "trust"; title: string; place: PlaceId | null; target: number; event: string };

export const GOALS: Goal[] = [
  { id: "gig", title: "Fill the stage for my gig", place: "stage", target: 20, event: "the newcomer's gig at the Tiny Stage at five" },
  { id: "cake", title: "Get a queue for my cake sale", place: "bakery", target: 15, event: "the newcomer's cake sale at the Little Bakery at five" },
  { id: "trust", title: "Be trusted by 20 people", place: null, target: 20, event: "meeting the newcomer properly before five" },
];

export const goal = (id: Goal["id"]) => GOALS.find((g) => g.id === id) ?? GOALS[0];

export const NAMES = [
  "Mina", "Otis", "Luz", "Eli", "June", "Ivo", "Nia", "Remy", "Ada", "Sol", "Bea", "Kit",
  "Tam", "Wren", "Omar", "Pia", "Hugo", "Lena", "Rafi", "Suki", "Bram", "Cleo", "Dev", "Esme",
  "Fitz", "Gwen", "Hal", "Iris", "Jon", "Kaya", "Lou", "Mags", "Ned", "Oona", "Per", "Quin",
  "Rosa", "Sami", "Theo", "Uma", "Vic", "Wim", "Xena", "Yuri", "Zola", "Abe", "Bex", "Cass",
];

const JOBS = [
  "a bookbinder", "a bicycle mechanic", "a gardener", "a retired teacher", "a night-shift nurse",
  "a bus driver", "a fiddle player", "a baker's apprentice", "a lawyer", "a student", "a painter",
  "a postal worker", "a chef", "a librarian", "a carpenter", "a beekeeper",
];

export const LIKES = ["music", "books", "cake", "plants", "gossip", "quiet", "dancing", "chess", "coffee", "art", "football", "birds"];

export const TEMPERS = ["trusting and warm", "sceptical of strangers", "shy", "chatty", "easily offended", "hard to impress"];

const COLORS = ["#f0532d", "#ffd23f", "#9be3c3", "#a9cdfc", "#c9a7f5", "#f7a8c4", "#f6b26b", "#8fd6e8"];

export type Rumour = { id: number; tone: "warm" | "cold"; says: string; from: string; origin: string };

export type Resident = {
  id: string;
  name: string;
  job: string;
  likes: string[];
  temper: string;
  color: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Seconds left lingering where they are. */
  linger: number;
  /** 0 hostile … 4 fond; everyone starts neutral. */
  mood: number;
  /** What they'll do next because of the newcomer. */
  plan: "approach" | "avoid" | "gossip" | "come" | "carry_on";
  planUntil: number;
  /** The last thing they decided, for the tap-to-read panel. */
  last: Decision | null;
  glyph: "" | "!" | "?" | "♥";
  glyphUntil: number;
  /** A rumour they're carrying, if they decided to pass something on. */
  rumour: Rumour | null;
  heard: number[];
  noticeRead: number;
  /** Seconds until they can meet someone for gossip again. */
  gossipCooldown: number;
  busy: boolean;
};

export type Decision = {
  kind: "hear" | "gossip" | "notice";
  said: string;
  intent?: string;
  intentP?: number;
  /** For a heard line: is the speaker honest? For gossip: does the listener believe the teller? */
  believes: number;
  /** For a heard line: does it come across as friendly, to anyone? */
  friendly?: number;
  /** For a heard line: does this resident like it? */
  warmer?: number;
  action?: Resident["plan"];
  actionP?: number;
  passOn?: number;
  model: string;
  ms: number;
  at: number;
};

export type Bubble = { from: string; to: string; tone: "warm" | "cold"; until: number };

export type World = {
  seed: number;
  rng: number;
  /** Real seconds since the afternoon started. */
  t: number;
  /** Real seconds the afternoon lasts: 1 pm to 5 pm. */
  length: number;
  goal: Goal["id"] | null;
  over: boolean;
  player: { x: number; y: number; tx: number; ty: number };
  residents: Resident[];
  notice: { text: string; revision: number } | null;
  bubbles: Bubble[];
  rumours: number;
  cake: number;
  log: { at: number; text: string }[];
  stats: { decisions: number; ms: number; byModel: Record<string, number> };
  /** Who spread which tone, and how many believed them. */
  spread: Record<string, { warm: number; cold: number }>;
};

export const EARSHOT = 110;

/** Below this, a resident doubts the line ("?"). Small classifiers rate even greetings near 0.3 honest. */
export const DOUBT = 0.15;
const SPEED = 44;
const PLAYER_SPEED = 120;

export function random(w: { rng: number }) {
  w.rng = (w.rng * 1664525 + 1013904223) >>> 0;

  return w.rng / 2 ** 32;
}

const pick = <T>(w: { rng: number }, xs: T[]) => xs[Math.floor(random(w) * xs.length)];

function wanderTarget(w: World) {
  const p = pick(w, PLACES);

  return { x: p.x + (random(w) - 0.5) * 90, y: p.y + 40 + (random(w) - 0.5) * 50 };
}

export function createWorld(seed = 5, count = 48): World {
  const w: World = {
    seed,
    rng: seed,
    t: 0,
    length: 300,
    goal: null,
    over: false,
    player: { x: 450, y: 300, tx: 450, ty: 300 },
    residents: [],
    notice: null,
    bubbles: [],
    rumours: 0,
    cake: 5,
    log: [],
    stats: { decisions: 0, ms: 0, byModel: {} },
    spread: {},
  };

  for (let i = 0; i < count; i++) {
    const start = wanderTarget(w);
    const likes = [pick(w, LIKES), pick(w, LIKES)].filter((x, j, xs) => xs.indexOf(x) === j);
    const target = wanderTarget(w);

    w.residents.push({
      id: `r${i}`,
      name: NAMES[i % NAMES.length],
      job: pick(w, JOBS),
      likes,
      temper: pick(w, TEMPERS),
      color: COLORS[i % COLORS.length],
      x: start.x,
      y: start.y,
      tx: target.x,
      ty: target.y,
      linger: random(w) * 6,
      mood: 2,
      plan: "carry_on",
      planUntil: 0,
      last: null,
      glyph: "",
      glyphUntil: 0,
      rumour: null,
      heard: [],
      noticeRead: 0,
      gossipCooldown: 4 + random(w) * 6,
      busy: false,
    });
  }

  return w;
}

/** The in-game clock: 1:00 pm at the start, 5:00 pm at the end. */
export function clock(w: World) {
  const minutes = 13 * 60 + Math.min(1, w.t / w.length) * 240;
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);

  return `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} pm`;
}

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Residents within earshot of the newcomer, nearest first. */
export function inEarshot(w: World, max = 6) {
  return w.residents
    .map((r) => ({ r, d: distance(r, w.player) }))
    .filter((x) => x.d <= EARSHOT)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.r);
}

const clampMood = (m: number) => Math.max(0, Math.min(4, m));

const eventPlace = (w: World) => {
  const g = w.goal ? goal(w.goal) : null;

  return g?.place ? place(g.place) : null;
};

/** Where a resident is heading, given their plan. */
function steer(w: World, r: Resident) {
  const ev = eventPlace(w);
  const late = w.t >= w.length * 0.8;

  if (r.plan === "come" && ev && late) {
    r.tx = ev.x + (Number(r.id.slice(1)) % 7 - 3) * 14;
    r.ty = ev.y + 46 + (Number(r.id.slice(1)) % 3) * 12;
    r.linger = 0;

    return;
  }

  if (r.plan === "approach" && w.t < r.planUntil) {
    r.tx = w.player.x + 26;
    r.ty = w.player.y + 10;

    return;
  }

  // A gossip goes looking for someone to tell.
  if (r.plan === "gossip" && w.t < r.planUntil && r.rumour) {
    const rumour = r.rumour;
    const near = w.residents
      .filter((o) => o !== r && !o.heard.includes(rumour.id))
      .reduce<Resident | null>((best, o) => (!best || distance(o, r) < distance(best, r) ? o : best), null);

    if (near) {
      r.tx = near.x;
      r.ty = near.y;
      r.linger = 0;
    }

    return;
  }

  if (r.plan === "avoid" && w.t < r.planUntil && distance(r, w.player) < 160) {
    const d = Math.max(1, distance(r, w.player));

    r.tx = Math.max(20, Math.min(VIEW.width - 20, r.x + ((r.x - w.player.x) / d) * 120));
    r.ty = Math.max(60, Math.min(VIEW.height - 20, r.y + ((r.y - w.player.y) / d) * 120));
    r.linger = 0;
  }
}

function move(o: { x: number; y: number; tx: number; ty: number }, speed: number, dt: number) {
  const d = distance(o, { x: o.tx, y: o.ty });

  if (d < 1) return true;

  const step = Math.min(d, speed * dt);

  o.x += ((o.tx - o.x) / d) * step;
  o.y += ((o.ty - o.y) / d) * step;

  return d - step < 1;
}

export type Meeting = { teller: Resident; listener: Resident; rumour: Rumour };

export type Reader = { reader: Resident; notice: string };

/**
 * Advances the world by `dt` real seconds. Returns gossip meetings and notice readings that need
 * a model's judgment; the caller queues them and applies answers later.
 */
export function advance(w: World, dt: number): { meetings: Meeting[]; readers: Reader[] } {
  const meetings: Meeting[] = [];
  const readers: Reader[] = [];

  if (w.over || !w.goal) {
    for (const r of w.residents) idle(w, r, dt);

    return { meetings, readers };
  }

  w.t = Math.min(w.length, w.t + dt);
  move(w.player, PLAYER_SPEED, dt);

  for (const r of w.residents) {
    steer(w, r);
    idle(w, r, dt);
    r.gossipCooldown = Math.max(0, r.gossipCooldown - dt);

    if (r.glyph && w.t > r.glyphUntil) r.glyph = "";

    if (r.plan !== "carry_on" && r.plan !== "come" && w.t > r.planUntil) r.plan = "carry_on";

    if (w.notice && r.noticeRead < w.notice.revision && !r.busy && distance(r, BOARD) < 60) {
      r.noticeRead = w.notice.revision;
      readers.push({ reader: r, notice: w.notice.text });
    }
  }

  for (const teller of w.residents) {
    const rumour = teller.rumour;

    if (!rumour || teller.gossipCooldown > 0 || teller.busy) continue;

    const listener = w.residents.find(
      (o) => o !== teller && !o.busy && !o.heard.includes(rumour.id) && distance(o, teller) < 30,
    );

    if (!listener) continue;

    teller.gossipCooldown = 8;
    listener.heard.push(rumour.id);
    w.bubbles.push({ from: teller.id, to: listener.id, tone: rumour.tone, until: w.t + 1.6 });
    meetings.push({ teller, listener, rumour });
  }

  w.bubbles = w.bubbles.filter((b) => b.until > w.t);

  if (w.t >= w.length) w.over = true;

  return { meetings, readers };
}

function idle(w: World, r: Resident, dt: number) {
  if (r.linger > 0) {
    r.linger -= dt;

    return;
  }

  if (move(r, SPEED, dt)) {
    const committed = r.plan === "come" && w.t >= w.length * 0.8;

    if (committed) return;

    r.linger = 3 + random(w) * 9;

    const next = wanderTarget(w);

    r.tx = next.x;
    r.ty = next.y;
  }
}

export function walkTo(w: World, x: number, y: number) {
  w.player.tx = Math.max(16, Math.min(VIEW.width - 16, x));
  w.player.ty = Math.max(16, Math.min(VIEW.height - 16, y));
}

export function startGoal(w: World, id: Goal["id"]) {
  w.goal = id;
  w.t = 0;
  w.log.push({ at: 0, text: `Goal: ${goal(id).title.toLowerCase()}.` });
}

function count(w: World, model: string, ms: number) {
  w.stats.decisions++;
  w.stats.ms += ms;
  w.stats.byModel[model] = (w.stats.byModel[model] ?? 0) + 1;
}

/** The text a cold or warm rumour carries, from what the teller decided. */
export function rumourText(d: Decision, mood: number): { tone: "warm" | "cold"; says: string } {
  if (mood >= 3) return { tone: "warm", says: "the newcomer is lovely" };

  if (d.intent === "threat") return { tone: "cold", says: "the newcomer threatened people" };

  if (d.intent === "lie" || d.intent === "bribe" || d.believes < DOUBT) return { tone: "cold", says: "the newcomer is a fraud" };

  return { tone: mood <= 1 ? "cold" : "warm", says: mood <= 1 ? "the newcomer is rude" : "the newcomer seems nice" };
}

/** Applies a resident's judgment of something the newcomer said, gave or pinned. */
export function applyHear(w: World, r: Resident, d: Decision) {
  r.busy = false;
  r.last = d;
  count(w, d.model, d.ms);

  // How the line came across in general, and how this resident took it.
  const warmth = ((d.friendly ?? 0.5) + (d.warmer ?? 0.5)) / 2;
  const delta = warmth >= 0.6 ? 1 : warmth <= 0.35 ? -1 : 0;
  // A threat costs more than a shrug.
  const hurt = d.intent === "threat" ? -1 : 0;

  r.mood = clampMood(r.mood + delta + hurt);

  const action = d.action ?? "carry_on";

  // People only commit to an event run by someone they like; win them over first.
  r.plan = action === "come" && r.mood < 3 ? (r.mood < 2 ? "avoid" : "carry_on") : action;
  r.planUntil = w.t + (r.plan === "come" ? w.length : 25);
  r.glyph = r.plan === "avoid" || d.intent === "threat" ? "!" : d.believes < DOUBT ? "?" : r.mood >= 4 ? "♥" : "";
  r.glyphUntil = w.t + 5;

  // News travels: anyone whose opinion of you moved, or who decided to gossip, carries what they
  // think of you. Whether each person they meet believes it and passes it on is the model's call.
  if (r.plan === "gossip" || delta + hurt !== 0) {
    const { tone, says } = rumourText(d, r.mood);

    r.rumour = { id: ++w.rumours, tone, says, from: r.name, origin: r.name };
    r.heard.push(r.rumour.id);
    r.gossipCooldown = r.plan === "gossip" ? 0 : 3;
  }

  w.log.push({ at: w.t, text: `${r.name}: ${label(r.plan)}${d.intent ? ` (heard a ${d.intent})` : ""}.` });
}

/** Applies a listener's judgment of gossip: believe it, and maybe pass it on. */
export function applyGossip(w: World, m: Meeting, d: Decision) {
  const { listener, rumour } = m;

  listener.busy = false;
  listener.last = d;
  count(w, d.model, d.ms);

  if (d.believes < 0.5) {
    listener.glyph = "?";
    listener.glyphUntil = w.t + 3;

    return;
  }

  listener.mood = clampMood(listener.mood + (rumour.tone === "warm" ? 1 : -1));

  const s = (w.spread[rumour.origin] ??= { warm: 0, cold: 0 });

  s[rumour.tone]++;

  if (listener.plan === "come" && listener.mood < 2) listener.plan = "carry_on";

  listener.glyph = rumour.tone === "cold" ? "!" : "♥";
  listener.glyphUntil = w.t + 3;

  if ((d.passOn ?? 0) >= 0.5 && !listener.rumour) {
    listener.rumour = { ...rumour, from: listener.name };
    listener.gossipCooldown = 2;
  }
}

export function label(plan: Resident["plan"]) {
  return {
    approach: "comes over to you",
    avoid: "steers clear of you",
    gossip: "goes to tell someone",
    come: "says they'll come",
    carry_on: "carries on",
  }[plan];
}

export type Score = { got: number; target: number; of: number; verdict: string; detail: string };

/** The 5 pm score: who came (or who trusts you), and the loudest gossip. */
export function score(w: World): Score {
  const g = goal(w.goal ?? "gig");
  const ev = g.place ? place(g.place) : null;
  const got = ev
    ? w.residents.filter((r) => r.plan === "come" && r.mood >= 2).length
    : w.residents.filter((r) => r.mood >= 3).length;
  const of = w.residents.length;
  const what = ev ? (g.id === "gig" ? "came to your gig" : "queued for your cake") : "trust you";
  const loud = Object.entries(w.spread).sort((a, b) => b[1].cold + b[1].warm - (a[1].cold + a[1].warm))[0];
  const detail = loud
    ? loud[1].cold >= loud[1].warm
      ? `${loud[0]} told ${loud[1].cold} ${loud[1].cold === 1 ? "person" : "people"} you were trouble.`
      : `${loud[0]} told ${loud[1].warm} ${loud[1].warm === 1 ? "person" : "people"} you were lovely.`
    : "Nobody gossiped about you. Nobody much noticed you either.";

  return {
    got,
    target: g.target,
    of,
    verdict: `${got} of ${of} ${what}.${got >= g.target ? " You did it." : ` You needed ${g.target}.`}`,
    detail,
  };
}

export function markBusy(rs: Resident[]) {
  for (const r of rs) r.busy = true;
}
