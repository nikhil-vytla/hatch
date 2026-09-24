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
): { lo: number; hi: number } {
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

/** Several statistics from the same resamples, one pass. */
export function bootstrapMany<T, K extends string>(
  items: T[][],
  statistic: (sample: T[]) => Record<K, number>,
  resamples = 1000,
  seed = 20260923,
): Record<K, { lo: number; hi: number }> {
  const random = rng(seed),
    values = new Map<K, number[]>();

  for (let r = 0; r < resamples; r++) {
    const sample: T[] = [];

    for (let i = 0; i < items.length; i++)
      sample.push(...items[Math.floor(random() * items.length)]);

    for (const [k, v] of Object.entries(statistic(sample)) as [K, number][])
      (values.get(k) ?? values.set(k, []).get(k)!).push(v);
  }

  const out = {} as Record<K, { lo: number; hi: number }>;

  for (const [k, v] of values) {
    v.sort((a, b) => a - b);
    out[k] = {
      lo: v[Math.floor(0.025 * (resamples - 1))],
      hi: v[Math.ceil(0.975 * (resamples - 1))],
    };
  }

  return out;
}
