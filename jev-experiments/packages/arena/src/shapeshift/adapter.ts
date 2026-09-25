/**
 * Gateway answers to upstream's IntentResult, so upstream's calm-UI rules run unchanged.
 * Mirrors upstream's classifyWithJev (src/lib/jev/client.ts); the state is `{ text }`.
 */
import { z } from "zod";
import { QUESTION_COUNT } from "./upstream/jev/questions";
import { intentResultSchema, type IntentResult } from "./upstream/jev/types";

const wireAnswerSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: z.record(z.string(), z.number()).nullish(),
  confidence: z.number().nullish(),
});

export const answersSchema = z.record(z.string(), wireAnswerSchema);

export type WireAnswers = z.infer<typeof answersSchema>;

type WireAnswer = z.infer<typeof wireAnswerSchema>;

/** Score questions the gateway may drop when a Score disagrees with its own distribution. */
export const DROPPABLE = ["readiness", "urgency"] as const;

function chosen(a: WireAnswer | undefined) {
  if (!a) return undefined;
  const value = String(a.value);

  return {
    value,
    confidence: a.confidence ?? a.probabilities?.[value] ?? 0,
    probabilities: a.probabilities ?? { [value]: 1 },
  };
}

const number = (a: WireAnswer | undefined, fallback: number) =>
  a === undefined ? fallback : Number(a.value);

export type Adapted = { result: IntentResult; dropped: string[] };

/**
 * A dropped readiness counts as "just started" and a dropped urgency as "not urgent" with no
 * confidence; `dropped` names them so the log never hides the substitution.
 */
export function toIntentResult(
  answers: WireAnswers,
  meta: { latencyMs: number; model: string },
): Adapted {
  const a = (key: string) => (Object.hasOwn(answers, key) ? answers[key] : undefined);
  const urgency = a("urgency");

  const result = intentResultSchema.parse({
    intent: chosen(a("intent")),
    readiness: number(a("readiness"), 0),
    signals: {
      isQuestion: number(a("isQuestion"), 0),
      recurring: number(a("recurring"), 0),
      urgency: urgency
        ? { score: Number(urgency.value), confidence: urgency.confidence ?? 0 }
        : { score: 0, confidence: 0 },
      tone: chosen(a("tone")),
      eventMode: chosen(a("eventMode")),
      transport: chosen(a("transport")),
      tripType: chosen(a("tripType")),
      expenseCategory: chosen(a("expenseCategory")),
      colorMood: chosen(a("colorMood")),
      timerKind: chosen(a("timerKind")),
      hasExplicitOptions: number(a("hasExplicitOptions"), 0),
      isShoppingList: number(a("isShoppingList"), 0),
    },
    latencyMs: meta.latencyMs,
    questionCount: QUESTION_COUNT,
    model: meta.model,
    source: "jev",
  });

  return { result, dropped: DROPPABLE.filter((k) => a(k) === undefined) };
}
