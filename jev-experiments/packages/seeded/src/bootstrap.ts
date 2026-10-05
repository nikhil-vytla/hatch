/**
 * Seeded percentile bootstraps. Every resample draws its picks, in order, from one mulberry32
 * stream, so the same data and seed always give the same interval. The published intervals use
 * two different percentile rules; each function keeps its own rather than share one.
 */
import { mulberry32 } from "./random.js";

export type Interval = { lo: number; hi: number };

/** Sorted values at ranks ⌊0.025(R−1)⌋ and ⌈0.975(R−1)⌉: the arena cards' rule. */
const rankInterval = (sorted: number[], resamples: number): Interval => ({
  lo: sorted[Math.floor(0.025 * (resamples - 1))],
  hi: sorted[Math.ceil(0.975 * (resamples - 1))],
});

/** Each resample: `units.length` picks with replacement. Yields the picked units. */
function* eachResample<T>(units: readonly T[], count: number, seed: number): Generator<T[]> {
  const random = mulberry32(seed);

  for (let r = 0; r < count; r++) {
    const picks: T[] = [];

    for (let i = 0; i < units.length; i++) picks.push(units[Math.floor(random() * units.length)]);
    yield picks;
  }
}

const flat = <T>(groups: T[][]) => {
  const out: T[] = [];

  for (const g of groups) out.push(...g);

  return out;
};

/**
 * Resamples whole items (each may hold several decisions), recomputes the statistic over the
 * pooled decisions, and returns the 2.5th and 97.5th percentiles by the rank rule.
 */
export function bootstrapGroups<T>(
  items: T[][],
  statistic: (sample: T[]) => number,
  resamples = 1000,
  seed = 20260923,
): Interval {
  if (items.length < 2) return { lo: NaN, hi: NaN };

  const values: number[] = [];

  for (const picks of eachResample(items, resamples, seed)) values.push(statistic(flat(picks)));
  values.sort((a, b) => a - b);

  return rankInterval(values, resamples);
}

/** Several statistics from the same resamples, one pass; keyed by statistic name. */
export function bootstrapGroupsMany<T, K extends string>(
  items: T[][],
  statistic: (sample: T[]) => Record<K, number>,
  resamples = 1000,
  seed = 20260923,
): Map<string, Interval> {
  const values = new Map<string, number[]>();

  for (const picks of eachResample(items, resamples, seed)) {
    const stats = statistic(flat(picks));

    for (const k in stats) {
      const list = values.get(k) ?? [];

      list.push(stats[k]);
      values.set(k, list);
    }
  }

  const out = new Map<string, Interval>();

  for (const [k, v] of values) {
    v.sort((a, b) => a - b);
    out.set(k, rankInterval(v, resamples));
  }

  return out;
}

/** The sorted means of `draws` resamples of `xs`. */
export function resampledMeans(xs: readonly number[], draws: number, seed: number): number[] {
  const means: number[] = [];

  for (const picks of eachResample(xs, draws, seed)) {
    let s = 0;

    for (const x of picks) s += x;
    means.push(s / xs.length);
  }

  return means.sort((a, b) => a - b);
}

/**
 * Percentile bootstrap interval for the mean, resampling units with replacement: sorted means
 * at ⌊(α/2)·R⌋ and min(R−1, ⌊(1−α/2)·R⌋), α = 1 − level.
 */
export function bootstrapMean(
  xs: readonly number[],
  seed = 1,
  draws = 10_000,
  level = 0.95,
): [number, number] {
  if (!xs.length) return [NaN, NaN];

  const means = resampledMeans(xs, draws, seed);
  const lo = means[Math.floor(((1 - level) / 2) * draws)]!;
  const hi = means[Math.min(draws - 1, Math.floor((1 - (1 - level) / 2) * draws))]!;

  return [lo, hi];
}
