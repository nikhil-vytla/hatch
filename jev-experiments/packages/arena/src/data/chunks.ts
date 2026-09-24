/** Schemas for the lazily loaded arena chunks; the site parses each one before use. */
import { z } from "zod";

const probabilities = z.record(z.string(), z.number());

export const targetsSchema = z.object({
  schema: z.literal("arena.targets/1"),
  rows: z.array(
    z.object({
      c: z.number(),
      key: z.string(),
      type: z.string(),
      wf: z.string(),
      keys: z.array(z.string()),
      target: z.array(z.number()),
    }),
  ),
});

export const predsSchema = z.object({
  schema: z.literal("arena.preds/1"),
  contestant: z.string(),
  p: z.array(z.array(z.number())),
});

/** Case state is whatever the recorded experiment sent; it is displayed as JSON, never interpreted. */
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const casesSchema = z.object({
  schema: z.literal("arena.cases/1"),
  cases: z.array(
    z.object({
      id: z.string(),
      workflow: z.string(),
      state: jsonValue,
      questions: z.array(
        z.object({
          key: z.string(),
          type: z.string(),
          instructions: z.string(),
          keys: z.array(z.string()),
          options: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});

const wireAnswer = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: probabilities.nullish(),
  confidence: z.number().nullish(),
});

export const turnsReplaySchema = z.object({
  schema: z.literal("arena.replay.turns/1"),
  framing: z.enum([
    "landing-choice",
    "spot-clean",
    "spot-score",
    "spot-clean-cached",
    "spot-clean-confident",
  ]),
  seed: z.number(),
  exchanges: z.array(
    z.object({
      framing: z.enum([
        "landing-choice",
        "spot-clean",
        "spot-score",
        "spot-clean-cached",
        "spot-clean-confident",
      ]),
      pieceId: z.number(),
      board: z.array(z.string()),
      ms: z.number(),
      error: z.string().optional(),
      response: z.object({ answers: z.record(z.string(), wireAnswer) }).optional(),
    }),
  ),
});

export const timedReplaySchema = z.object({
  schema: z.literal("arena.replay.timed/1"),
  retryPolicy: z.enum(["fixed", "backoff"]),
  seed: z.number(),
  events: z.array(
    z.object({
      sentAt: z.number(),
      pieceId: z.number(),
      board: z.array(z.string()),
      status: z.string(),
      receivedAt: z.number().optional(),
      choice: z.string().optional(),
      probabilities: probabilities.optional(),
      error: z.string().optional(),
      latencyMs: z.number().optional(),
    }),
  ),
});

export const replaySchema = z.discriminatedUnion("schema", [turnsReplaySchema, timedReplaySchema]);

export type Targets = z.infer<typeof targetsSchema>;

export type Preds = z.infer<typeof predsSchema>;

export type Cases = z.infer<typeof casesSchema>;

export type Replay = z.infer<typeof replaySchema>;
