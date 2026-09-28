/**
 * Gateway answers to a Reading, the shape the calm rules and the scoring read.
 * The state Jev sees is `{ text }`, as upstream sends it.
 */
import { z } from "zod";
import { QUESTIONS, type QuestionId, type Reading } from "./questions";

const wireAnswerSchema = z.object({
  value: z.union([z.string(), z.number()]),
  probabilities: z.record(z.string(), z.number()).nullish(),
  confidence: z.number().nullish(),
});

export const answersSchema = z.record(z.string(), wireAnswerSchema);

export type WireAnswers = z.infer<typeof answersSchema>;

type WireAnswer = z.infer<typeof wireAnswerSchema>;

export type Adapted = { reading: Reading; dropped: QuestionId[] };

/** Every choice answer must name one of its question's options. */
function choiceOf(id: QuestionId, a: WireAnswer | undefined) {
  const q = QUESTIONS[id];

  if (!a || q.type !== "choice") throw new Error(`No answer for ${id}.`);
  const value = String(a.value);

  if (!Object.hasOwn(q.criteria, value)) throw new Error(`${id}: "${value}" is not an option.`);

  return {
    value,
    confidence: a.confidence ?? a.probabilities?.[value] ?? 0,
    probabilities: a.probabilities ?? { [value]: 1 },
  };
}

/**
 * The gateway drops a Score that disagrees with its own distribution. A dropped readiness or
 * urgency reads as 0 with no confidence, and `dropped` names it so the log never hides it.
 */
export function toReading(answers: WireAnswers): Adapted {
  const get = (id: QuestionId) => (Object.hasOwn(answers, id) ? answers[id] : undefined);
  const dropped: QuestionId[] = [];

  const scored = (id: "readiness" | "urgency") => {
    const a = get(id);

    if (!a) {
      dropped.push(id);

      return { score: 0, confidence: 0 };
    }

    return { score: Number(a.value), confidence: a.confidence ?? 0 };
  };

  const yes = (id: QuestionId) => Number(get(id)?.value ?? 0);

  const reading = {
    intent: choiceOf("intent", get("intent")),
    readiness: scored("readiness"),
    isQuestion: yes("isQuestion"),
    recurring: yes("recurring"),
    urgency: scored("urgency"),
    tone: choiceOf("tone", get("tone")),
    eventMode: choiceOf("eventMode", get("eventMode")),
    transport: choiceOf("transport", get("transport")),
    tripType: choiceOf("tripType", get("tripType")),
    expenseCategory: choiceOf("expenseCategory", get("expenseCategory")),
    colorMood: choiceOf("colorMood", get("colorMood")),
    timerKind: choiceOf("timerKind", get("timerKind")),
    hasExplicitOptions: yes("hasExplicitOptions"),
    isShoppingList: yes("isShoppingList"),
  };

  // SAFETY: choiceOf checked every choice value against its question's options above.
  return { reading: reading as Reading, dropped };
}
