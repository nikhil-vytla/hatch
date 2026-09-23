/**
 * Scores probabilistic answers against a reference distribution.
 * Definitions match local-models-and-games/apple/metrics.py so arena numbers
 * reproduce the recorded study exactly.
 */
export type ScoredAnswer = { prediction: number[]; reference: number[]; ordinal?: boolean };

export type Scorecard = {
  decisions: number;
  /** Top option agrees with the reference's top option. */
  agreement: number;
  /** Reference probability of the predicted top option. */
  softAgreement: number;
  brier: number;
  kl: number;
  /** Expected calibration error over ten equal-width confidence bins. */
  ece: number;
  /** Top option disagrees with the reference while its probability is at least the threshold. */
  confidentButWrong: number;
  meanConfidence: number;
  reliability: { lo: number; hi: number; count: number; confidence: number; agreement: number }[];
};

const normalize = (xs: number[]) => {
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / sum);
};
export const argmax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

export function score(answers: ScoredAnswer[], confidentThreshold = 0.7): Scorecard {
  let correct = 0, soft = 0, brier = 0, kl = 0, confidentButWrong = 0, confidenceSum = 0;
  const rows: { confidence: number; correct: number }[] = [];
  for (const a of answers) {
    const p = normalize(a.prediction), t = normalize(a.reference);
    if (p.length !== t.length) throw new Error("Prediction and reference must cover the same options");
    const i = argmax(p), hit = i === argmax(t) ? 1 : 0;
    correct += hit;
    soft += t[i];
    brier += p.reduce((s, x, k) => s + (x - t[k]) ** 2, 0) / p.length;
    kl += t.reduce((s, x, k) => s + x * Math.log(Math.max(x, 1e-12) / Math.max(p[k], 1e-12)), 0);
    confidenceSum += p[i];
    if (!hit && p[i] >= confidentThreshold) confidentButWrong++;
    rows.push({ confidence: p[i], correct: hit });
  }
  const n = answers.length;
  const reliability: Scorecard["reliability"] = [];
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    // numpy.linspace edges (i * 0.1), not i / 10: rounded provider probabilities sit exactly on edges.
    const lo = b * 0.1, hi = (b + 1) * 0.1;
    const inBin = rows.filter((r) => r.confidence > lo && r.confidence <= hi);
    if (!inBin.length) continue;
    const confidence = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
    const agreement = inBin.reduce((s, r) => s + r.correct, 0) / inBin.length;
    ece += (inBin.length / n) * Math.abs(confidence - agreement);
    reliability.push({ lo, hi, count: inBin.length, confidence, agreement });
  }
  return {
    decisions: n,
    agreement: n ? correct / n : 0,
    softAgreement: n ? soft / n : 0,
    brier: n ? brier / n : 0,
    kl: n ? kl / n : 0,
    ece,
    confidentButWrong,
    meanConfidence: n ? confidenceSum / n : 0,
    reliability,
  };
}
