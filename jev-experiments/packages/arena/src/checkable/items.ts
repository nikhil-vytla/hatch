/**
 * Checkable items: a state, native questions, and the right answer to each, computed by code
 * from the state. Nothing is a soft reference or an authored label, so a score against these
 * means right or wrong.
 */
import { z } from "zod";
import { mulberry32, shuffled } from "../../../seeded/src/index";

export const wireQuestionSchema = z.union([
  z.object({
    type: z.literal("choice"),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("noul"), instructions: z.string() }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string()) }),
]);

export type WireQuestion = z.infer<typeof wireQuestionSchema>;

/** A choice's option key, a yes/no, or a score's level index. */
export const truthSchema = z.union([z.string(), z.boolean(), z.number()]);

export type Truth = z.infer<typeof truthSchema>;

export const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(["tetris", "grid", "order", "route"]),
  seed: z.number(),
  /** 0 easy … 2 hard, from how close the competing answers are. */
  difficulty: z.number(),
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), wireQuestionSchema),
  truth: z.record(z.string(), truthSchema),
});

export type Item = z.infer<typeof itemSchema>;

export const bankSchema = z.object({
  schema: z.literal("checkable.bank/1"),
  generatedWith: z.string(),
  items: z.array(itemSchema),
});

export type Bank = z.infer<typeof bankSchema>;

const DAY_MS = 86_400_000;

/** Day 0 of Jev Daily. */
const EPOCH = Date.UTC(2026, 8, 26);

/**
 * Five items for a date (YYYY-MM-DD, UTC): three Tetris and two grid, walking a fixed
 * shuffle of each kind so no item repeats until the bank is used up.
 */
export function dailySet(bank: Bank, date: string) {
  const day = Math.floor((Date.parse(`${date}T00:00:00Z`) - EPOCH) / DAY_MS);

  if (!Number.isFinite(day)) throw new Error(`Not a date: ${date}`);

  const pick = (kind: Item["kind"], per: number, salt: number) => {
    const order = shuffled(
      bank.items.filter((i) => i.kind === kind).map((i) => i.id),
      mulberry32(salt),
    );

    if (!order.length) return [];
    const n = order.length;
    const start = (((day * per) % n) + n) % n;

    return Array.from({ length: per }, (_, i) => order[(start + i) % n]);
  };

  return [...pick("tetris", 3, 20260926), ...pick("grid", 2, 20260927)];
}
