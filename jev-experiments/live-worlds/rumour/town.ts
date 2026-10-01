/**
 * Bramble, a fictional town for the rumour mill: a few thousand residents in blocks on either
 * side of a river, each one of twelve archetypes, linked to their nearest neighbours, a few
 * people on the next street, and the town's hubs (the baker, the barber, the postie…).
 * Everything is deterministic from the seed.
 */

export const VIEW = { width: 1000, height: 640 };

export type PlaceId = "bakery" | "hall" | "market" | "bridge" | "stage" | "library" | "school" | "pub";

export const PLACES: { id: PlaceId; name: string; description: string; x: number; y: number }[] = [
  { id: "bakery", name: "the bakery", description: "The bakery on the high street: cakes, bread and pastries.", x: 170, y: 150 },
  { id: "hall", name: "the town hall", description: "The town hall, where the mayor and the council meet.", x: 470, y: 120 },
  { id: "market", name: "the market", description: "The market square: stalls, shops and trade.", x: 300, y: 470 },
  { id: "bridge", name: "the bridge", description: "The old bridge over the river, the only road across town.", x: 640, y: 330 },
  { id: "stage", name: "the bandstand", description: "The bandstand in the park, for gigs and music.", x: 830, y: 140 },
  { id: "library", name: "the library", description: "The library: books, quiet rooms and the noticeboard.", x: 760, y: 500 },
  { id: "school", name: "the school", description: "The primary school, with children and parents at the gate.", x: 120, y: 520 },
  { id: "pub", name: "the pub", description: "The Crown pub, where people meet in the evening.", x: 910, y: 330 },
];

export type ArchetypeId =
  | "sweet"
  | "gossip"
  | "sceptic"
  | "commuter"
  | "pensioner"
  | "student"
  | "parent"
  | "suspicious"
  | "trader"
  | "musician"
  | "teacher"
  | "newcomer";

export type Archetype = { id: ArchetypeId; label: string; description: string; trust: number; chatty: number; sceptic: number; share: number };

/** `share` is the town's mix: the fraction of residents of each archetype. */
export const ARCHETYPES: Archetype[] = [
  { id: "sweet", label: "Sweet tooth", description: "Loves cake, pastries and anything from the bakery.", trust: 0.6, chatty: 0.5, sceptic: 0.2, share: 0.1 },
  { id: "gossip", label: "Gossip", description: "Loves news of any kind and passes everything on.", trust: 0.7, chatty: 0.95, sceptic: 0.1, share: 0.09 },
  { id: "sceptic", label: "Sceptic", description: "Doubts everything they hear and checks the facts.", trust: 0.2, chatty: 0.4, sceptic: 0.95, share: 0.08 },
  { id: "commuter", label: "Commuter", description: "Crosses the bridge to work every day and cares about roads and buses.", trust: 0.5, chatty: 0.35, sceptic: 0.4, share: 0.1 },
  { id: "pensioner", label: "Pensioner", description: "Retired, reads every notice and trusts the council.", trust: 0.8, chatty: 0.6, sceptic: 0.15, share: 0.1 },
  { id: "student", label: "Student", description: "Loves free stuff, jokes and memes, and is always online.", trust: 0.5, chatty: 0.8, sceptic: 0.3, share: 0.09 },
  { id: "parent", label: "Parent", description: "A busy parent who cares about the school and safety.", trust: 0.55, chatty: 0.55, sceptic: 0.4, share: 0.1 },
  { id: "suspicious", label: "Suspicious", description: "Suspects the mayor and the council are hiding something.", trust: 0.3, chatty: 0.75, sceptic: 0.2, share: 0.06 },
  { id: "trader", label: "Trader", description: "Runs a stall at the market and cares about trade and money.", trust: 0.45, chatty: 0.6, sceptic: 0.5, share: 0.08 },
  { id: "musician", label: "Musician", description: "Plays at the bandstand and never misses a gig.", trust: 0.6, chatty: 0.65, sceptic: 0.3, share: 0.06 },
  { id: "teacher", label: "Teacher", description: "Careful, cares about children and getting the facts right.", trust: 0.45, chatty: 0.5, sceptic: 0.75, share: 0.07 },
  { id: "newcomer", label: "Newcomer", description: "New in town and keen to meet people.", trust: 0.65, chatty: 0.5, sceptic: 0.25, share: 0.07 },
];

/** The town's best-connected people; each knows dozens of residents across town. */
export const HUBS: { name: string; role: string; place: PlaceId; archetype: ArchetypeId }[] = [
  { name: "Rosa", role: "the baker", place: "bakery", archetype: "sweet" },
  { name: "Sal", role: "the barber", place: "market", archetype: "gossip" },
  { name: "Pat", role: "the postie", place: "library", archetype: "gossip" },
  { name: "Mo", role: "a market trader", place: "market", archetype: "trader" },
  { name: "Dee", role: "the librarian", place: "library", archetype: "teacher" },
  { name: "Ken", role: "the bus driver", place: "bridge", archetype: "commuter" },
  { name: "Ivy", role: "the landlady at the Crown", place: "pub", archetype: "gossip" },
  { name: "Gus", role: "the school caretaker", place: "school", archetype: "parent" },
];

const FIRST = ["Ada", "Ben", "Cleo", "Dev", "Esme", "Finn", "Gwen", "Hal", "Iris", "Jude", "Kai", "Lena", "Max", "Nell", "Omar", "Pip", "Quin", "Ruth", "Sam", "Tess", "Umar", "Vera", "Wes", "Xan", "Yara", "Zed"];
const LAST = ["Abbot", "Birch", "Cole", "Drake", "Ellis", "Fenn", "Grey", "Hart", "Ives", "Jory", "Kemp", "Lowe", "Marsh", "Noon", "Orme", "Penn", "Reed", "Shaw", "Thorn", "Vale", "Wren", "Yeo"];

export type Resident = {
  id: number;
  name: string;
  archetype: ArchetypeId;
  trust: number;
  chatty: number;
  block: number;
  x: number;
  y: number;
  /** Set for the eight hubs. */
  hub?: string;
};

export type Block = { id: number; x: number; y: number; w: number; h: number; street: string };

export type Town = { seed: number; residents: Resident[]; blocks: Block[]; links: number[][] };

/** Mulberry32: small, fast and deterministic. */
export function rng(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;

    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREETS = ["Mill Lane", "Cherry Row", "Station Road", "Kiln Street", "Orchard Way", "Hope Street", "Ferry Lane", "Quarry Road", "Bell Street", "Wharf Row"];

/** The river runs down x ≈ 600–640; blocks sit either side. */
function layoutBlocks(): Block[] {
  const blocks: Block[] = [];
  const cols = [30, 150, 270, 390, 490, 680, 790, 890];
  const rows = [40, 160, 280, 400, 520];

  for (const [r, y] of rows.entries())
    for (const [c, x] of cols.entries())
      blocks.push({ id: blocks.length, x, y, w: c === 4 ? 90 : 95, h: 95, street: `${STREETS[(r * 3 + c) % STREETS.length]}` });

  return blocks;
}

export function createTown(seed = 7, count = 4000): Town {
  const rand = rng(seed);
  const blocks = layoutBlocks();
  const cumulative = ARCHETYPES.reduce<number[]>((acc, a) => [...acc, (acc.at(-1) ?? 0) + a.share], []);
  const pickArchetype = () => {
    const u = rand() * (cumulative.at(-1) ?? 1);

    return ARCHETYPES[cumulative.findIndex((c) => u <= c)] ?? ARCHETYPES[0];
  };

  const residents: Resident[] = [];

  for (let i = 0; i < count; i++) {
    const block = blocks[i % blocks.length];
    const a = pickArchetype();
    const jitter = (v: number) => Math.min(1, Math.max(0, v + (rand() - 0.5) * 0.4));

    residents.push({
      id: i,
      name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`,
      archetype: a.id,
      trust: jitter(a.trust),
      chatty: jitter(a.chatty),
      block: block.id,
      x: block.x + 4 + rand() * (block.w - 8),
      y: block.y + 4 + rand() * (block.h - 8),
    });
  }

  // The hubs live next to their places.
  for (const [h, hub] of HUBS.entries()) {
    const place = PLACES.find((p) => p.id === hub.place) ?? PLACES[0];
    const r = residents[h * 37];

    Object.assign(r, { name: hub.name, archetype: hub.archetype, hub: hub.role, trust: 0.6, chatty: 0.95, x: place.x + 18 + (h % 2) * 10, y: place.y + 16 + (h % 2) * 8 });
  }

  const links: number[][] = residents.map(() => []);
  const link = (a: number, b: number) => {
    if (a === b || links[a].includes(b)) return;

    links[a].push(b);
    links[b].push(a);
  };

  // Nearest neighbours within each block.
  const byBlock = blocks.map((b) => residents.filter((r) => r.block === b.id));

  for (const members of byBlock)
    for (const r of members) {
      const near = members
        .filter((o) => o !== r)
        .map((o) => [o.id, (o.x - r.x) ** 2 + (o.y - r.y) ** 2] as const)
        .sort((p, q) => p[1] - q[1])
        .slice(0, 5);

      for (const [o] of near) link(r.id, o);
    }

  // A few people on the next street.
  for (const r of residents)
    if (rand() < 0.35) {
      const block = blocks[r.block];
      const nearby = blocks.filter((b) => b !== block && Math.abs(b.x - block.x) <= 130 && Math.abs(b.y - block.y) <= 130);
      const target = nearby[Math.floor(rand() * nearby.length)];
      const members = target ? byBlock[target.id] : [];

      if (members.length) link(r.id, members[Math.floor(rand() * members.length)].id);
    }

  // Hubs know people all over town.
  for (const r of residents.filter((x) => x.hub))
    for (let k = 0; k < 60; k++) link(r.id, Math.floor(rand() * residents.length));

  return { seed, residents, blocks, links };
}
