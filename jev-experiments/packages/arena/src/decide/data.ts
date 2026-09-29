/** The published shape of public/decide/decide.json (built by build.ts), parsed on load. */
import { z } from "zod";
import { wireQuestionSchema } from "../checkable/items";
import { wireAnswerSchema } from "./combine";

const resultSchema = z.object({
  dist: z.record(z.string(), z.number()),
  answers: z.record(z.string(), wireAnswerSchema),
  latencyMs: z.number().nullable(),
});

const setupSchema = z.object({
  id: z.string(),
  group: z.enum(["wording", "shape", "context", "split"]),
  label: z.string(),
  withContext: z.boolean(),
  request: z.object({
    state: z.record(z.string(), z.string()),
    questions: z.record(z.string(), wireQuestionSchema),
  }),
  combine: z.unknown(),
  rule: z.string(),
  results: z.record(z.string(), resultSchema),
});

export const decideSchema = z.object({
  schema: z.literal("jev.decide/1"),
  contestants: z.array(
    z.object({ id: z.string(), name: z.string(), about: z.string(), model: z.string() }),
  ),
  decisions: z.array(
    z.object({
      id: z.string(),
      ask: z.string(),
      state: z.record(z.string(), z.string()),
      context: z.record(z.string(), z.string()).optional(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
      truth: z.object({ option: z.string(), why: z.string() }).optional(),
      setups: z.array(setupSchema),
    }),
  ),
});

export type DecideData = z.infer<typeof decideSchema>;

export type DecideDecision = DecideData["decisions"][number];

export type DecideSetup = z.infer<typeof setupSchema>;

export const tallySchema = z.object({
  available: z.boolean(),
  counts: z.record(z.string(), z.number()).optional(),
  counted: z.boolean().optional(),
  tallies: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});
