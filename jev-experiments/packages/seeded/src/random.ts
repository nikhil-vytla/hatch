/**
 * Seeded generators. Every recorded world and published statistic draws from one of these, so
 * each function is kept bit-exact with the copies it replaced (see ../test/seeded.test.ts).
 */

/**
 * mulberry32 over a state the caller keeps, such as a world whose state is recorded. Advances
 * `holder.rng` in place (it stays a signed 32-bit integer) and returns the next draw in [0, 1).
 */
export function mulberry32Next(holder: { rng: number }): number {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0;

  let t = Math.imul(holder.rng ^ (holder.rng >>> 15), 1 | holder.rng);

  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** mulberry32: a seeded stream of draws in [0, 1). The seed is read as an unsigned 32-bit integer. */
export function mulberry32(seed: number): () => number {
  const state = { rng: seed >>> 0 };

  return () => mulberry32Next(state);
}

/** One step of the Numerical Recipes LCG: the next unsigned 32-bit state. */
export const lcg = (state: number) => (Math.imul(state, 1664525) + 1013904223) >>> 0;

/** The LCG over a state the caller keeps: advances `holder.rng` in place, returns it over 2³². */
export function lcgNext(holder: { rng: number }): number {
  holder.rng = lcg(holder.rng);

  return holder.rng / 4294967296;
}

/** A Fisher–Yates shuffle of a copy, drawing from `random` from the last index down. */
export function shuffled<T>(xs: readonly T[], random: () => number): T[] {
  const a = [...xs];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));

    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}
