/**
 * Jev Daily's published data. Every puzzle is one question with an answer fixed by how the
 * puzzle was made, and Jev's recorded distribution. The game is "trust or override": Jev
 * answers first, and the visitor keeps its answer or overrules it. So most of a day's puzzles
 * are ones where Jev hesitates, and each carries how often Jev is right at that confidence on
 * puzzles of its kind, measured over the whole pool.
 */
import { z } from "zod";
import { rng, shuffled, truthSchema, wireQuestionSchema } from "./items";

/** Puzzle kinds the Daily can show. */
export const dailyKindSchema = z.enum(["tetris", "grid", "phrase", "order", "route"]);

export type DailyKind = z.infer<typeof dailyKindSchema>;

export const dailyItemSchema = z.object({
  /** Unique per question: an item with several questions is several puzzles. */
  id: z.string(),
  kind: dailyKindSchema,
  difficulty: z.number(),
  state: z.record(z.string(), z.unknown()),
  questionId: z.string(),
  question: wireQuestionSchema,
  truth: truthSchema,
  /** Jev's recorded distribution over the question's options (a yes/no has "true" and "false"). */
  jev: z.record(z.string(), z.number()),
  jevMs: z.number(),
});

/** How often Jev's top answer is right at each confidence band, per puzzle kind. */
export const bandSchema = z.object({
  lo: z.number(),
  hi: z.number(),
  n: z.number(),
  right: z.number(),
});

export const dailySchema = z.object({
  schema: z.literal("jev.daily/2"),
  recordedAt: z.string(),
  calibration: z.record(z.string(), z.array(bandSchema)),
  items: z.array(dailyItemSchema),
});

export type DailyItem = z.infer<typeof dailyItemSchema>;

export type Daily = z.infer<typeof dailySchema>;

export type Band = z.infer<typeof bandSchema>;

/** Confidence bands used for the calibration shown beside each puzzle. */
export const BANDS: [number, number][] = [
  [0, 0.5],
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0001],
];

/** The option keys of a question, in order: a yes/no is ["true", "false"]; a score, its levels. */
export function optionKeys(q: z.infer<typeof wireQuestionSchema>) {
  if (q.type === "choice") return Object.keys(q.criteria);

  if (q.type === "noul") return ["true", "false"];

  return q.criteria.map((_, i) => String(i));
}

/** The right option key for a question's truth. */
export const truthKey = (truth: z.infer<typeof truthSchema>) => String(truth);

/** Jev's top answer and how sure it was. */
export function jevPick(item: Pick<DailyItem, "jev">) {
  const [key, p] = Object.entries(item.jev).reduce((a, b) => (b[1] > a[1] ? b : a));

  return { key, p };
}

/** Below this, Jev is hesitating; a day is mostly these. */
export const SURE_AT = 0.9;

/** One hesitant puzzle of each kind a day, then one where Jev is sure. */
export const HESITANT_MIX: DailyKind[] = ["order", "route", "phrase", "tetris"];

const DAY_MS = 86_400_000;

const EPOCH = Date.UTC(2026, 8, 26);

/**
 * The day's puzzles (YYYY-MM-DD, UTC). Each pool is walked in a fixed shuffle so nothing repeats
 * until the pool is used up; a kind with no hesitant puzzles falls back to its sure ones.
 */
export function pickDaily(items: Pick<DailyItem, "id" | "kind" | "jev">[], date: string) {
  const day = Math.floor((Date.parse(`${date}T00:00:00Z`) - EPOCH) / DAY_MS);

  if (!Number.isFinite(day)) throw new Error(`Not a date: ${date}`);

  const walk = (ids: string[], salt: number) => {
    if (!ids.length) return undefined;
    const order = shuffled(ids, rng(salt));

    return order[((day % order.length) + order.length) % order.length];
  };

  const hesitant = (kind: DailyKind) =>
    items.flatMap((i) => (i.kind === kind && jevPick(i).p < SURE_AT ? [i.id] : []));

  const sure = (kind?: DailyKind) =>
    items.flatMap((i) => ((!kind || i.kind === kind) && jevPick(i).p >= SURE_AT ? [i.id] : []));

  const picks = HESITANT_MIX.flatMap((kind, k) => {
    const id = walk(hesitant(kind), 20260926 + k) ?? walk(sure(kind), 20261026 + k);

    return id ? [id] : [];
  });

  const confident = walk(
    sure().filter((id) => !picks.includes(id)),
    20261126,
  );

  return confident ? [...picks.slice(0, 2), confident, ...picks.slice(2)] : picks;
}
