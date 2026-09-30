/**
 * When should software act on a model's answer, and when should it ask a person? Given each
 * recorded decision's stated confidence and whether it was right, a threshold splits the cases:
 * at or above it the model acts; below it a person reviews. Everything here is exact counting
 * over recorded decisions; nothing is simulated.
 */

/** One recorded decision: how sure the model said it was, and whether its answer was right. */
export type Decision = { confidence: number; right: boolean };

export type Split = {
  threshold: number;
  /** Decisions the model handles on its own. */
  handled: number;
  /** Mistakes among those, which nobody reviews. */
  mistakes: number;
  /** Decisions sent to a person. */
  reviewed: number;
  total: number;
};

export function split(decisions: Decision[], threshold: number): Split {
  let handled = 0;
  let mistakes = 0;

  for (const d of decisions) {
    if (d.confidence < threshold) continue;
    handled++;

    if (!d.right) mistakes++;
  }

  return {
    threshold,
    handled,
    mistakes,
    reviewed: decisions.length - handled,
    total: decisions.length,
  };
}

/** The thresholds worth trying: every distinct confidence, plus 0 (act on everything) and just above 1 (review everything). */
export function thresholds(decisions: Decision[]) {
  return [...new Set([0, ...decisions.map((d) => d.confidence), 1.0001])].sort((a, b) => a - b);
}

/**
 * The threshold with the lowest total cost, where an unreviewed mistake costs `mistakeCost`
 * times as much as one human review. Ties go to the lower threshold (less human work).
 */
export function cheapest(decisions: Decision[], mistakeCost: number) {
  let best: { split: Split; cost: number } | null = null;

  for (const t of thresholds(decisions)) {
    const s = split(decisions, t);
    const cost = s.mistakes * mistakeCost + s.reviewed;

    if (!best || cost < best.cost) best = { split: s, cost };
  }

  return best;
}

/** The whole trade-off, for a chart: at each threshold, the share handled and the error rate among them. */
export function curve(decisions: Decision[]) {
  return thresholds(decisions).map((t) => {
    const s = split(decisions, t);

    return {
      threshold: t,
      coverage: s.total ? s.handled / s.total : 0,
      errorRate: s.handled ? s.mistakes / s.handled : 0,
    };
  });
}

/** A distribution's top option and its normalised probability. */
export function top(probabilities: number[] | Record<string, number>) {
  const entries = Array.isArray(probabilities)
    ? probabilities.map((p, i) => [String(i), p] as const)
    : Object.entries(probabilities);

  const sum = entries.reduce((s, [, p]) => s + p, 0);

  const [key, p] = entries.reduce((best, e) => (e[1] > best[1] ? e : best), entries[0] ?? ["", 0]);

  return { key, confidence: sum > 0 ? p / sum : 0 };
}
