/**
 * Jev Daily's published data: every checkable item Jev answered, with one question per item
 * (fixed per item, so every day that shows it asks the same), the answer code computed, and
 * Jev's recorded distribution. Built from the bank and the recording at build time; the page
 * picks the day's five with dailySet(). Jev's answers were recorded before any day's play.
 */
import { z } from "zod";
import { bankSchema, rng, shuffled, truthSchema, wireQuestionSchema, type Bank } from "./items";

/** Puzzle kinds the Daily can show. */
export const dailyKindSchema = z.enum(["tetris", "grid", "phrase", "order", "route"]);

export type DailyKind = z.infer<typeof dailyKindSchema>;

export const dailyItemSchema = z.object({
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

export const dailySchema = z.object({
  schema: z.literal("jev.daily/1"),
  recordedAt: z.string(),
  /** How Jev did on every question of every item where it said 90% or more. */
  sure: z.object({ n: z.number(), right: z.number() }),
  bank: bankSchema.pick({ schema: true, generatedWith: true }).extend({
    ids: z.array(z.object({ id: z.string(), kind: dailyKindSchema })),
  }),
  items: z.array(dailyItemSchema),
});

export type DailyItem = z.infer<typeof dailyItemSchema>;

export type Daily = z.infer<typeof dailySchema>;

/** The option keys of a question, in order: a yes/no is ["true", "false"]; a score, its levels. */
export function optionKeys(q: z.infer<typeof wireQuestionSchema>) {
  if (q.type === "choice") return Object.keys(q.criteria);

  if (q.type === "noul") return ["true", "false"];

  return q.criteria.map((_, i) => String(i));
}

/** The right option key for a question's truth. */
export const truthKey = (truth: z.infer<typeof truthSchema>) => String(truth);

/** One question per item, chosen by the item's seed so it never depends on the day. */
export function questionFor(item: Bank["items"][number]) {
  const ids = Object.keys(item.questions);

  return ids[Math.floor(rng(item.seed * 7 + 3)() * ids.length)];
}

/** Log score with probabilities clamped to 1–99%, so one confident miss can't swamp a day. */
export const CLAMP = 0.01;

export const score = (p: number) => Math.log(Math.min(1 - CLAMP, Math.max(CLAMP, p)));

/**
 * The day's mix. Jev is built for judgement from text, so the Daily is too: phrases, orders
 * and routing, plus one Tetris question about a local pattern. Puzzles that need counting or
 * route-finding (Tetris heights, maze distances) stay in the arena, where Jev does poorly and
 * says so.
 */
export const MIX: [DailyKind, number][] = [
  ["phrase", 2],
  ["order", 1],
  ["route", 1],
  ["tetris", 1],
];

const DAY_MS = 86_400_000;

const EPOCH = Date.UTC(2026, 8, 26);

/** The ids for a date (YYYY-MM-DD, UTC), walking a fixed shuffle of each kind so none repeats until used up. */
export function pickDaily(ids: { id: string; kind: DailyKind }[], date: string) {
  const day = Math.floor((Date.parse(`${date}T00:00:00Z`) - EPOCH) / DAY_MS);

  if (!Number.isFinite(day)) throw new Error(`Not a date: ${date}`);

  return MIX.flatMap(([kind, per], k) => {
    const order = shuffled(
      ids.flatMap((i) => (i.kind === kind ? [i.id] : [])),
      rng(20260926 + k),
    );

    if (!order.length) return [];
    const n = order.length;
    const start = (((day * per) % n) + n) % n;

    return Array.from({ length: Math.min(per, n) }, (_, i) => order[(start + i) % n]);
  });
}
