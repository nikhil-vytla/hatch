/** Pure measurement code for the prose studies: readers, distances, bootstrap, calibration. */
import { rng } from "../src/checkable/items";
import type { Reader } from "./variants";

export type Answer = { type: string; value: number | string; probabilities: Record<string, number> | null };
export type Answers = Record<string, Answer>;

/** P(claim) from a claim reader (see `Reader`). */
export function pClaim(read: Reader, answers: Answers): number {
  const a = answers.q!;

  if (read.kind === "noul") {
    const v = Number(a.value);

    return read.polarity === 1 ? v : 1 - v;
  }
  if (read.kind === "choice-yes") return a.probabilities![read.yes] ?? 0;
  if (read.kind === "score-yes")
    return read.weights.reduce((s, w, i) => s + w * (a.probabilities![String(i)] ?? 0), 0);

  throw Error(`Not a claim reader: ${read.kind}`);
}

/** A distribution over canonical keys (renormalised). */
export function dist(read: Reader, answers: Answers): Record<string, number> {
  if (read.kind !== "dist") throw Error(`Not a distribution reader: ${read.kind}`);

  const out: Record<string, number> = {};

  if (read.from === "each") {
    for (const [wire, key] of Object.entries(read.keyMap)) out[key] = Number(answers[wire]!.value);
  } else {
    const ps = answers.q!.probabilities!;

    for (const [wire, key] of Object.entries(read.keyMap)) out[key] = (out[key] ?? 0) + (ps[wire] ?? 0);
  }

  const total = Object.values(out).reduce((s, p) => s + p, 0);

  if (total > 0) for (const k of Object.keys(out)) out[k]! /= total;

  return out;
}

/** Total variation distance over the union of keys. */
export function tv(p: Record<string, number>, q: Record<string, number>) {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let s = 0;

  for (const k of keys) s += Math.abs((p[k] ?? 0) - (q[k] ?? 0));

  return s / 2;
}

/** The argmax key; ties give every tied key an equal share of credit via `credit`. */
export function credit(d: Record<string, number>, key: string) {
  const best = Math.max(...Object.values(d));
  const top = Object.keys(d).filter((k) => Math.abs(d[k]! - best) < 1e-9);

  return top.includes(key) ? 1 / top.length : 0;
}

export function argmax(d: Record<string, number>) {
  let best = "";
  let p = -1;

  for (const [k, v] of Object.entries(d)) if (v > p + 1e-9) [best, p] = [k, v];

  return best;
}

/** Correctness of a probability on the right answer of a yes/no: 1, 0.5 at exactly 0.5, else 0. */
export const binaryCredit = (pCorrect: number) => (Math.abs(pCorrect - 0.5) < 1e-9 ? 0.5 : pCorrect > 0.5 ? 1 : 0);

/** Which side of 0.5 a probability falls on: 1, 0 (exactly 0.5) or −1. */
export const side = (p: number) => (Math.abs(p - 0.5) < 1e-9 ? 0 : p > 0.5 ? 1 : -1);

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/**
 * Percentile bootstrap interval for the mean, resampling units (items) with replacement.
 * Seeded, so the same data always gives the same interval.
 */
export function bootstrap(xs: number[], seed = 1, draws = 10_000, level = 0.95): [number, number] {
  if (!xs.length) return [NaN, NaN];

  const random = rng(seed);
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

/** Expected calibration error with equal-width confidence bins, plus the bins. */
export function calibration(points: { confidence: number; correct: number }[], bins = 10) {
  const rows = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, correct: 0 }));

  for (const p of points) {
    const i = Math.min(bins - 1, Math.floor(p.confidence * bins));

    rows[i]!.n++;
    rows[i]!.confidence += p.confidence;
    rows[i]!.correct += p.correct;
  }

  let ece = 0;

  for (const r of rows)
    if (r.n) ece += (r.n / points.length) * Math.abs(r.correct / r.n - r.confidence / r.n);

  return {
    ece,
    bins: rows.map((r, i) => ({
      from: i / bins,
      to: (i + 1) / bins,
      n: r.n,
      confidence: r.n ? r.confidence / r.n : NaN,
      accuracy: r.n ? r.correct / r.n : NaN,
    })),
  };
}

/** Expected level of a score distribution whose keys are level indices or values. */
export const expected = (d: Record<string, number>) =>
  Object.entries(d).reduce((s, [k, p]) => s + Number(k) * p, 0);
