/**
 * Per-study analysis of a recording, using the prose studies' own metric code
 * (packages/arena/prose/metrics.ts) and bootstrap (packages/seeded) with the same seeds, so
 * `jev-decide` reproduces the published numbers on our recordings (see test/parity.test.ts).
 */
import { MENU, PUZZLES, sentencesFor, verdict } from "../../../packages/arena/src/fool/model";
import { dist, mean, pClaim, side, type Answers } from "../../../packages/arena/prose/metrics";
import { bootstrapMean } from "../../../packages/seeded/src/index";
import type { Row } from "./record";
import { proseJobs, type StudyId } from "./studies";

/** The last answered row per id. */
export function answered(rows: Row[]) {
  const out = new Map<string, Answers>();

  // SAFETY: an ok row's answers are the wire answers the metrics read (type, value, probabilities).
  for (const r of rows) if (r.status === "ok" && r.answers) out.set(r.id, r.answers as unknown as Answers);

  return out;
}

export type SuggestionRow = { variant: string; n: number; flips: number; pRight: number; delta: number; deltaCI: [number, number]; shift: number; shiftCI: [number, number] };

/** Prose study: how each suggestion sentence moves P(right) on the 20 true/false claims. */
export function suggestion(rows: Row[]): SuggestionRow[] {
  const cells = answered(rows);
  const jobs = proseJobs("suggestion");
  const items = [...new Set(jobs.map((j) => j.item))];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const pc = (item: string, family: string, variant: string) => {
    const id = `claim-truth:${item}:${family}:${variant}`;
    const a = cells.get(id);
    const j = byId.get(id);

    return a && j ? pClaim(j.read, a) : NaN;
  };
  const right = (item: string, p: number) => (jobs.find((j) => j.item === item)?.truth === true ? p : 1 - p);
  const variants = [...new Set(jobs.filter((j) => j.family === "suggestion").map((j) => j.variant))];

  return variants.map((variant) => {
    const pairs = items
      .map((it) => ({ it, p: pc(it, "suggestion", variant), c: pc(it, "baseline", "canonical") }))
      .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.c));
    const shifts = pairs.map((x) => Math.abs(x.p - x.c));
    const deltas = pairs.map((x) => right(x.it, x.p) - right(x.it, x.c));

    return {
      variant,
      n: pairs.length,
      flips: pairs.filter((x) => side(x.p) !== side(x.c)).length,
      pRight: mean(pairs.map((x) => right(x.it, x.p))),
      delta: mean(deltas),
      deltaCI: bootstrapMean(deltas, 7),
      shift: mean(shifts),
      shiftCI: bootstrapMean(shifts, 7),
    };
  });
}

export type DecoyRow = { item: string; none: number; decoyA: number; decoyB: number; effect: number };

/** Prose study: A's share of {A, B} next to A's decoy minus next to B's, averaged over both orders. */
export function decoy(rows: Row[]) {
  const cells = answered(rows);
  const jobs = proseJobs("decoy");
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const items = [...new Set(jobs.map((j) => j.item))];
  const share = (item: string, set: string, order: string) => {
    const id = `decoy:${item}:${set}:${order}`;
    const a = cells.get(id);
    const j = byId.get(id);

    if (!a || !j) return NaN;

    const p = dist(j.read, a);

    return p.a! / (p.a! + p.b!);
  };
  const m = (item: string, set: string) => mean(["forward", "reversed"].map((o) => share(item, set, o)));
  const scenarios: DecoyRow[] = items
    .map((item) => ({ item, none: m(item, "none"), decoyA: m(item, "decoy-a"), decoyB: m(item, "decoy-b"), effect: m(item, "decoy-a") - m(item, "decoy-b") }))
    .filter((r) => Number.isFinite(r.effect));
  const e = scenarios.map((r) => r.effect);

  return { scenarios, effect: { mean: mean(e), ci: bootstrapMean(e, 43) }, humanDirection: e.filter((x) => x > 0).length };
}

export type FoolRow = { sentence: string; flipped: number; ruledOut: number; puzzles: number; meanRight: number };

/** Fool Jev: per sentence, how many of the 5 puzzles it flipped (and how many the referee ruled out). */
export function fool(rows: Row[]): FoolRow[] {
  const cells = answered(rows);
  const yes = (id: string) => {
    const v = Number(cells.get(id)?.q?.value);

    return Number.isFinite(v) ? v : null;
  };
  const changes = (id: string) => {
    const v = Number(cells.get(id)?.changes?.value);

    return Number.isFinite(v) ? v : null;
  };
  // Every puzzle shares the menu; the last line is each puzzle's own cheat.
  const labels = [...MENU, "(the puzzle's own cheat)"];

  return labels.map((label, i) => {
    const verdicts = PUZZLES.flatMap((p) => {
      const sentence = sentencesFor(p.id)[i + 1];
      const base = yes(`answer:${p.id}:`);
      const now = yes(`answer:${p.id}:${sentence}`);

      return base === null || now === null ? [] : [verdict(p, now, base, changes(`referee:${p.id}:${sentence}`))];
    });

    return {
      sentence: label,
      puzzles: verdicts.length,
      flipped: verdicts.filter((v) => v.kind === "flipped").length,
      ruledOut: verdicts.filter((v) => v.kind === "ruled-out").length,
      meanRight: mean(verdicts.map((v) => v.right)),
    };
  });
}

/** The study's top answer per question, for agreement between two recordings. */
export function tops(rows: Row[]) {
  const out = new Map<string, string>();

  for (const [id, answers] of answered(rows))
    for (const [q, a] of Object.entries(answers)) {
      const top = a.type === "noul" ? String(side(Number(a.value))) : a.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] : String(a.value);

      if (top !== undefined) out.set(`${id}#${q}`, top);
    }

  return out;
}

/** A headline flip rate for a study: flipped decisions over decisions measured. */
export function flipRate(study: StudyId, rows: Row[]) {
  if (study === "fool") {
    const r = fool(rows);
    const n = r.reduce((s, x) => s + x.puzzles, 0);

    return { flipped: r.reduce((s, x) => s + x.flipped, 0), n };
  }

  if (study === "suggestion") {
    const r = suggestion(rows);

    return { flipped: r.reduce((s, x) => s + x.flips, 0), n: r.reduce((s, x) => s + x.n, 0) };
  }

  return null;
}
