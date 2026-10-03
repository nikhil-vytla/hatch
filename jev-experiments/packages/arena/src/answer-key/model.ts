/**
 * Who wrote the answer key? The same recorded answers, graded against different references:
 * the benchmark's teacher, a consensus of the other models (their probabilities averaged, the
 * way TypeSafe's workflow evals average two frontier models), or one model's own answers.
 * The ranking can change with the key while no model's answers change.
 */

/** One question: the benchmark's reference distribution and each model's distribution. */
export type Question = { target: number[]; predictions: Record<string, number[]> };

const normalise = (p: number[]) => {
  const s = p.reduce((a, b) => a + b, 0);

  return s > 0 ? p.map((x) => x / s) : p.map(() => 1 / p.length);
};

/** Index of the largest value; ties keep the first option. */
export const topIndex = (p: number[]) => p.reduce((best, x, i) => (x > p[best] ? i : best), 0);

export type Key =
  | { kind: "teacher" }
  | { kind: "consensus"; voters: string[] }
  | { kind: "model"; model: string };

/** The key's answer to each question when grading `model` (a consensus never includes the model graded). */
export function keyAnswers(questions: Question[], key: Key, model: string): number[] {
  return questions.map((q) => {
    if (key.kind === "teacher") return topIndex(q.target);

    if (key.kind === "model") return topIndex(q.predictions[key.model] ?? q.target);

    const pool = key.voters.filter((v) => v !== model && q.predictions[v]);
    const dists = pool.map((v) => normalise(q.predictions[v]));

    const mean = q.target.map(
      (_, i) => dists.reduce((s, d) => s + (d[i] ?? 0), 0) / (dists.length || 1),
    );

    return topIndex(mean);
  });
}

/** Share of questions where the model's top answer is the key's. */
export function agreement(questions: Question[], key: Key, model: string) {
  const answers = keyAnswers(questions, key, model);

  let same = 0;

  questions.forEach((q, i) => {
    if (q.predictions[model] && topIndex(q.predictions[model]) === answers[i]) same++;
  });

  return questions.length ? same / questions.length : 0;
}

export type Interval = { estimate: number; low: number; high: number; clusters: number };

/**
 * Agreement with a 95% interval that treats each case as a cluster: the questions in one case share
 * their facts, so they aren't independent. Cluster-robust variance of the ratio estimator.
 */
export function clusteredAgreement(cases: Question[][], key: Key, model: string): Interval {
  const counts = cases.map((qs) => {
    const answers = keyAnswers(qs, key, model);

    const k = qs.filter((q, i) => q.predictions[model] && topIndex(q.predictions[model]) === answers[i]).length;

    return { k, n: qs.length };
  });

  const n = counts.reduce((s, c) => s + c.n, 0);

  const estimate = n ? counts.reduce((s, c) => s + c.k, 0) / n : 0;

  const c = counts.length;

  const spread = counts.reduce((s, x) => s + (x.k - estimate * x.n) ** 2, 0);

  const half = c > 1 && n ? 1.96 * Math.sqrt((c / (c - 1)) * spread) / n : 0;

  return { estimate, low: Math.max(0, estimate - half), high: Math.min(1, estimate + half), clusters: c };
}

export type Ranked = { model: string; agreement: number; rank: number };

/** Models ranked by agreement with the key; a model is never graded against its own answers. */
export function rank(questions: Question[], key: Key, models: string[]): Ranked[] {
  return models
    .flatMap((m) => (key.kind === "model" && key.model === m ? [] : [{ model: m, agreement: agreement(questions, key, m) }]))
    .sort((a, b) => b.agreement - a.agreement)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** One model per family, so the consensus doesn't count Laya three times. */
export const KEY_MODELS: { id: string; name: string }[] = [
  { id: "jev", name: "Jev" },
  { id: "Qwen3-4B-Instruct-2507-4bit", name: "Qwen3-4B" },
  { id: "laya-tuned", name: "Laya (fine-tuned)" },
  { id: "Qwen3-0.6B-4bit", name: "Qwen3-0.6B" },
  { id: "SmolLM2-360M-Instruct", name: "SmolLM2-360M" },
];
