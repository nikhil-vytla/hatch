/**
 * Jev Daily's published data: every checkable item Jev answered, with one question per item
 * (fixed per item, so every day that shows it asks the same), the answer code computed, and
 * Jev's recorded distribution. Built from the bank and the recording at build time; the page
 * picks the day's five with dailySet(). Jev's answers were recorded before any day's play.
 */
import { z } from "zod";
import { bankSchema, rng, truthSchema, wireQuestionSchema, type Bank } from "./items";

export const dailyItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["tetris", "grid"]),
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
    ids: z.array(z.object({ id: z.string(), kind: z.enum(["tetris", "grid"]) })),
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
