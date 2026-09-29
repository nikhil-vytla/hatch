/**
 * Calibration for the Typed Decisions study, from the published per-question distributions:
 * each question carries the teacher's gold distribution (the mean of three teacher samples)
 * and every model's predicted distribution. "Right" means the model's top option is the
 * teacher's top option; that is agreement with a teacher, not independent correctness.
 *
 * Alongside the study's own definitions this reports the variants that change the numbers:
 * Brier summed per question (what the dataset card appears to report) as well as averaged per
 * option, and KL under several floors, because a model that rounds to exact zeros is
 * penalised almost entirely by the floor chosen.
 */
export type Question = { target: number[]; predictions: Record<string, number[]> };

export type Bin = { lo: number; hi: number; n: number; confidence: number; agreement: number };

export const KL_FLOORS = [1e-12, 1e-6, 1e-3] as const;

const normalise = (p: number[]) => {
  const s = p.reduce((a, b) => a + b, 0);

  return s > 0 ? p.map((x) => x / s) : p.map(() => 1 / p.length);
};

const argmax = (p: number[]) => p.reduce((best, x, i) => (x > p[best] ? i : best), 0);

export function calibration(questions: Question[], model: string, bins = 10) {
  const rows = questions.filter((q) => q.predictions[model]);

  // Edges as numpy.linspace makes them (i × step), so boundary values bin identically.
  const step = 1 / bins;

  const buckets = Array.from({ length: bins }, (_, i) => ({
    lo: i * step,
    hi: i === bins - 1 ? 1 : (i + 1) * step,
    n: 0,
    conf: 0,
    right: 0,
  }));

  let right = 0;
  let confidence = 0;
  let brierOption = 0;
  let brierQuestion = 0;
  let zeros = 0;
  let options = 0;
  const kl = KL_FLOORS.map(() => 0);

  for (const q of rows) {
    const t = normalise(q.target);
    const raw = q.predictions[model];
    const p = normalise(raw);
    const pick = argmax(p);
    const hit = pick === argmax(t);
    const c = p[pick];
    // (lo, hi] bins compared against the edges themselves, as the study's metrics.py does, so a
    // rounded confidence like 0.8 lands in the same bin and the ECE matches it.
    const b = buckets.find((x) => c > x.lo && c <= x.hi) ?? buckets[0];

    b.n++;
    b.conf += c;
    b.right += Number(hit);
    right += Number(hit);
    confidence += c;

    const squared = p.reduce((s, x, i) => s + (x - t[i]) ** 2, 0);

    brierQuestion += squared;
    brierOption += squared / p.length;
    zeros += raw.filter((x) => x === 0).length;
    options += raw.length;
    KL_FLOORS.forEach((floor, f) => {
      kl[f] += t.reduce(
        (s, ti, i) => (ti > 0 ? s + ti * Math.log(ti / Math.max(p[i], floor)) : s),
        0,
      );
    });
  }

  const n = rows.length || 1;

  const reliability: Bin[] = buckets
    .filter((b) => b.n)
    .map((b) => ({
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      confidence: b.conf / b.n,
      agreement: b.right / b.n,
    }));

  return {
    questions: rows.length,
    agreement: right / n,
    confidence: confidence / n,
    overconfidence: (confidence - right) / n,
    ece: reliability.reduce((s, b) => s + (b.n / n) * Math.abs(b.confidence - b.agreement), 0),
    brierPerOption: brierOption / n,
    brierPerQuestion: brierQuestion / n,
    kl: KL_FLOORS.map((floor, f) => ({ floor, value: kl[f] / n })),
    exactZeros: zeros / (options || 1),
    reliability,
  };
}
