/** The authored phrases (phrases.json): expected card and signals, written before any model ran. */
import { z } from "zod";
import { INTENTS } from "./questions";

const intent = z.enum(INTENTS).exclude(["none"]);

export const phrasesSchema = z.object({
  schema: z.literal("one-box.phrases/1"),
  authoredAt: z.string(),
  authoredBy: z.string(),
  phrases: z.array(
    z.object({
      id: z.string(),
      text: z.string().min(1),
      intent,
      acceptable: z.array(intent).optional(),
      signals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      kind: z.enum(["plain", "ambiguous", "adversarial"]),
      split: z.enum(["dev", "heldout"]),
      note: z.string().optional(),
    }),
  ),
});

export type Phrase = z.infer<typeof phrasesSchema>["phrases"][number];
