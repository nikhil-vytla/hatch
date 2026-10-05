/**
 * The seeded module against frozen copies of the local implementations it replaced, copied
 * from main at 94e203e (reformatted, otherwise unchanged). Recordings and published numbers
 * depend on these to the bit, so every comparison is exact, over at least 1,000 draws per seed.
 */
import { describe, expect, test } from "bun:test";
import {
  bootstrapGroups,
  bootstrapGroupsMany,
  bootstrapMean,
  fnv1a,
  fnv1aCodePoints,
  fnv1aUnit,
  lcg,
  lcgNext,
  mulberry32,
  mulberry32Next,
  resampledMeans,
  shuffled,
} from "../src/index";

// ---------- Frozen copies ----------

/** packages/arena/src/checkable/items.ts `rng` (also used by prose/* and checkable/*). */
function itemsRng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** packages/arena/src/checkable/items.ts `shuffled`. */
function itemsShuffled<T>(xs: T[], random: () => number) {
  const a = [...xs];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

/** packages/arena/src/data/bootstrap.ts `rng`. */
function dataRng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The `t ^= t + …` spelling, textually identical in packages/arena/spine/analyze.ts,
 * live-worlds/ocean/train.ts, rumour/town.ts, sentry/dataset.ts, who-said-that/decide.ts and
 * free-model/gen.ts.
 */
function xorSpellingRng(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;

    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** live-worlds/ocean/train.ts `rng`: the stream plus Box–Muller normals from it. */
function oceanTrainRng(seed: number) {
  const next = xorSpellingRng(seed);
  const normal = () => {
    const u = Math.max(1e-12, next());

    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };

  return { next, normal };
}

/** live-worlds/ocean/engine.ts `random`: raw seed, state kept on the world. */
function oceanRandom(w: { rng: number }) {
  w.rng = (w.rng + 0x6d2b79f5) | 0;

  let t = Math.imul(w.rng ^ (w.rng >>> 15), 1 | w.rng);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** experience-prototypes/src/arena/confidence.tsx `sample`: raw seed, shuffle, first n. */
function confidenceSample<T>(xs: T[], n: number, seed: number) {
  let s = seed;

  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const a = [...xs];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a.slice(0, n);
}

/** packages/arena/src/tetris-engine.ts `lcg` and `random`. */
const tetrisLcg = (state: number) => (Math.imul(state, 1664525) + 1013904223) >>> 0;
function tetrisRandom(g: { rng: number }) {
  g.rng = tetrisLcg(g.rng);

  return g.rng / 4294967296;
}

/** live-worlds/crowd/engine.ts `random`. */
function crowdRandom(state: { rng: number }) {
  state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

/** live-worlds/win-over/engine.ts `random`: a float multiply, exact while |rng · 1664525 + 1013904223| < 2⁵³. */
function winOverRandom(w: { rng: number }) {
  w.rng = (w.rng * 1664525 + 1013904223) >>> 0;

  return w.rng / 2 ** 32;
}

/** live-worlds/sentry/model.ts `hash` (DIM 2048). */
function sentryModelHash(s: string) {
  let h = 0x811c9dc5;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0) % 2048;
}

/** live-worlds/sentry/data/fetch.ts, sweep.ts and real.ts `hashed`, by offset basis. */
const sentryHashed = (basis: number) => (s: string) => {
  let h = basis;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0) / 4294967296;
};

/** packages/jev-client/src/mock.ts `hash`. */
const mockHash = (s: string) => {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;

  return h / 4294967296;
};

/** packages/arena/prose/text.ts `seedOf`. */
function proseSeedOf(s: string) {
  let h = 0x811c9dc5;

  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h;
}

/** packages/arena/src/data/bootstrap.ts `bootstrap` and `bootstrapMany`. */
function dataBootstrap<T>(
  items: T[][],
  statistic: (sample: T[]) => number,
  resamples = 1000,
  seed = 20260923,
) {
  if (items.length < 2) return { lo: NaN, hi: NaN };

  const random = dataRng(seed),
    values: number[] = [];

  for (let r = 0; r < resamples; r++) {
    const sample: T[] = [];

    for (let i = 0; i < items.length; i++)
      sample.push(...items[Math.floor(random() * items.length)]);
    values.push(statistic(sample));
  }

  values.sort((a, b) => a - b);

  return {
    lo: values[Math.floor(0.025 * (resamples - 1))],
    hi: values[Math.ceil(0.975 * (resamples - 1))],
  };
}

function dataBootstrapMany<T, K extends string>(
  items: T[][],
  statistic: (sample: T[]) => Record<K, number>,
  resamples = 1000,
  seed = 20260923,
) {
  const random = dataRng(seed),
    values = new Map<string, number[]>();

  for (let r = 0; r < resamples; r++) {
    const sample: T[] = [];

    for (let i = 0; i < items.length; i++)
      sample.push(...items[Math.floor(random() * items.length)]);

    const stats = statistic(sample);

    for (const k in stats) {
      const list = values.get(k) ?? [];
      list.push(stats[k]);
      values.set(k, list);
    }
  }

  const out = new Map<string, { lo: number; hi: number }>();

  for (const [k, v] of values) {
    v.sort((a, b) => a - b);
    out.set(k, {
      lo: v[Math.floor(0.025 * (resamples - 1))],
      hi: v[Math.ceil(0.975 * (resamples - 1))],
    });
  }

  return out;
}

/** packages/arena/prose/metrics.ts `bootstrap`. */
function proseBootstrap(xs: number[], seed = 1, draws = 10_000, level = 0.95): [number, number] {
  if (!xs.length) return [NaN, NaN];

  const random = itemsRng(seed);
  const means: number[] = [];

  for (let b = 0; b < draws; b++) {
    let s = 0;

    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(random() * xs.length)]!;
    means.push(s / xs.length);
  }

  means.sort((a, b) => a - b);

  const lo = means[Math.floor(((1 - level) / 2) * draws)]!;
  const hi = means[Math.min(draws - 1, Math.floor((1 - (1 - level) / 2) * draws))]!;

  return [lo, hi];
}

/** packages/arena/spine/analyze.ts `boot`. */
function spineBoot(values: (number | null)[], seed = 7, resamples = 2000) {
  const xs = values.filter((v): v is number => v !== null);

  if (!xs.length) return null;

  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const r = xorSpellingRng(seed);
  const ms: number[] = [];

  for (let b = 0; b < resamples; b++) ms.push(mean(xs.map(() => xs[Math.floor(r() * xs.length)])));

  ms.sort((a, b) => a - b);

  return {
    mean: mean(xs),
    ci: [ms[Math.floor(resamples * 0.025)], ms[Math.ceil(resamples * 0.975) - 1]],
    n: xs.length,
  };
}

// ---------- Inputs ----------

const DRAWS = 1000;

/** 1,000 spread seeds plus the edges of every 32-bit reading. */
const SEEDS = (() => {
  const g = { rng: 12345 };
  const spread = Array.from(
    { length: 1000 },
    () => tetrisLcg((g.rng = tetrisLcg(g.rng))) - 2 ** 31 * (g.rng & 1),
  );

  return [
    0,
    1,
    -1,
    7,
    19,
    27,
    42,
    2 ** 31 - 1,
    -(2 ** 31),
    2 ** 31,
    2 ** 32 - 1,
    2 ** 32,
    20260923,
    0x9e3779b9,
    ...spread,
  ];
})();

/** Seeds the raw-seed copies may receive: fractions, negatives and values past 32 bits. */
const ODD_SEEDS = [
  0.5,
  -0.5,
  1.5,
  -1.5,
  123.75,
  -98765.25,
  2 ** 40 + 3,
  -(2 ** 40) - 7,
  1.7e12,
  2 ** 53 - 1,
];

const draws = (next: () => number, n = DRAWS) => Array.from({ length: n }, () => next());

const sameBits = (a: unknown, b: unknown) => expect(a).toEqual(b as never);

function strings() {
  const r = itemsRng(99);
  const pool = [
    "a",
    "Z",
    " ",
    "é",
    "ß",
    "中",
    "🙂",
    "𝔘",
    "\ud800",
    "\udfff",
    "w:",
    "b:",
    "cue:",
    "where:hidden",
    "$",
    "£",
  ];
  const out = ["", "a", "item-1", "über", "🙂x", "where:not-visible", "x".repeat(300)];

  for (let i = 0; i < 3000; i++)
    out.push(
      Array.from({ length: Math.floor(r() * 40) }, () => pool[Math.floor(r() * pool.length)]).join(
        "",
      ),
    );

  return out;
}

// ---------- mulberry32 ----------

describe("mulberry32 matches every local copy", () => {
  const callers: [string, (seed: number) => () => number][] = [
    ["checkable/items rng (prose, checkable, record scripts)", itemsRng],
    ["data/bootstrap rng", dataRng],
    ["spine/analyze rng", xorSpellingRng],
    ["ocean/train rng().next", (s) => oceanTrainRng(s).next],
    ["rumour/town rng", xorSpellingRng],
    ["sentry/dataset rng", xorSpellingRng],
    ["who-said-that/decide rng", xorSpellingRng],
    ["free-model/gen rng", xorSpellingRng],
  ];

  for (const [name, old] of callers)
    test(name, () => {
      for (const seed of [...SEEDS, ...ODD_SEEDS]) {
        const a = draws(old(seed)),
          b = draws(mulberry32(seed));

        if (!a.every((x, i) => Object.is(x, b[i]))) sameBits({ seed, b }, { seed, b: a });
      }
    });

  test("ocean/train normals from the shared stream", () => {
    for (const seed of SEEDS) {
      const old = oceanTrainRng(seed);
      const next = mulberry32(seed);
      const normal = () => {
        const u = Math.max(1e-12, next());

        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      };
      const a = draws(() => old.next() + old.normal() * 3);
      const b = draws(() => next() + normal() * 3);

      if (!a.every((x, i) => Object.is(x, b[i]))) sameBits(b, a);
    }
  });

  test("ocean/engine random: same draws and the same recorded state", () => {
    for (const seed of [...SEEDS, ...ODD_SEEDS]) {
      const wa = { rng: seed },
        wb = { rng: seed };

      for (let i = 0; i < DRAWS; i++) {
        const a = oceanRandom(wa),
          b = mulberry32Next(wb);

        if (!Object.is(a, b) || !Object.is(wa.rng, wb.rng))
          sameBits({ seed, i, b, s: wb.rng }, { seed, i, b: a, s: wa.rng });
      }
    }
  });

  test("confidence.tsx sample: raw seed through the caller-kept state", () => {
    const xs = Array.from({ length: DRAWS + 1 }, (_, i) => i);

    for (const seed of [...SEEDS, ...ODD_SEEDS]) {
      const state = { rng: seed };

      sameBits(
        shuffled(xs, () => mulberry32Next(state)).slice(0, 20),
        confidenceSample(xs, 20, seed),
      );
    }
  });

  test("shuffled matches checkable/items shuffled", () => {
    const xs = Array.from({ length: DRAWS + 1 }, (_, i) => `x${i}`);

    for (const seed of SEEDS)
      sameBits(shuffled(xs, mulberry32(seed)), itemsShuffled(xs, itemsRng(seed)));
  });
});

// ---------- LCG ----------

describe("lcg matches every local copy", () => {
  test("tetris-engine lcg and random", () => {
    for (const seed of [...SEEDS, ...ODD_SEEDS]) {
      expect(lcg(seed)).toBe(tetrisLcg(seed));

      const ga = { rng: seed },
        gb = { rng: seed };

      for (let i = 0; i < DRAWS; i++)
        if (!Object.is(tetrisRandom(ga), lcgNext(gb)) || ga.rng !== gb.rng) sameBits(gb, ga);
    }
  });

  test("crowd random (state starts at seed >>> 0)", () => {
    for (const seed of [...SEEDS, ...ODD_SEEDS]) {
      const sa = { rng: seed >>> 0 },
        sb = { rng: seed >>> 0 };

      for (let i = 0; i < DRAWS; i++)
        if (!Object.is(crowdRandom(sa), lcgNext(sb)) || sa.rng !== sb.rng) sameBits(sb, sa);
    }
  });

  // The float multiply equals Math.imul whenever rng · 1664525 + 1013904223 is an exact integer:
  // integer states with |that| < 2⁵³, so |rng| up to about 5.41e9. After one step the state is a
  // uint32 (well inside), so only the seed matters, and every caller passes an integer below 1e9
  // (Math.floor(Math.random() * 1e9) on the page; 3, 5 and 11 in the recorders and tests).
  const WIN_OVER_SAFE = Math.floor((2 ** 53 - 1013904223) / 1664525);

  test("win-over random over every integer seed it can be given", () => {
    const seeds = [
      ...SEEDS,
      WIN_OVER_SAFE,
      -WIN_OVER_SAFE,
      999_999_999,
      4_294_967_296 + 5,
      -4_294_967_296 - 5,
    ];

    for (const seed of seeds) {
      const wa = { rng: seed },
        wb = { rng: seed };

      for (let i = 0; i < DRAWS; i++)
        if (!Object.is(winOverRandom(wa), lcgNext(wb)) || wa.rng !== wb.rng) sameBits(wb, wa);
    }
  });

  test("win-over's float multiply first rounds just past that bound", () => {
    expect(winOverRandom({ rng: WIN_OVER_SAFE + 1 })).not.toBe(lcgNext({ rng: WIN_OVER_SAFE + 1 }));
  });
});

// ---------- FNV-1a ----------

describe("fnv1a matches every local copy", () => {
  const xs = strings();

  test("sentry/model hash", () => {
    for (const s of xs) expect(fnv1a(s) % 2048).toBe(sentryModelHash(s));
  });

  test("sentry/data/fetch, sweep and real hashed", () => {
    for (const basis of [0x811c9dc5, 0x2545f491, 0x9e3779b9]) {
      const old = sentryHashed(basis);

      for (const s of xs) expect(Object.is(fnv1aUnit(s, basis), old(s))).toBe(true);
    }
  });

  test("jev-client mock hash", () => {
    for (const s of xs) expect(Object.is(fnv1aUnit(s), mockHash(s))).toBe(true);
  });

  test("prose/text seedOf (code points)", () => {
    for (const s of xs) expect(fnv1aCodePoints(s)).toBe(proseSeedOf(s));
  });

  test("code points and code units differ beyond the BMP, so they stay two functions", () => {
    expect(fnv1aCodePoints("abc")).toBe(fnv1a("abc"));
    expect(fnv1aCodePoints("🙂")).not.toBe(fnv1a("🙂"));
  });
});

// ---------- Bootstraps ----------

describe("bootstraps match every local copy", () => {
  const data = (seed: number, n: number) =>
    draws(itemsRng(seed), n).map((x, i) => (i % 3 === 0 ? Math.round(x) : x * 7 - 2));

  test("prose/metrics bootstrap", () => {
    for (let seed = 0; seed < 150; seed++) {
      const xs = data(seed, 1 + (seed % 60));

      for (const [n, level] of [
        [1000, 0.95],
        [2000, 0.9],
        [1001, 0.5],
      ] as const)
        sameBits(bootstrapMean(xs, seed, n, level), proseBootstrap(xs, seed, n, level));
    }

    sameBits(bootstrapMean(data(3, 40)), proseBootstrap(data(3, 40)));
    sameBits(bootstrapMean([]), proseBootstrap([]));
  });

  test("spine/analyze boot, from resampledMeans and its own rule", () => {
    for (let seed = 0; seed < 150; seed++) {
      const values: (number | null)[] = data(seed, 1 + (seed % 50)).map((x, i) =>
        i % 7 === 3 ? null : x,
      );
      const xs = values.filter((v): v is number => v !== null);

      for (const resamples of [2000, 1000, 1337]) {
        const old = spineBoot(values, seed, resamples)!;
        const ms = resampledMeans(xs, resamples, seed);

        sameBits([ms[Math.floor(resamples * 0.025)], ms[Math.ceil(resamples * 0.975) - 1]], old.ci);
      }
    }
  });

  test("data/bootstrap bootstrap and bootstrapMany", () => {
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

    for (let seed = 0; seed < 150; seed++) {
      const flat = data(seed, 2 + (seed % 40));
      const items = flat.map((x, i) =>
        Array.from({ length: (i % 4) + 1 }, (_, j) => (j % 2 ? x : -x / 3)),
      );

      for (const resamples of [1000, 1500]) {
        sameBits(
          bootstrapGroups(items, mean, resamples, seed),
          dataBootstrap(items, mean, resamples, seed),
        );
        sameBits(
          [...bootstrapGroupsMany(items, (a) => ({ m: mean(a), n: a.length }), resamples, seed)],
          [...dataBootstrapMany(items, (a) => ({ m: mean(a), n: a.length }), resamples, seed)],
        );
      }
    }

    sameBits(bootstrapGroups([[1]], mean), dataBootstrap([[1]], mean));
    sameBits(
      [...bootstrapGroupsMany([], () => ({ m: 1 }), 1000)],
      [...dataBootstrapMany([], () => ({ m: 1 }), 1000)],
    );
  });
});
