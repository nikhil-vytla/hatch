import { SUBSETS, type Case } from "./protocol";
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export const completed = (row: Case) =>
  row.status === "completed" &&
  row.candidates.every((c) => Number.isFinite(c.score));
export function topCredit(row: Case) {
  if (!completed(row)) return null;
  const top = Math.max(...row.candidates.map((c) => c.score!));
  const best = row.candidates.filter((c) => c.score === top);
  return best.filter((c) => c.chosen).length / best.length;
}
export function marginStats(row: Case) {
  if (!completed(row)) return null;
  const good = row.candidates.filter((c) => c.chosen).map((c) => c.score!);
  const bad = row.candidates.filter((c) => !c.chosen).map((c) => c.score!);
  const gap = Math.min(...good) - Math.max(...bad);
  return {
    accurate: gap > 0,
    spread: Math.max(...good) - Math.min(...good),
    gap,
  };
}
export function tiesMetrics(rows: Case[]) {
  const pairs = new Map<string, { ref?: Case; tied?: Case }>();
  for (const row of rows.filter((r) => r.subset === "Ties")) {
    const [kind, id] = row.id.split(":");
    if (!["ref", "tied"].includes(kind))
      throw Error(`Unexpected Ties id: ${row.id}`);
    const p = pairs.get(id) ?? {};
    p[kind as "ref" | "tied"] = row;
    pairs.set(id, p);
  }
  const ready = [...pairs.values()].filter(
    (p) => p.ref && p.tied && completed(p.ref) && completed(p.tied),
  );
  const per_pair = ready.map((p) => {
    const ref = marginStats(p.ref!)!,
      tied = marginStats(p.tied!)!;
    const minGap = Math.min(ref.gap, tied.gap);
    const ratio = minGap / tied.spread - 1;
    const margin = Number.isNaN(ratio) ? 0 : Math.tanh(ratio);
    return {
      id: p.tied!.id.split(":")[1],
      ref_accuracy: Number(ref.accurate),
      tied_accuracy: Number(tied.accurate),
      correctness_preferred: Number(tied.gap > tied.spread),
      correctness_preferred_hard: Number(minGap > tied.spread),
      margin,
      ref_gap: ref.gap,
      tied_gap: tied.gap,
      correct_spread: tied.spread,
    };
  });
  const average = (key: keyof (typeof per_pair)[number]) =>
    mean(per_pair.map((p) => Number(p[key])));
  const components = {
    ref_accuracy: average("ref_accuracy"),
    tied_accuracy: average("tied_accuracy"),
    correctness_preferred: average("correctness_preferred"),
    correctness_preferred_hard: average("correctness_preferred_hard"),
    margin_bonus: average("margin"),
  };
  const score = per_pair.length
    ? 0.3 * components.ref_accuracy! +
      0.3 * components.tied_accuracy! +
      0.2 * components.correctness_preferred! +
      0.2 * components.correctness_preferred_hard! +
      0.01 * components.margin_bonus!
    : null;
  return {
    score,
    complete_pairs: ready.length,
    total_pairs: pairs.size,
    components,
    per_pair,
    note: "Pinned upstream formula: 30% tied accuracy + 30% reference accuracy + 20% margin test + 20% paired margin test + 1% smooth bonus. It can exceed 100%.",
  };
}
export function summarize(rows: Case[]) {
  const ties = tiesMetrics(rows);
  const subsets = Object.fromEntries(
    SUBSETS.map((name) => {
      const all = rows.filter((r) => r.subset === name),
        done = all.filter(completed);
      return [
        name,
        {
          planned: all.length,
          completed: done.length,
          unavailable: all.length - done.length,
          score:
            name === "Ties" ? ties.score : mean(done.map((r) => topCredit(r)!)),
          chance: name === "Ties" ? null : 0.25,
        },
      ];
    }),
  );
  const allComplete = rows.every(completed) && rows.length > 0;
  return {
    planned: rows.length,
    completed: rows.filter(completed).length,
    macro_score:
      allComplete && SUBSETS.every((s) => subsets[s].score !== null)
        ? mean(SUBSETS.map((s) => subsets[s].score!))
        : null,
    subsets,
    ties,
    note: "Overall is the unweighted mean of the six subset scores, using the pinned upstream scoring formula. Candidates receive independent Jev rubric scores; this is an adapted Jev evaluation, not an official leaderboard submission.",
  };
}
