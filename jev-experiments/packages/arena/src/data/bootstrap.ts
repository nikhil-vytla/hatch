export type Interval = { lo: number; hi: number };

/** Seeded percentile bootstrap over items (cases), so intervals are reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resamples whole items (each may hold several decisions) and recomputes the
 * statistic; returns the 2.5th and 97.5th percentiles.
 */
export function bootstrap<T>(
  items: T[][],
  statistic: (sample: T[]) => number,
  resamples = 1000,
  seed = 20260923,
): Interval {
  if (items.length < 2) return { lo: NaN, hi: NaN };

  const random = rng(seed),
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

/** Several statistics from the same resamples, one pass; keyed by statistic name. */
export function bootstrapMany<T, K extends string>(
  items: T[][],
  statistic: (sample: T[]) => Record<K, number>,
  resamples = 1000,
  seed = 20260923,
): Map<string, Interval> {
  const random = rng(seed),
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

  const out = new Map<string, Interval>();

  for (const [k, v] of values) {
    v.sort((a, b) => a - b);
    out.set(k, {
      lo: v[Math.floor(0.025 * (resamples - 1))],
      hi: v[Math.ceil(0.975 * (resamples - 1))],
    });
  }

  return out;
}
