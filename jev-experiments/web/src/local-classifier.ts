/** Evaluate the exported sklearn-compatible TF-IDF linear decision model locally. */
export function predict(model: any, text: string): Record<string, number> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  const terms = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  const counts = new Map<number, number>();
  for (const term of terms) {
    const index = model.vocabulary[term];
    if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const values = [...counts].map(([i, n]) => [
    i,
    (1 + Math.log(n)) * model.idf[i],
  ]);
  const norm = Math.sqrt(values.reduce((s, [, v]) => s + v * v, 0)) || 1;
  let logits = model.weights.map(
    (weights: number[], i: number) =>
      model.bias[i] +
      values.reduce((s, [j, v]) => s + (weights[j] * v) / norm, 0),
  );
  if (logits.length === 1 && model.classes.length === 2)
    logits = [0, logits[0]];
  const max = Math.max(...logits),
    exps = logits.map((v: number) => Math.exp(v - max)),
    sum = exps.reduce((a: number, b: number) => a + b, 0);
  return Object.fromEntries(
    model.classes.map((label: string, i: number) => [label, exps[i] / sum]),
  );
}
