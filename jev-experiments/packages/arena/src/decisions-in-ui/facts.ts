/**
 * The numbers behind "Decisions in an interface", read from the records the article's figures
 * also use: the One box arena card (held-out phrases, both request policies) and the recorded
 * intent answers behind When to ask a person. Nothing here is typed in by hand.
 */
import type { Card, Estimate } from "../data/schema";
import { split, top, type Decision } from "../handoff/model";

/** The contestants the article compares, each under upstream's cancel-on-keystroke policy. */
export const ONE_BOX_LINEUP = ["jev@cancel", "sglang-l4.qwen3-4b@cancel", "laya@cancel", "qwen3.5-0.8b@cancel", "qwen3-0.6b@cancel", "code.keyword"];

export const HANDOFF_THRESHOLD = 0.9;

export type BoxRow = {
  id: string;
  name: string;
  short: string;
  right: Estimate;
  wrong: Estimate;
  changes: Estimate;
  /** Median answer time in ms; code rules make no model call and have none. */
  latency: number | null;
};

const value = (e?: Estimate) => e?.value ?? Number.NaN;

/** One row per lineup contestant on the held-out phrases, best right-at-the-end first. */
export function heldOutRows(card: Pick<Card, "contestants" | "slices">): BoxRow[] {
  const held = card.slices?.workflow?.["held-out"];

  if (!held) return [];

  return ONE_BOX_LINEUP.flatMap((id) => {
    const r = held[id];
    const c = card.contestants.find((x) => x.id === id);

    if (!r || !c || !r.right || !r.wrong || !r.changes) return [];

    return [{ id, name: c.name, short: c.short ?? c.name, right: r.right, wrong: r.wrong, changes: r.changes, latency: r.latency?.value ?? null }];
  }).sort((a, b) => value(b.right) - value(a.right) || value(a.wrong) - value(b.wrong));
}

/** How many held-out phrases each estimate covers (the card's n for "right"). */
export const heldOutN = (card: Pick<Card, "slices">) => card.slices?.workflow?.["held-out"]?.["jev@cancel"]?.right?.n ?? 0;

export type PolicyRow = { policy: "cancel" | "latest"; right: number; wrong: number; changes: number; timeToRight: number };

/** Jev under both request policies, over every phrase: what a calm UI costs and buys. */
export function jevPolicies(card: Pick<Card, "results">): PolicyRow[] {
  return (["cancel", "latest"] as const).flatMap((policy) => {
    const r = card.results[`jev@${policy}`];

    if (!r?.right || !r.wrong || !r.changes || !r.timeToRight) return [];

    return [{ policy, right: r.right.value, wrong: r.wrong.value, changes: r.changes.value, timeToRight: r.timeToRight.value }];
  });
}

/** Every phrase the card scores (development plus held-out). */
export const allN = (card: Pick<Card, "results">) => card.results["jev@cancel"]?.right?.n ?? 0;

export type IntentRow = { error?: unknown; probabilities?: Record<string, number> | null; prediction?: string; target?: string };

export function intentDecisions(rows: IntentRow[]): Decision[] {
  return rows.flatMap((r) => (!r.error && r.probabilities ? [{ confidence: top(r.probabilities).confidence, right: r.prediction === r.target }] : []));
}

/**
 * Expected calibration error over ten equal-width bins, (lo, hi] like the studies' metrics.py:
 * the size-weighted gap between stated confidence and how often the answer was right.
 */
export function ece(decisions: Decision[], bins = 10) {
  const step = 1 / bins;
  const sums = Array.from({ length: bins }, () => ({ n: 0, conf: 0, right: 0 }));

  for (const d of decisions) {
    const i = Math.min(bins - 1, Math.max(0, Math.ceil(d.confidence / step) - 1));

    sums[i].n++;
    sums[i].conf += d.confidence;
    sums[i].right += Number(d.right);
  }

  const n = decisions.length;

  return n ? sums.reduce((s, b) => s + (b.n ? (b.n / n) * Math.abs(b.conf / b.n - b.right / b.n) : 0), 0) : 0;
}

export type IntentFacts = {
  total: number;
  handled: number;
  right: number;
  mistakes: number;
  ece: number;
  accuracy: number;
  /** Mean stated confidence; above accuracy means overconfident. */
  confidence: number;
};

/** At the article's threshold: how much Jev handles alone, how often it's right then, and calibration. */
export function intentFacts(rows: IntentRow[], threshold = HANDOFF_THRESHOLD): IntentFacts | null {
  const d = intentDecisions(rows);
  const s = split(d, threshold);

  if (!s.total || !s.handled) return null;

  return {
    total: s.total,
    handled: s.handled / s.total,
    right: 1 - s.mistakes / s.handled,
    mistakes: s.mistakes,
    ece: ece(d),
    accuracy: d.filter((x) => x.right).length / d.length,
    confidence: d.reduce((sum, x) => sum + x.confidence, 0) / d.length,
  };
}
